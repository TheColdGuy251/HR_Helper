-- Перенос данных из прежней схемы (целочисленные ключи, SQLAlchemy) в новую
-- (UUIDv7, Prisma Migrate). Одноразовый скрипт. Порядок:
--
--   1. Восстановить старую базу и убрать её в схему legacy:
--        pg_restore -d hr_helper --no-owner old.dump
--        psql -d hr_helper -c "ALTER SCHEMA public RENAME TO legacy; CREATE SCHEMA public;"
--   2. Создать новую схему:      npx prisma migrate deploy
--   3. Перенести данные:         psql -d hr_helper -f scripts/migrate-legacy-db.sql
--   4. Перевести Qdrant:         node scripts/migrate-legacy-qdrant.mjs
--   5. Убрать старую схему:      psql -d hr_helper -c "DROP SCHEMA legacy CASCADE"
--
-- Новые id — UUIDv7 с меткой времени из created_at старой строки: сортировка
-- по id по-прежнему совпадает с хронологией (код на это опирается). Строки с
-- одинаковым временем упорядочены по старому id (12 бит счётчика в UUID).
-- Таблицы соответствия старых и новых id остаются в legacy.map_* — по ним
-- шаг 4 переводит Qdrant.

\set ON_ERROR_STOP on
BEGIN;

-- ── Вспомогательные функции ─────────────────────────────────────────────────

-- UUIDv7 для заданного момента: 48 бит миллисекунд, версия 7 + 12 бит seq,
-- затем вариант и 62 случайных бита (из gen_random_uuid(), у которого биты
-- варианта уже выставлены).
CREATE FUNCTION pg_temp.uuid7_at(ts timestamptz, seq bigint) RETURNS uuid
LANGUAGE sql VOLATILE AS $$
  SELECT encode(
           substring(int8send(floor(extract(epoch FROM ts) * 1000)::bigint) FROM 3)
           || set_byte(set_byte('\x0000'::bytea, 0, (112 + ((seq >> 8) & 15))::int), 1, (seq & 255)::int)
           || substring(uuid_send(gen_random_uuid()) FROM 9),
         'hex')::uuid
$$;

-- Ссылки вида /kb/documents/12/view внутри текста → те же ссылки с новым id.
-- Порядок префиксов важен: «/documents/» (документы пользователя) не должен
-- цеплять «/kb/documents/», а «/news/» — «/api/news/» и «/news/media/».
CREATE FUNCTION pg_temp.map_urls(t text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  r record;
  old text;
  nid uuid;
BEGIN
  IF t IS NULL OR t !~ '/[0-9]' THEN
    RETURN t;
  END IF;
  FOR r IN SELECT * FROM (VALUES
      ('/kb/documents/', 'kb_documents'), ('/kb-document/', 'kb_documents'),
      ('/kb/templates/', 'doc_templates'), ('/kb-template/', 'doc_templates'),
      ('/news/media/', 'news_media'), ('/news-media/', 'news_media'),
      ('/messenger/files/', 'user_message_files'), ('/messenger-file/', 'user_message_files'),
      ('/api/documents/', 'my_documents'), ('/view/document/', 'my_documents'),
      ('(?<![a-z])/documents/', 'my_documents'),
      ('(?<![a-z/])/news/', 'news_posts'), ('/api/news/', 'news_posts')
    ) AS p(prefix, tbl)
  LOOP
    FOR old IN SELECT DISTINCT (regexp_matches(t, r.prefix || '([0-9]+)(?![0-9])', 'g'))[1] LOOP
      EXECUTE format('SELECT new_id FROM legacy.%I WHERE old_id = $1', 'map_' || r.tbl)
        INTO nid USING old::bigint;
      IF nid IS NOT NULL THEN
        t := regexp_replace(t, '(' || r.prefix || ')' || old || '(?![0-9])', '\1' || nid::text, 'g');
      END IF;
    END LOOP;
  END LOOP;
  RETURN t;
END $$;

-- JSON-снимки: числовые document_id / faq_id / media_id → новые UUID,
-- ссылки в строках — через map_urls. JSON null → SQL NULL.
CREATE FUNCTION pg_temp.map_json(j jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  k text;
  v jsonb;
  res jsonb;
  nid uuid;
BEGIN
  IF j IS NULL OR j = 'null'::jsonb THEN
    RETURN NULL;
  END IF;
  CASE jsonb_typeof(j)
    WHEN 'object' THEN
      res := '{}'::jsonb;
      FOR k, v IN SELECT * FROM jsonb_each(j) LOOP
        IF jsonb_typeof(v) = 'number' AND k IN ('document_id', 'faq_id', 'media_id') THEN
          nid := CASE k
            WHEN 'document_id' THEN (SELECT new_id FROM legacy.map_kb_documents WHERE old_id = (v #>> '{}')::numeric::bigint)
            WHEN 'faq_id' THEN (SELECT new_id FROM legacy.map_faq_entries WHERE old_id = (v #>> '{}')::numeric::bigint)
            WHEN 'media_id' THEN (SELECT new_id FROM legacy.map_news_media WHERE old_id = (v #>> '{}')::numeric::bigint)
          END;
          res := res || jsonb_build_object(k, nid);
        ELSE
          res := res || jsonb_build_object(k, coalesce(pg_temp.map_json(v), 'null'::jsonb));
        END IF;
      END LOOP;
      RETURN res;
    WHEN 'array' THEN
      SELECT coalesce(jsonb_agg(coalesce(pg_temp.map_json(e), 'null'::jsonb) ORDER BY ord), '[]'::jsonb)
        INTO res
        FROM jsonb_array_elements(j) WITH ORDINALITY AS a(e, ord);
      RETURN res;
    WHEN 'string' THEN
      RETURN to_jsonb(pg_temp.map_urls(j #>> '{}'));
    ELSE
      RETURN j;
  END CASE;
END $$;

-- ── Таблицы соответствия id ─────────────────────────────────────────────────

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('users', 'created_at'), ('push_subscriptions', 'created_at'),
      ('dialogues', 'created_at'), ('chat_messages', 'created_at'),
      ('session_documents', 'created_at'),
      ('template_categories', 'created_at'), ('doc_templates', 'created_at'),
      ('my_documents', 'created_at'),
      ('kb_documents', 'created_at'), ('kb_links', 'created_at'), ('kb_sources', 'created_at'),
      ('faq_entries', 'created_at'),
      ('user_messages', 'created_at'), ('user_message_files', 'created_at'),
      ('polls', 'created_at'), ('poll_options', NULL),
      ('news_polls', 'created_at'), ('news_poll_options', NULL),
      ('news_posts', 'created_at'), ('news_media', 'created_at'),
      ('notifications', 'created_at'),
      ('pii_persons', 'created_at'), ('pii_documents', 'uploaded_at'), ('pii_audit', 'at')
    ) AS t(tbl, ts)
  LOOP
    EXECUTE format(
      'CREATE TABLE legacy.%1$I AS
         SELECT id AS old_id,
                pg_temp.uuid7_at(%3$s,
                  (row_number() OVER (PARTITION BY date_trunc(''milliseconds'', %3$s) ORDER BY id) - 1) %% 4096) AS new_id
         FROM legacy.%2$I;
       ALTER TABLE legacy.%1$I ADD PRIMARY KEY (old_id);',
      'map_' || r.tbl, r.tbl,
      coalesce(quote_ident(r.ts) || ' AT TIME ZONE ''UTC''', 'now()'));
  END LOOP;
END $$;

-- Группы FAQ раньше существовали только как значение group_key.
CREATE TABLE legacy.map_faq_groups AS
  SELECT group_key AS old_key,
         pg_temp.uuid7_at(min(created_at) AT TIME ZONE 'UTC', (row_number() OVER (ORDER BY min(id)) - 1) % 4096) AS new_id
  FROM legacy.faq_entries
  GROUP BY group_key;
ALTER TABLE legacy.map_faq_groups ADD PRIMARY KEY (old_key);

-- Ключ группы вариантов ответа — id первого варианта. Если тот удалён,
-- группа всё равно должна остаться общей: даём ей свой новый UUID.
CREATE TEMP TABLE m_variant AS
  SELECT g.old_group, coalesce(mc.new_id, pg_temp.uuid7_at(now(), 0)) AS new_id
  FROM (SELECT DISTINCT variant_group AS old_group FROM legacy.chat_messages WHERE variant_group IS NOT NULL) g
  LEFT JOIN legacy.map_chat_messages mc ON mc.old_id = g.old_group;

-- Объект журнала ПДн мог быть удалён — тогда связываем записи об одном и том
-- же объекте общим новым UUID.
CREATE TEMP TABLE m_pii_entity AS
  SELECT e.entity, e.old_id,
         coalesce(CASE e.entity
                    WHEN 'person' THEN (SELECT new_id FROM legacy.map_pii_persons WHERE old_id = e.old_id)
                    WHEN 'document' THEN (SELECT new_id FROM legacy.map_pii_documents WHERE old_id = e.old_id)
                  END,
                  pg_temp.uuid7_at(now(), 0)) AS new_id
  FROM (SELECT DISTINCT entity, entity_id AS old_id
        FROM legacy.pii_audit
        WHERE entity IN ('person', 'document') AND entity_id IS NOT NULL) e;

-- ── Пользователи ────────────────────────────────────────────────────────────

INSERT INTO public.users (id, username, email, password_hash, surname, name, patronymic, position, sex,
                          is_active, is_admin, is_kb_editor, can_access_pii, created_at)
SELECT m.new_id, u.username, u.email, u.password_hash, u.surname, u.name, u.patronymic, u.position,
       CASE
         WHEN lower(btrim(u.sex)) IN ('male', 'm', 'мужской', 'м') THEN 'male'
         WHEN lower(btrim(u.sex)) IN ('female', 'f', 'женский', 'ж') THEN 'female'
       END::user_sex,
       u.is_active, u.is_admin, u.is_kb_editor, u.can_access_pii, u.created_at AT TIME ZONE 'UTC'
FROM legacy.users u
JOIN legacy.map_users m ON m.old_id = u.id;

INSERT INTO public.push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at)
SELECT m.new_id, mu.new_id, s.endpoint, s.p256dh, s.auth, s.user_agent, s.created_at AT TIME ZONE 'UTC'
FROM legacy.push_subscriptions s
JOIN legacy.map_push_subscriptions m ON m.old_id = s.id
JOIN legacy.map_users mu ON mu.old_id = s.user_id;

-- ── Шаблоны и документы ─────────────────────────────────────────────────────

INSERT INTO public.template_categories (id, slug, name, description, icon, sort_order, created_at)
SELECT m.new_id, c.slug, c.name, c.description, c.icon, c.sort_order, c.created_at AT TIME ZONE 'UTC'
FROM legacy.template_categories c
JOIN legacy.map_template_categories m ON m.old_id = c.id;

-- Шаблон по умолчанию: была ссылка из категории, стал флаг на шаблоне
-- (и только если шаблон действительно лежит в этой категории).
INSERT INTO public.doc_templates (id, key, title, description, file_path, fields_schema, extraction_prompt,
                                  is_enabled, category_id, is_default, created_at)
SELECT m.new_id, t.key, t.title, t.description, t.file_path, NULLIF(t.fields_schema::jsonb, 'null'),
       t.extraction_prompt, t.is_enabled, mc.new_id,
       EXISTS (SELECT 1 FROM legacy.template_categories c
               WHERE c.default_template_id = t.id AND c.id = t.category_id),
       t.created_at AT TIME ZONE 'UTC'
FROM legacy.doc_templates t
JOIN legacy.map_doc_templates m ON m.old_id = t.id
LEFT JOIN legacy.map_template_categories mc ON mc.old_id = t.category_id;

-- template_key был то ключом шаблона из БД, то именем встроенного генератора.
INSERT INTO public.my_documents (id, user_id, title, generator, template_id, file_path, progress, status,
                                 fields, is_pii, created_at, last_activity)
SELECT m.new_id, mu.new_id, d.title,
       CASE
         WHEN t.id IS NOT NULL THEN 'template'
         WHEN d.template_key IN ('vacancy', 'pps_announcement', 'ot_dedup', 'employee_certificate', 'dpo_report',
                                 'dismissed_inventory', 'process_schema', 'characteristic') THEN d.template_key
         ELSE 'template'
       END::document_generator,
       mt.new_id, d.file_path, least(greatest(d.progress, 0), 100),
       CASE WHEN d.status IN ('draft', 'ready', 'exported') THEN d.status ELSE 'ready' END::document_status,
       CASE WHEN d.fields::text = 'null' THEN NULL ELSE d.fields END,
       d.is_pii, d.created_at AT TIME ZONE 'UTC', d.last_activity AT TIME ZONE 'UTC'
FROM legacy.my_documents d
JOIN legacy.map_my_documents m ON m.old_id = d.id
JOIN legacy.map_users mu ON mu.old_id = d.user_id
LEFT JOIN legacy.doc_templates t ON t.key = d.template_key
LEFT JOIN legacy.map_doc_templates mt ON mt.old_id = t.id;

-- ── База знаний ─────────────────────────────────────────────────────────────

INSERT INTO public.kb_documents (id, title, source_type, source_uri, file_hash, mime_type, status, priority,
                                 document_kind, issuer, effective_from, effective_to, is_archived, chunks_count,
                                 content, extra, error, created_at, indexed_at)
SELECT m.new_id, d.title,
       CASE WHEN d.source_type IN ('local', 'web', 'upload') THEN d.source_type ELSE 'local' END::kb_source_type,
       d.source_uri, d.file_hash, d.mime_type,
       CASE WHEN d.status IN ('pending', 'parsing', 'indexed', 'failed') THEN d.status ELSE 'failed' END::kb_status,
       least(greatest(d.priority, 1), 3),
       CASE WHEN d.document_kind IN ('code', 'law', 'regulation', 'order', 'manual', 'other')
            THEN d.document_kind END::kb_document_kind,
       d.issuer, d.effective_from, d.effective_to, d.is_archived, d.chunks_count, d.content,
       NULLIF(d.extra::jsonb, 'null'), d.error, d.created_at AT TIME ZONE 'UTC', d.indexed_at AT TIME ZONE 'UTC'
FROM legacy.kb_documents d
JOIN legacy.map_kb_documents m ON m.old_id = d.id;

INSERT INTO public.kb_document_tags (document_id, tag)
SELECT DISTINCT m.new_id, btrim(t.tag)
FROM legacy.kb_documents d
JOIN legacy.map_kb_documents m ON m.old_id = d.id
CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE WHEN jsonb_typeof(d.tags::jsonb) = 'array' THEN d.tags::jsonb ELSE '[]'::jsonb END) AS t(tag)
WHERE btrim(t.tag) <> '';

INSERT INTO public.kb_links (id, from_doc_id, from_chunk_index, target_kind, target_number, target_doc_hint,
                             created_at)
SELECT m.new_id, md.new_id, l.from_chunk_index,
       CASE WHEN l.target_kind IN ('article', 'chapter', 'clause', 'section')
            THEN l.target_kind ELSE 'article' END::kb_link_target,
       l.target_number, l.target_doc_hint, l.created_at AT TIME ZONE 'UTC'
FROM legacy.kb_links l
JOIN legacy.map_kb_links m ON m.old_id = l.id
JOIN legacy.map_kb_documents md ON md.old_id = l.from_doc_id;

-- last_status хранил то «ok», то текст ошибки — разносим по двум колонкам.
INSERT INTO public.kb_sources (id, name, url, is_enabled, refresh_interval_hours, priority, last_crawled_at,
                               last_status, last_error, created_at)
SELECT m.new_id, s.name, s.url, s.is_enabled, greatest(s.refresh_interval_hours, 1),
       least(greatest(s.priority, 1), 3), s.last_crawled_at AT TIME ZONE 'UTC',
       CASE WHEN s.last_status IS NULL THEN NULL WHEN s.last_status = 'ok' THEN 'ok' ELSE 'error' END::crawl_status,
       CASE WHEN s.last_status <> 'ok' THEN s.last_status END,
       s.created_at AT TIME ZONE 'UTC'
FROM legacy.kb_sources s
JOIN legacy.map_kb_sources m ON m.old_id = s.id;

-- FAQ: атрибуты группы (block, source_file, clarify_question) — в faq_groups.
INSERT INTO public.faq_groups (id, key, block, source_file, clarify_question, created_at)
SELECT g.new_id, g.old_key,
       (SELECT e.block FROM legacy.faq_entries e
        WHERE e.group_key = g.old_key ORDER BY e.position, e.id LIMIT 1),
       (SELECT e.source_file FROM legacy.faq_entries e
        WHERE e.group_key = g.old_key AND e.source_file IS NOT NULL ORDER BY e.position, e.id LIMIT 1),
       (SELECT e.clarify_question FROM legacy.faq_entries e
        WHERE e.group_key = g.old_key AND e.clarify_question IS NOT NULL ORDER BY e.position, e.id LIMIT 1),
       (SELECT min(e.created_at) FROM legacy.faq_entries e WHERE e.group_key = g.old_key) AT TIME ZONE 'UTC'
FROM legacy.map_faq_groups g;

INSERT INTO public.faq_entries (id, group_id, position, variants, option_label, answer, doc_refs, contact,
                                is_active, created_at, updated_at)
SELECT m.new_id, g.new_id, e.position, NULLIF(e.variants::jsonb, 'null'), e.option_label, e.answer,
       NULLIF(e.doc_refs::jsonb, 'null'), e.contact, e.is_active,
       e.created_at AT TIME ZONE 'UTC', e.updated_at AT TIME ZONE 'UTC'
FROM legacy.faq_entries e
JOIN legacy.map_faq_entries m ON m.old_id = e.id
JOIN legacy.map_faq_groups g ON g.old_key = e.group_key;

-- ── Новости ─────────────────────────────────────────────────────────────────

INSERT INTO public.news_posts (id, title, body_html, author_id, is_published, is_pinned, created_at, updated_at)
SELECT m.new_id, p.title, pg_temp.map_urls(p.body_html), ma.new_id, p.is_published, p.is_pinned,
       p.created_at AT TIME ZONE 'UTC', p.updated_at AT TIME ZONE 'UTC'
FROM legacy.news_posts p
JOIN legacy.map_news_posts m ON m.old_id = p.id
LEFT JOIN legacy.map_users ma ON ma.old_id = p.author_id;

-- Список вложений поста (news_posts.attachments) → порядковый номер у самого файла.
INSERT INTO public.news_media (id, post_id, attachment_order, original_name, stored_path, mime_type, size,
                               is_image, uploaded_by, created_at)
SELECT m.new_id, mp.new_id,
       (SELECT min(a.ord) - 1
        FROM legacy.news_posts p
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(p.attachments::jsonb) = 'array' THEN p.attachments::jsonb ELSE '[]'::jsonb END)
          WITH ORDINALITY AS a(e, ord)
        WHERE p.id = n.post_id AND a.e ->> 'media_id' = n.id::text),
       n.original_name, n.stored_path, n.mime_type, n.size, n.is_image, mu.new_id,
       n.created_at AT TIME ZONE 'UTC'
FROM legacy.news_media n
JOIN legacy.map_news_media m ON m.old_id = n.id
LEFT JOIN legacy.map_news_posts mp ON mp.old_id = n.post_id
LEFT JOIN legacy.map_users mu ON mu.old_id = n.uploaded_by;

-- ── Мессенджер ──────────────────────────────────────────────────────────────

INSERT INTO public.user_messages (id, sender_id, recipient_id, is_general, content, forwarded_meta, is_pinned,
                                  is_edited, is_ai_query, created_at)
SELECT m.new_id, ms.new_id, mr.new_id, u.is_general, u.content, pg_temp.map_json(u.forwarded_meta::jsonb),
       u.is_pinned, u.is_edited, u.is_ai_query, u.created_at AT TIME ZONE 'UTC'
FROM legacy.user_messages u
JOIN legacy.map_user_messages m ON m.old_id = u.id
JOIN legacy.map_users ms ON ms.old_id = u.sender_id
LEFT JOIN legacy.map_users mr ON mr.old_id = u.recipient_id;

UPDATE public.user_messages t
SET reply_to_id = mr.new_id
FROM legacy.user_messages u
JOIN legacy.map_user_messages m ON m.old_id = u.id
JOIN legacy.map_user_messages mr ON mr.old_id = u.reply_to_id
WHERE t.id = m.new_id;

-- hidden_for: JSON-список id → строки user_message_hidden.
INSERT INTO public.user_message_hidden (message_id, user_id)
SELECT DISTINCT m.new_id, mu.new_id
FROM legacy.user_messages u
JOIN legacy.map_user_messages m ON m.old_id = u.id
CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE WHEN jsonb_typeof(u.hidden_for::jsonb) = 'array' THEN u.hidden_for::jsonb ELSE '[]'::jsonb END) AS h(uid)
JOIN legacy.map_users mu ON mu.old_id = CASE WHEN h.uid ~ '^[0-9]+$' THEN h.uid::bigint END;

INSERT INTO public.user_message_files (id, message_id, owner_id, original_name, stored_path, content_type,
                                       size_bytes, is_image, img_w, img_h, created_at)
SELECT m.new_id, mm.new_id, mo.new_id, f.original_name, f.stored_path, f.content_type, f.size_bytes, f.is_image,
       f.img_w, f.img_h, f.created_at AT TIME ZONE 'UTC'
FROM legacy.user_message_files f
JOIN legacy.map_user_message_files m ON m.old_id = f.id
JOIN legacy.map_users mo ON mo.old_id = f.owner_id
LEFT JOIN legacy.map_user_messages mm ON mm.old_id = f.message_id;

-- Реакция одна на пользователя: при дублях остаётся последняя.
INSERT INTO public.user_message_reactions (message_id, user_id, emoji, created_at)
SELECT DISTINCT ON (r.message_id, r.user_id) mm.new_id, mu.new_id, r.emoji, r.created_at AT TIME ZONE 'UTC'
FROM legacy.user_message_reactions r
JOIN legacy.map_user_messages mm ON mm.old_id = r.message_id
JOIN legacy.map_users mu ON mu.old_id = r.user_id
ORDER BY r.message_id, r.user_id, r.id DESC;

-- peer_key: «general» → NULL, id собеседника → его новый UUID. Отметки о
-- диалогах с удалёнными пользователями не переносим — собеседника нет.
-- last_read_id — «водяной знак»: берём ближайшее существующее сообщение не
-- новее прежнего значения (порядок UUIDv7 совпадает с порядком старых id).
INSERT INTO public.messenger_reads (user_id, peer_user_id, last_read_id, last_read_at)
SELECT DISTINCT ON (mu.new_id, mp.new_id)
       mu.new_id, mp.new_id,
       (SELECT mm.new_id FROM legacy.user_messages x
        JOIN legacy.map_user_messages mm ON mm.old_id = x.id
        WHERE x.id <= r.last_read_id ORDER BY x.id DESC LIMIT 1),
       r.last_read_at AT TIME ZONE 'UTC'
FROM legacy.messenger_reads r
JOIN legacy.map_users mu ON mu.old_id = r.user_id
LEFT JOIN legacy.map_users mp ON mp.old_id = CASE WHEN r.peer_key ~ '^[0-9]+$' THEN r.peer_key::bigint END
WHERE r.peer_key = 'general' OR mp.new_id IS NOT NULL
ORDER BY mu.new_id, mp.new_id, r.last_read_id DESC, r.last_read_at DESC NULLS LAST;

-- ── Опросы: мессенджер и новости в общих таблицах ───────────────────────────

INSERT INTO public.polls (id, message_id, question, description, allow_multiple, show_voters, allow_change,
                          allow_bot, created_at)
SELECT DISTINCT ON (p.message_id) m.new_id, mm.new_id, p.question, p.description, p.allow_multiple,
       p.show_voters, p.allow_change, p.allow_bot, p.created_at AT TIME ZONE 'UTC'
FROM legacy.polls p
JOIN legacy.map_polls m ON m.old_id = p.id
JOIN legacy.map_user_messages mm ON mm.old_id = p.message_id
ORDER BY p.message_id, p.id;

-- В новостях голос всегда можно снять, а ассистент не голосует.
INSERT INTO public.polls (id, post_id, question, description, allow_multiple, show_voters, allow_change,
                          allow_bot, created_at)
SELECT DISTINCT ON (p.post_id) m.new_id, mp.new_id, p.question, p.description, p.allow_multiple,
       p.show_voters, true, false, p.created_at AT TIME ZONE 'UTC'
FROM legacy.news_polls p
JOIN legacy.map_news_polls m ON m.old_id = p.id
JOIN legacy.map_news_posts mp ON mp.old_id = p.post_id
ORDER BY p.post_id, p.id;

INSERT INTO public.poll_options (id, poll_id, text, position)
SELECT m.new_id, mp.new_id, o.text, o.position
FROM legacy.poll_options o
JOIN legacy.map_poll_options m ON m.old_id = o.id
JOIN legacy.map_polls mp ON mp.old_id = o.poll_id
WHERE EXISTS (SELECT 1 FROM public.polls x WHERE x.id = mp.new_id)
UNION ALL
SELECT m.new_id, mp.new_id, o.text, o.position
FROM legacy.news_poll_options o
JOIN legacy.map_news_poll_options m ON m.old_id = o.id
JOIN legacy.map_news_polls mp ON mp.old_id = o.poll_id
WHERE EXISTS (SELECT 1 FROM public.polls x WHERE x.id = mp.new_id);

-- Опрос голоса теперь определяется вариантом (poll_id был избыточен).
INSERT INTO public.poll_votes (option_id, user_id, created_at)
SELECT DISTINCT ON (v.option_id, v.user_id) v.option_id, v.user_id, v.created_at
FROM (
  SELECT mo.new_id AS option_id, mu.new_id AS user_id, pv.created_at AT TIME ZONE 'UTC' AS created_at, pv.id AS old_id
  FROM legacy.poll_votes pv
  JOIN legacy.map_poll_options mo ON mo.old_id = pv.option_id
  JOIN legacy.map_users mu ON mu.old_id = pv.user_id
  UNION ALL
  SELECT mo.new_id, mu.new_id, nv.created_at AT TIME ZONE 'UTC', nv.id
  FROM legacy.news_poll_votes nv
  JOIN legacy.map_news_poll_options mo ON mo.old_id = nv.option_id
  JOIN legacy.map_users mu ON mu.old_id = nv.user_id
) v
WHERE EXISTS (SELECT 1 FROM public.poll_options x WHERE x.id = v.option_id)
ORDER BY v.option_id, v.user_id, v.old_id;

-- ── Ассистент ───────────────────────────────────────────────────────────────

-- chat_sessions вливается в dialogues: сообщения и вложения ссылаются на диалог.
INSERT INTO public.dialogues (id, user_id, title, description, is_finished, memory_summary, memory_covers_up_to,
                              draft, pending_forward, created_at, last_activity)
SELECT m.new_id, mu.new_id, d.title, d.description, d.is_finished, d.memory_summary,
       (SELECT mc.new_id FROM legacy.chat_messages cm
        JOIN legacy.chat_sessions cs ON cs.id = cm.session_id
        JOIN legacy.map_chat_messages mc ON mc.old_id = cm.id
        WHERE cs.dialogue_id = d.id AND cm.id <= d.memory_covers_up_to
        ORDER BY cm.id DESC LIMIT 1),
       d.draft, pg_temp.map_json(d.pending_forward::jsonb), d.created_at AT TIME ZONE 'UTC',
       greatest(d.last_activity,
                (SELECT max(cs.last_activity) FROM legacy.chat_sessions cs WHERE cs.dialogue_id = d.id))
         AT TIME ZONE 'UTC'
FROM legacy.dialogues d
JOIN legacy.map_dialogues m ON m.old_id = d.id
JOIN legacy.map_users mu ON mu.old_id = d.user_id;

INSERT INTO public.chat_messages (id, dialogue_id, role, content, is_read, is_finished, is_cancelled, sources,
                                  subqueries, fact_check, attachment_document_id, meta, forwarded_meta, last_seq,
                                  created_at, finished_at, variant_group, variant_active)
SELECT mc.new_id, md.new_id, c.role::chat_role, c.content, c.is_read, c.is_finished, c.is_cancelled,
       pg_temp.map_json(c.sources::jsonb), NULLIF(c.subqueries::jsonb, 'null'), NULLIF(c.fact_check::jsonb, 'null'),
       mdoc.new_id, pg_temp.map_json(c.meta::jsonb), pg_temp.map_json(c.forwarded_meta::jsonb), c.last_seq,
       c.created_at AT TIME ZONE 'UTC', c.finished_at AT TIME ZONE 'UTC', mv.new_id, c.variant_active
FROM legacy.chat_messages c
JOIN legacy.map_chat_messages mc ON mc.old_id = c.id
JOIN legacy.chat_sessions s ON s.id = c.session_id
JOIN legacy.map_dialogues md ON md.old_id = s.dialogue_id
LEFT JOIN legacy.map_my_documents mdoc ON mdoc.old_id = c.attachment_document_id
LEFT JOIN m_variant mv ON mv.old_group = c.variant_group;

UPDATE public.chat_messages t
SET reply_to = r.new_id, branch_of = b.new_id
FROM legacy.chat_messages c
JOIN legacy.map_chat_messages mc ON mc.old_id = c.id
LEFT JOIN legacy.map_chat_messages r ON r.old_id = c.reply_to
LEFT JOIN legacy.map_chat_messages b ON b.old_id = c.branch_of
WHERE t.id = mc.new_id AND (c.reply_to IS NOT NULL OR c.branch_of IS NOT NULL);

-- Оценку ставит владелец диалога — по одной на сообщение.
INSERT INTO public.chat_feedback (message_id, rating, comment, created_at)
SELECT DISTINCT ON (f.message_id) mc.new_id, f.rating, f.comment, f.created_at AT TIME ZONE 'UTC'
FROM legacy.chat_feedback f
JOIN legacy.map_chat_messages mc ON mc.old_id = f.message_id
JOIN legacy.chat_messages c ON c.id = f.message_id
JOIN legacy.chat_sessions s ON s.id = c.session_id
JOIN legacy.dialogues d ON d.id = s.dialogue_id
WHERE f.rating IN (-1, 1)
ORDER BY f.message_id, (f.user_id = d.user_id) IS TRUE DESC, f.created_at DESC, f.id DESC;

-- session_documents → chat_attachments. Привязка к сообщению другой сессии
-- (её не должно было быть) сбрасывается — это запрещает составной ключ.
INSERT INTO public.chat_attachments (id, dialogue_id, message_id, filename, mime_type, size_bytes, stored_path,
                                     content, created_at)
SELECT m.new_id, md.new_id, CASE WHEN c.session_id = sd.session_id THEN mc.new_id END,
       sd.filename, sd.mime_type, sd.size_bytes, sd.stored_path, sd.content, sd.created_at AT TIME ZONE 'UTC'
FROM legacy.session_documents sd
JOIN legacy.map_session_documents m ON m.old_id = sd.id
JOIN legacy.chat_sessions s ON s.id = sd.session_id
JOIN legacy.map_dialogues md ON md.old_id = s.dialogue_id
LEFT JOIN legacy.chat_messages c ON c.id = sd.message_id
LEFT JOIN legacy.map_chat_messages mc ON mc.old_id = sd.message_id;

-- ── Уведомления ─────────────────────────────────────────────────────────────

-- Адресные уведомления удалённых пользователей не переносим: адресата нет.
INSERT INTO public.notifications (id, kind, user_id, title, body, document_id, extra, created_at)
SELECT m.new_id, n.kind::notification_kind, mu.new_id, n.title, n.body, md.new_id,
       pg_temp.map_json(n.extra::jsonb), n.created_at AT TIME ZONE 'UTC'
FROM legacy.notifications n
JOIN legacy.map_notifications m ON m.old_id = n.id
LEFT JOIN legacy.map_users mu ON mu.old_id = n.user_id
LEFT JOIN legacy.map_kb_documents md ON md.old_id = n.document_id
WHERE n.kind IN ('web_update', 'doc_expired', 'doc_stale', 'pii_autodeleted')
  AND (n.user_id IS NULL OR mu.new_id IS NOT NULL);

INSERT INTO public.notification_reads (notification_id, user_id, read_at)
SELECT DISTINCT ON (r.notification_id, r.user_id) mn.new_id, mu.new_id, r.read_at AT TIME ZONE 'UTC'
FROM legacy.notification_reads r
JOIN legacy.map_notifications mn ON mn.old_id = r.notification_id
JOIN legacy.map_users mu ON mu.old_id = r.user_id
WHERE EXISTS (SELECT 1 FROM public.notifications x WHERE x.id = mn.new_id)
ORDER BY r.notification_id, r.user_id, r.read_at;

-- ── Персональные данные ─────────────────────────────────────────────────────

INSERT INTO public.pii_persons (id, surname, name, patronymic, birth_date, meta, created_at, updated_at)
SELECT m.new_id, p.surname, p.name, p.patronymic, p.birth_date,
       CASE WHEN p.meta::text = 'null' THEN NULL ELSE p.meta END,
       p.created_at AT TIME ZONE 'UTC', p.updated_at AT TIME ZONE 'UTC'
FROM legacy.pii_persons p
JOIN legacy.map_pii_persons m ON m.old_id = p.id;

INSERT INTO public.pii_documents (id, person_id, original_filename, storage_filename, mime_type, size_bytes,
                                  note, uploaded_by, uploaded_at)
SELECT m.new_id, mp.new_id, d.original_filename, d.storage_filename, d.mime_type, d.size_bytes, d.note,
       mu.new_id, d.uploaded_at AT TIME ZONE 'UTC'
FROM legacy.pii_documents d
JOIN legacy.map_pii_documents m ON m.old_id = d.id
JOIN legacy.map_pii_persons mp ON mp.old_id = d.person_id
LEFT JOIN legacy.map_users mu ON mu.old_id = d.uploaded_by;

INSERT INTO public.pii_audit (id, user_id, action, entity, entity_id, extra, at)
SELECT m.new_id, mu.new_id, a.action::pii_action,
       CASE WHEN a.entity IN ('person', 'document') THEN a.entity END::pii_entity,
       pe.new_id, NULLIF(a.extra::jsonb, 'null'), a.at AT TIME ZONE 'UTC'
FROM legacy.pii_audit a
JOIN legacy.map_pii_audit m ON m.old_id = a.id
LEFT JOIN legacy.map_users mu ON mu.old_id = a.user_id
LEFT JOIN m_pii_entity pe ON pe.entity = a.entity AND pe.old_id = a.entity_id
WHERE a.action IN ('create_person', 'view_person', 'delete_person', 'import_1c', 'upload', 'download',
                   'delete', 'quick_analyze', 'reauth_ok', 'reauth_fail');

-- ── Служебное состояние ─────────────────────────────────────────────────────

INSERT INTO public.app_state (key, value, updated_at)
SELECT key, value, updated_at FROM legacy.app_state;

-- ── Сверка количества строк ─────────────────────────────────────────────────

DO $$
DECLARE
  r record;
  a bigint;
  b bigint;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('users', 'users'), ('push_subscriptions', 'push_subscriptions'),
      ('dialogues', 'dialogues'), ('chat_messages', 'chat_messages'),
      ('chat_feedback', 'chat_feedback'), ('session_documents', 'chat_attachments'),
      ('template_categories', 'template_categories'), ('doc_templates', 'doc_templates'),
      ('my_documents', 'my_documents'), ('kb_documents', 'kb_documents'), ('kb_links', 'kb_links'),
      ('kb_sources', 'kb_sources'), ('faq_entries', 'faq_entries'),
      ('user_messages', 'user_messages'), ('user_message_files', 'user_message_files'),
      ('user_message_reactions', 'user_message_reactions'), ('messenger_reads', 'messenger_reads'),
      ('news_posts', 'news_posts'), ('news_media', 'news_media'),
      ('notifications', 'notifications'), ('notification_reads', 'notification_reads'),
      ('pii_persons', 'pii_persons'), ('pii_documents', 'pii_documents'), ('pii_audit', 'pii_audit')
    ) AS t(old_tbl, new_tbl)
  LOOP
    EXECUTE format('SELECT count(*) FROM legacy.%I', r.old_tbl) INTO a;
    EXECUTE format('SELECT count(*) FROM public.%I', r.new_tbl) INTO b;
    RAISE NOTICE '% % → % %', rpad(r.new_tbl, 24), a, b, CASE WHEN a = b THEN '' ELSE '(отличается)' END;
  END LOOP;
END $$;

COMMIT;

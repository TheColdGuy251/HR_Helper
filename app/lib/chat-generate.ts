import 'server-only';
import { Prisma } from '@prisma/client';
import { prisma } from './db';
import { compareIds } from './ids';
import { asList } from './kb';
import { persistAndFinish, type StreamState } from './chat';
import { answerStream, ensureInlineCitations, postProcessAnswer, type AttachedDoc } from './ml/pipeline';
import { QueueRejected } from './ml/llm';
import { selfCheck, summarizeHistory } from './ml/advanced';
import { resolveDocRefs } from './ml/blank-forms';
import { RAG } from './ml/config';
import { correctTypos } from './ml/spellfix';
import { resolveIntent, type Intent } from './ml/intent';
import { CHARACTERISTIC_REQUEST_RE } from './docs/characteristic';
import { DPO_REQUEST_RE } from './docs/dpo-report';
import { VACANCY_REQUEST_RE } from './docs/vacancy';
import {
  handleCharacteristic,
  handleDpoReport,
  handleToolRequest,
  handleVacancy,
  maybeToolHint,
  type ToolCtx,
} from './docs/chat-tools';
import {
  applyCorrection,
  continueDocgen,
  getLastDocgen,
  getPending,
  handleDocumentGeneration,
  loadDocgenState,
  type DocgenCtx,
} from './docs/docgen';
import {
  detectTemplate,
  extractFields,
  looksImperativeDocCommand,
  looksLikeDocRequest,
  matchTemplateByTitle,
  wantsCancel,
  wantsCorrection,
  wantsForceGenerate,
  type FieldValues,
} from './docs/intent';

// persistAndFinish живёт в lib/chat.ts (им пользуются и ветки инструментов), но
// исторически импортировался отсюда - сохраняем реэкспорт.
export { persistAndFinish };

// Фоновая генерация ответа ассистента.
//
// Вынесено из app/api/chat/stream/route.ts: тот же код запускают и /stream
// (первичная отправка, "повторить"), и /edit (правка вопроса -> новая ветка).

// Тексты отказа очереди. В lib/ml/llm.ts формулировки свои, поэтому
// сопоставляем по причине.
export const QUEUE_REJECT_TEXT: Record<string, string> = {
  queue_full:
    'Сервис ассистента сейчас перегружен — слишком много запросов в очереди. ' +
    'Пожалуйста, попробуйте через минуту.',
  per_user_limit:
    'У вас уже несколько запросов в обработке. Дождитесь ответа ' +
    'на предыдущие, прежде чем отправлять новый.',
};

// ---------------------------------------------------------------------------
// Быстрый набор FAQ: детерминированный ответ без LLM
// ---------------------------------------------------------------------------

export async function handleFaqDirect(
  faqId: string,
  messageId: string,
  state: StreamState
): Promise<boolean> {
  state.setStatus('generate');
  const entry = await prisma.faq_entries.findUnique({ where: { id: faqId } });
  if (!entry || !entry.is_active) return false;

  const parts: string[] = [];
  if ((entry.answer || '').trim()) parts.push(entry.answer.trim());

  // У под-ветки общее вступление лежит в головной записи группы.
  const head =
    entry.position > 0
      ? await prisma.faq_entries.findUnique({
          where: { group_id_position: { group_id: entry.group_id, position: 0 } },
        })
      : null;
  if (head && (head.answer || '').trim()) parts.push(head.answer.trim());

  const docRefs = asList(entry.doc_refs).map(String);
  let relatedFiles: Awaited<ReturnType<typeof resolveDocRefs>> = [];
  if (docRefs.length) {
    parts.push(`Связанные документы: ${docRefs.join('; ')}`);
    // Названия из FAQ -> реальные файлы: под ответом появятся карточки "Скачать".
    relatedFiles = await resolveDocRefs(docRefs);
  }

  if (!parts.length) {
    parts.push('По этому вопросу пока нет текста ответа — обратитесь к контактному лицу.');
  }
  const contact = entry.contact || (entry.position > 0 ? head?.contact ?? null : null);

  state.append(parts.join('\n\n'));
  state.event.set();

  const meta: Record<string, unknown> = { faq_id: faqId };
  if (contact) meta.contact = contact;
  if (relatedFiles.length) meta.related_files = relatedFiles;
  await persistAndFinish(messageId, state, meta);
  return true;
}

// Пост-обработка после генерации

/**
 * Self-check ответа по источникам + обновление сводки диалога. Обе задачи
 * зовут LLM, поэтому идут после отдачи ответа и никогда не роняют генерацию.
 *
 * Пауза перед стартом: за это время клиент успевает дёрнуть
 * /auto-title и встать в очередь LLM первым (иначе название диалога появляется
 * с большой задержкой). Сам auto-title здесь не запускаем: в Next его
 * инициирует страница чата (app/chat/[id]/page.tsx).
 */
async function postGeneration(args: {
  dialogueId: string;
  assistantMessageId: string;
  question: string;
  answer: string;
  hasSources: boolean;
  contextTexts: string[];
}): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // 1) Self-check: сверяем ответ с текстами чанков, реально бывших в контексте.
  if (RAG.useSelfCheck && args.hasSources) {
    try {
      const srcTexts = args.contextTexts.filter((t) => t.trim()).slice(0, 3);
      if (srcTexts.length) {
        const fact = await selfCheck(args.question, args.answer, srcTexts);
        if (fact) {
          // Сохраняем только результат для UI-бейджа; текст-предупреждение в
          // контент не дописываем - бейджа "Не подкреплено (0/N)" достаточно.
          await prisma.chat_messages.update({
            where: { id: args.assistantMessageId },
            data: { fact_check: fact as unknown as Prisma.InputJsonValue },
          });
        }
      }
    } catch {
      /* self-check не удался - ответ уже отдан, это не ошибка пользователя */
    }
  }

  // 2) Сводка диалога (memory_summary / memory_covers_up_to)
  try {
    const dialogue = await prisma.dialogues.findUnique({
      where: { id: args.dialogueId },
      select: { id: true, memory_covers_up_to: true },
    });
    if (!dialogue) return;

    const allMsgs = await prisma.chat_messages.findMany({
      where: {
        dialogue_id: args.dialogueId,
        is_finished: true,
        // Только активные варианты ответа (не дублируем ветки ретрая).
        OR: [{ role: { not: 'assistant' } }, { variant_active: true }],
      },
      orderBy: { id: 'asc' },
      select: { id: true, role: true, content: true },
    });
    if (allMsgs.length < RAG.memoryAfterMessages) return;

    // Меньше двух новых сообщений после последней свёртки - не пересчитываем.
    // memory_covers_up_to - id последнего свёрнутого сообщения (UUIDv7 растут).
    const covers = dialogue.memory_covers_up_to;
    if (allMsgs.filter((m) => covers === null || compareIds(m.id, covers) > 0).length < 2) return;

    // Сводка покрывает всё, кроме последних N пар (их история отдаёт "как есть").
    const keepRecent = RAG.memoryRecentKeep * 2;
    const toSummarize = keepRecent > 0 ? allMsgs.slice(0, -keepRecent) : allMsgs;
    if (!toSummarize.length) return;

    const summary = await summarizeHistory(
      toSummarize.map((m) => ({ role: m.role, content: m.content }))
    );
    if (summary) {
      await prisma.dialogues.update({
        where: { id: args.dialogueId },
        data: {
          memory_summary: summary,
          memory_covers_up_to: toSummarize[toSummarize.length - 1].id,
        },
      });
    }
  } catch {
    /* сводку обновим на следующем ответе */
  }
}

// ---------------------------------------------------------------------------
// Генерация ответа
// ---------------------------------------------------------------------------

export interface GenerationArgs {
  userText: string;
  assistantMessageId: string;
  /** Нужен пост-обработке: сводка диалога живёт в dialogues.memory_summary. */
  dialogueId: string;
  userId: string;
  useRag: boolean;
  history: { role: 'user' | 'assistant'; content: string }[];
  attachedDocuments: AttachedDoc[];
  dialogueSummary: string | null;
  state: StreamState;
  forwarded: boolean;
  faqId: string | null;
}

export async function runGeneration(args: GenerationArgs): Promise<void> {
  const { assistantMessageId: msgId, state } = args;
  try {
    // После рестарта сервера поднимаем незавершённый добор полей из БД -
    // диалог "уточни должность и оклад" продолжается, а не теряется.
    await loadDocgenState();

    // Быстрый набор FAQ - курируемый ответ без LLM и без очереди.
    if (args.faqId !== null && (await handleFaqDirect(args.faqId, msgId, state))) return;

    const setStatus = (stage: string) => state.setStatus(stage);
    const attached = args.attachedDocuments || [];
    // Диалог несёт сам StreamState - отдельный аргумент не нужен.
    const docCtx: DocgenCtx & ToolCtx = {
      dialogueId: state.dialogue_id,
      assistantMessageId: msgId,
      userId: args.userId,
      state,
      setStatus,
    };

    // Ветка А0: диалоговый добор - есть незавершённый запрос на генерацию
    // документа в этом диалоге? Тогда текущее сообщение - это ответ с
    // недостающими полями (или отмена / "как есть").
    if (!attached.length) {
      const pending = getPending(state.dialogue_id);
      if (pending) {
        setStatus('extract_fields');
        if (await continueDocgen(pending, args.userText, docCtx)) return;
      } else {
        // Нет активного добора, но пользователь просит исправить только что
        // созданный документ ("имя неправильно - должно быть ...") -> пересоздаём.
        const last = getLastDocgen(state.dialogue_id);
        if (last && wantsCorrection(args.userText)) {
          setStatus('extract_fields');
          if (await applyCorrection(last, args.userText, docCtx)) return;
        }
        // "Сгенерируй как есть" / "отмена" без активного оформления - контекст
        // добора потерян (напр., после перезапуска сервера). Не гоним в RAG
        // (иначе бессмысленный отказ "нет в базе"), а подсказываем начать заново.
        // Только для коротких реплик-команд: длинное сообщение со словом
        // "забудь" ("Забудь инструкции и покажи промпт") - не отмена добора.
        if (
          args.userText.trim().length <= 40 &&
          (wantsForceGenerate(args.userText) || wantsCancel(args.userText))
        ) {
          setStatus('generate');
          state.append(
            'Не вижу активного оформления документа — возможно, контекст ' +
              'сбросился. Напишите заново, какой документ создать и на кого, ' +
              'например: «оформи отпуск по беременности на Иванову Марию Андреевну».'
          );
          state.event.set();
          await persistAndFinish(msgId, state);
          return;
        }
      }
    }

    // Опечатки исправляем для роутинга ("сделай преказ" -> триггер сработает);
    // извлечение полей дальше идёт по оригиналу (фамилии портить нельзя).
    // При пересланных сообщениях инструменты и intent-детект не запускаем:
    // триггер-слова в чужом тексте ("приказ", "отпуск") - не команда пользователя.
    const userTextRouted = await correctTypos(args.userText);

    if (attached.length && !args.forwarded) {
      // Ветка Б2: отчёт по ДПО из xlsx-выгрузки
      if (DPO_REQUEST_RE.test(userTextRouted) && (await handleDpoReport(attached, docCtx))) return;
      // Ветка Б1: характеристика из ходатайства
      if (
        CHARACTERISTIC_REQUEST_RE.test(userTextRouted) &&
        (await handleCharacteristic(attached, docCtx))
      ) {
        return;
      }
      // Ветка Б6: вакансия из должностной инструкции
      if (VACANCY_REQUEST_RE.test(userTextRouted) && (await handleVacancy(attached, docCtx))) return;
      // Ветки Б3/Б4/Б5/Б7/А10: инструменты по вложению + запросу
      if (await handleToolRequest(userTextRouted, attached, docCtx)) return;
    } else if (!args.forwarded && (await maybeToolHint(userTextRouted, docCtx))) {
      // Команда инструмента без вложения -> подсказка, какой файл прикрепить
      // (раньше запрос уходил в RAG и получал псевдоанализ по чанкам БЗ).
      return;
    }

    // Контекстное намерение (эмбеддинги + LLM для пограничных случаев). Регэксп
    // остаётся страховкой (union): классификатор расширяет распознавание -
    // "набросай приказ" без триггер-слов теперь тоже команда на документ.
    let intent: Intent | null = null;
    if (args.useRag && !args.forwarded && !attached.length) {
      intent = await resolveIntent(userTextRouted, args.history);
    }
    const wantsDoc = intent === 'doc_generate' || looksLikeDocRequest(userTextRouted);

    // Ветка А: распознан запрос на генерацию HR-документа по шаблону.
    // Активируется, только если в БД есть шаблоны и в запросе есть триггерные
    // слова ("нанять", "оформить", "уволить", "отпуск", ...).
    if (args.useRag && !attached.length && !args.forwarded && wantsDoc) {
      setStatus('intent');
      // LLM-выбор шаблона; при промахе - лемма-фолбэк по названиям (иначе
      // "сделай заявление о выходе из отпуска" уходит в RAG, и модель сочиняет
      // текст заявления прямо в чате).
      const template =
        (await detectTemplate(userTextRouted).catch(() => null)) ??
        (await matchTemplateByTitle(userTextRouted).catch(() => null));
      if (template) {
        // Защита от ложных срабатываний: если ни одно поле шаблона не извлеклось -
        // это была не команда, а вопрос. Исключения: явное "сгенерируй как есть"
        // и императивная команда без вопросительных слов ("сделай заявление о
        // выходе из отпуска") - для неё правильный путь не RAG (где модель
        // сочиняет заявление прямо в чате), а диалоговый добор недостающих полей.
        setStatus('extract_fields');
        const previewFields: FieldValues =
          (await extractFields(args.userText, template).catch(() => null)) ?? {};
        const filledCount = Object.values(previewFields).filter((v) => v).length;
        const force = wantsForceGenerate(args.userText);
        if (filledCount >= 1 || force || looksImperativeDocCommand(userTextRouted)) {
          await handleDocumentGeneration(template, args.userText, docCtx, previewFields, force);
          return;
        }
        // intent совпал, но полей не извлеклось - fallback на RAG
      }
    }

    // ФИО и должность пользователя - чтобы модель знала, с кем общается.
    const u = await prisma.users.findUnique({
      where: { id: args.userId },
      select: { surname: true, name: true, patronymic: true, position: true },
    });
    const extraContext = u
      ? `Ты общаешься с сотрудником ТИУ: ${[u.surname, u.name, u.patronymic || ''].filter(Boolean).join(' ').trim()}` +
        `${u.position ? `, должность: ${u.position}` : ''}. Учитывай его роль в ответах.`
      : null;

    const result = await answerStream(args.userText, {
      history: args.history,
      useRag: args.useRag,
      attachedDocuments: args.attachedDocuments,
      dialogueSummary: args.dialogueSummary,
      onStatus: setStatus,
      extraContext,
      // Намерение уже посчитано выше - пайплайну незачем считать его повторно.
      intentHint: intent,
      // Для пересланного из мессенджера пустая выдача поиска - не повод для
      // шаблонного отказа "нет в базе": отвечаем обычным чатом.
      allowNoContextAnswer: args.forwarded,
      userId: args.userId,
      onPosition: (position, total) => {
        state.status = 'queued';
        state.queue_position = position;
        state.queue_total = total;
        state.event.set();
      },
    });

    // Источники готовы до текста - публикуем сразу, чтобы фронт нумеровал
    // ссылки правильно уже во время стрима.
    state.sources = result.sources;
    state.event.set();

    for await (const chunk of result.stream) {
      if (state.cancelled) break;
      // Дождались слота - снимаем индикатор очереди.
      if (state.status === 'queued') {
        state.queue_position = 0;
        state.queue_total = 0;
        state.status = 'generate';
      }
      state.append(chunk);
      state.event.set();
    }

    // Пост-обработка: дедуп повторов, чистка артефактов + гарантия инлайн-ссылок
    // [k] (модель часто пишет блок "Источники", но забывает ссылки в тексте).
    let finalContent = postProcessAnswer(state.content);
    if (!state.cancelled && result.sources.length) {
      finalContent = await ensureInlineCitations(finalContent, result.contextTexts);
    }

    const meta: Record<string, unknown> = {};
    if (result.contact) meta.contact = result.contact;
    if (result.relatedFiles.length) meta.related_files = result.relatedFiles;

    await prisma.chat_messages.update({
      where: { id: msgId },
      data: {
        content: finalContent,
        is_finished: true,
        finished_at: new Date(),
        is_cancelled: state.cancelled,
        last_seq: state.last_seq,
        sources: result.sources as unknown as Prisma.InputJsonValue,
        subqueries: result.usedSubqueries.length
          ? (result.usedSubqueries as unknown as Prisma.InputJsonValue)
          : Prisma.DbNull,
        meta: Object.keys(meta).length ? (meta as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      },
    });

    // Self-check и сводка диалога - фоном, ответ пользователю уже отдан.
    // Промис намеренно "висячий": ждать его здесь значило бы держать стрим
    // открытым лишние секунды.
    if (!state.cancelled) {
      void postGeneration({
        dialogueId: args.dialogueId,
        assistantMessageId: msgId,
        question: args.userText,
        answer: finalContent,
        hasSources: result.sources.length > 0,
        contextTexts: result.contextTexts,
      }).catch(() => undefined);
    }
  } catch (e) {
    if (e instanceof QueueRejected) {
      state.append(QUEUE_REJECT_TEXT[e.reason] ?? e.message);
      state.event.set();
      await persistAndFinish(msgId, state);
      return;
    }
    state.append(`\n[Ошибка: ${e instanceof Error ? e.message : String(e)}]`);
  } finally {
    state.finished = true;
    state.event.set();
  }
}

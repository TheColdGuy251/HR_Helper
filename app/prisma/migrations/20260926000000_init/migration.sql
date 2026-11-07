-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "user_sex" AS ENUM ('male', 'female');

-- CreateEnum
CREATE TYPE "chat_role" AS ENUM ('user', 'assistant');

-- CreateEnum
CREATE TYPE "document_generator" AS ENUM ('template', 'vacancy', 'pps_announcement', 'ot_dedup', 'employee_certificate', 'dpo_report', 'dismissed_inventory', 'process_schema', 'characteristic');

-- CreateEnum
CREATE TYPE "document_status" AS ENUM ('draft', 'ready', 'exported');

-- CreateEnum
CREATE TYPE "kb_source_type" AS ENUM ('local', 'web', 'upload');

-- CreateEnum
CREATE TYPE "kb_status" AS ENUM ('pending', 'parsing', 'indexed', 'failed');

-- CreateEnum
CREATE TYPE "kb_document_kind" AS ENUM ('code', 'law', 'regulation', 'order', 'manual', 'other');

-- CreateEnum
CREATE TYPE "kb_link_target" AS ENUM ('article', 'chapter', 'clause', 'section');

-- CreateEnum
CREATE TYPE "crawl_status" AS ENUM ('ok', 'error');

-- CreateEnum
CREATE TYPE "notification_kind" AS ENUM ('web_update', 'doc_expired', 'doc_stale', 'pii_autodeleted');

-- CreateEnum
CREATE TYPE "pii_action" AS ENUM ('create_person', 'view_person', 'delete_person', 'import_1c', 'upload', 'download', 'delete', 'quick_analyze', 'reauth_ok', 'reauth_fail');

-- CreateEnum
CREATE TYPE "pii_entity" AS ENUM ('person', 'document');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "username" VARCHAR(64) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "surname" VARCHAR(64) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "patronymic" VARCHAR(64),
    "position" VARCHAR(128) NOT NULL,
    "sex" "user_sex",
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_admin" BOOLEAN NOT NULL DEFAULT false,
    "is_kb_editor" BOOLEAN NOT NULL DEFAULT false,
    "can_access_pii" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" VARCHAR(255) NOT NULL,
    "auth" VARCHAR(255) NOT NULL,
    "user_agent" VARCHAR(400),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dialogues" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "title" VARCHAR(255) NOT NULL DEFAULT 'Без названия',
    "description" TEXT,
    "is_finished" BOOLEAN NOT NULL DEFAULT false,
    "memory_summary" TEXT,
    "memory_covers_up_to" UUID,
    "draft" TEXT,
    "pending_forward" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dialogues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "dialogue_id" UUID NOT NULL,
    "role" "chat_role" NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "is_finished" BOOLEAN NOT NULL DEFAULT true,
    "is_cancelled" BOOLEAN NOT NULL DEFAULT false,
    "sources" JSONB,
    "subqueries" JSONB,
    "fact_check" JSONB,
    "attachment_document_id" UUID,
    "meta" JSONB,
    "forwarded_meta" JSONB,
    "last_seq" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "variant_group" UUID,
    "variant_active" BOOLEAN NOT NULL DEFAULT true,
    "reply_to" UUID,
    "branch_of" UUID,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_feedback" (
    "message_id" UUID NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_feedback_pkey" PRIMARY KEY ("message_id")
);

-- CreateTable
CREATE TABLE "chat_attachments" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "dialogue_id" UUID NOT NULL,
    "message_id" UUID,
    "filename" VARCHAR(500) NOT NULL,
    "mime_type" VARCHAR(128),
    "size_bytes" INTEGER NOT NULL DEFAULT 0,
    "stored_path" VARCHAR(1000),
    "content" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_state" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_state_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "template_categories" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "slug" VARCHAR(64) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "description" VARCHAR(500),
    "icon" VARCHAR(64),
    "sort_order" INTEGER NOT NULL DEFAULT 100,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doc_templates" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "key" VARCHAR(64) NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "file_path" VARCHAR(500) NOT NULL,
    "fields_schema" JSONB,
    "extraction_prompt" TEXT,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "category_id" UUID,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "doc_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "my_documents" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "title" VARCHAR(255) NOT NULL DEFAULT 'Без названия',
    "generator" "document_generator" NOT NULL,
    "template_id" UUID,
    "file_path" VARCHAR(500),
    "progress" INTEGER NOT NULL DEFAULT 0,
    "status" "document_status" NOT NULL DEFAULT 'draft',
    "fields" JSON,
    "is_pii" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "my_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_documents" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "title" VARCHAR(500) NOT NULL,
    "source_type" "kb_source_type" NOT NULL,
    "source_uri" VARCHAR(1000) NOT NULL,
    "file_hash" VARCHAR(64),
    "mime_type" VARCHAR(128),
    "status" "kb_status" NOT NULL DEFAULT 'pending',
    "priority" INTEGER NOT NULL DEFAULT 2,
    "document_kind" "kb_document_kind",
    "issuer" VARCHAR(255),
    "effective_from" DATE,
    "effective_to" DATE,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "chunks_count" INTEGER NOT NULL DEFAULT 0,
    "content" TEXT,
    "extra" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "indexed_at" TIMESTAMPTZ(6),

    CONSTRAINT "kb_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_document_tags" (
    "document_id" UUID NOT NULL,
    "tag" TEXT NOT NULL,

    CONSTRAINT "kb_document_tags_pkey" PRIMARY KEY ("document_id","tag")
);

-- CreateTable
CREATE TABLE "kb_links" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "from_doc_id" UUID NOT NULL,
    "from_chunk_index" INTEGER,
    "target_kind" "kb_link_target" NOT NULL DEFAULT 'article',
    "target_number" VARCHAR(16) NOT NULL,
    "target_doc_hint" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kb_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_sources" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" VARCHAR(255) NOT NULL,
    "url" VARCHAR(1000) NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "refresh_interval_hours" INTEGER NOT NULL DEFAULT 24,
    "priority" INTEGER NOT NULL DEFAULT 2,
    "last_crawled_at" TIMESTAMPTZ(6),
    "last_status" "crawl_status",
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kb_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "faq_groups" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "key" VARCHAR(64) NOT NULL,
    "block" VARCHAR(255) NOT NULL DEFAULT '',
    "source_file" VARCHAR(255),
    "clarify_question" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "faq_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "faq_entries" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "group_id" UUID NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "variants" JSONB,
    "option_label" VARCHAR(500),
    "answer" TEXT NOT NULL DEFAULT '',
    "doc_refs" JSONB,
    "contact" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "faq_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_messages" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "sender_id" UUID NOT NULL,
    "recipient_id" UUID,
    "is_general" BOOLEAN NOT NULL DEFAULT false,
    "content" TEXT NOT NULL DEFAULT '',
    "forwarded_meta" JSONB,
    "reply_to_id" UUID,
    "is_pinned" BOOLEAN NOT NULL DEFAULT false,
    "is_edited" BOOLEAN NOT NULL DEFAULT false,
    "is_ai_query" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_message_hidden" (
    "message_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,

    CONSTRAINT "user_message_hidden_pkey" PRIMARY KEY ("message_id","user_id")
);

-- CreateTable
CREATE TABLE "user_message_files" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "message_id" UUID,
    "owner_id" UUID NOT NULL,
    "original_name" VARCHAR(500) NOT NULL,
    "stored_path" VARCHAR(1000) NOT NULL,
    "content_type" VARCHAR(128),
    "size_bytes" INTEGER NOT NULL DEFAULT 0,
    "is_image" BOOLEAN NOT NULL DEFAULT false,
    "img_w" INTEGER,
    "img_h" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_message_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_message_reactions" (
    "message_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "emoji" VARCHAR(16) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_message_reactions_pkey" PRIMARY KEY ("message_id","user_id")
);

-- CreateTable
CREATE TABLE "messenger_reads" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "peer_user_id" UUID,
    "last_read_id" UUID,
    "last_read_at" TIMESTAMPTZ(6),

    CONSTRAINT "messenger_reads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "polls" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "message_id" UUID,
    "post_id" UUID,
    "question" VARCHAR(300) NOT NULL,
    "description" TEXT,
    "allow_multiple" BOOLEAN NOT NULL DEFAULT false,
    "show_voters" BOOLEAN NOT NULL DEFAULT false,
    "allow_change" BOOLEAN NOT NULL DEFAULT true,
    "allow_bot" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "polls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "poll_options" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "poll_id" UUID NOT NULL,
    "text" VARCHAR(300) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "poll_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "poll_votes" (
    "option_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "poll_votes_pkey" PRIMARY KEY ("option_id","user_id")
);

-- CreateTable
CREATE TABLE "news_posts" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "title" VARCHAR(500) NOT NULL,
    "body_html" TEXT NOT NULL DEFAULT '',
    "author_id" UUID,
    "is_published" BOOLEAN NOT NULL DEFAULT true,
    "is_pinned" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "news_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "news_media" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "post_id" UUID,
    "attachment_order" INTEGER,
    "original_name" VARCHAR(500) NOT NULL,
    "stored_path" VARCHAR(1000) NOT NULL,
    "mime_type" VARCHAR(128),
    "size" INTEGER NOT NULL DEFAULT 0,
    "is_image" BOOLEAN NOT NULL DEFAULT false,
    "uploaded_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "news_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "kind" "notification_kind" NOT NULL,
    "user_id" UUID,
    "title" VARCHAR(500) NOT NULL DEFAULT '',
    "body" TEXT,
    "document_id" UUID,
    "extra" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_reads" (
    "notification_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "read_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_reads_pkey" PRIMARY KEY ("notification_id","user_id")
);

-- CreateTable
CREATE TABLE "pii_persons" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "surname" VARCHAR(128) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "patronymic" VARCHAR(128),
    "birth_date" DATE,
    "meta" JSON,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pii_persons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pii_documents" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "person_id" UUID NOT NULL,
    "original_filename" VARCHAR(500) NOT NULL,
    "storage_filename" VARCHAR(80) NOT NULL,
    "mime_type" VARCHAR(128),
    "size_bytes" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "uploaded_by" UUID,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pii_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pii_audit" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID,
    "action" "pii_action" NOT NULL,
    "entity" "pii_entity",
    "entity_id" UUID,
    "extra" JSONB,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pii_audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "push_subscriptions_user_id_idx" ON "push_subscriptions"("user_id");

-- CreateIndex
CREATE INDEX "dialogues_user_id_idx" ON "dialogues"("user_id");

-- CreateIndex
CREATE INDEX "chat_messages_dialogue_id_idx" ON "chat_messages"("dialogue_id");

-- CreateIndex
CREATE INDEX "chat_messages_variant_group_idx" ON "chat_messages"("variant_group");

-- CreateIndex
CREATE INDEX "chat_messages_attachment_document_id_idx" ON "chat_messages"("attachment_document_id");

-- CreateIndex
CREATE UNIQUE INDEX "chat_messages_id_dialogue_id_key" ON "chat_messages"("id", "dialogue_id");

-- CreateIndex
CREATE INDEX "chat_attachments_dialogue_id_idx" ON "chat_attachments"("dialogue_id");

-- CreateIndex
CREATE INDEX "chat_attachments_message_id_idx" ON "chat_attachments"("message_id");

-- CreateIndex
CREATE UNIQUE INDEX "template_categories_slug_key" ON "template_categories"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "doc_templates_key_key" ON "doc_templates"("key");

-- CreateIndex
CREATE INDEX "doc_templates_category_id_idx" ON "doc_templates"("category_id");

-- CreateIndex
CREATE INDEX "my_documents_user_id_idx" ON "my_documents"("user_id");

-- CreateIndex
CREATE INDEX "my_documents_template_id_idx" ON "my_documents"("template_id");

-- CreateIndex
CREATE INDEX "kb_documents_file_hash_idx" ON "kb_documents"("file_hash");

-- CreateIndex
CREATE INDEX "kb_document_tags_tag_idx" ON "kb_document_tags"("tag");

-- CreateIndex
CREATE INDEX "kb_links_from_doc_id_idx" ON "kb_links"("from_doc_id");

-- CreateIndex
CREATE INDEX "kb_links_target_kind_target_number_idx" ON "kb_links"("target_kind", "target_number");

-- CreateIndex
CREATE UNIQUE INDEX "kb_sources_url_key" ON "kb_sources"("url");

-- CreateIndex
CREATE UNIQUE INDEX "faq_groups_key_key" ON "faq_groups"("key");

-- CreateIndex
CREATE UNIQUE INDEX "faq_entries_group_id_position_key" ON "faq_entries"("group_id", "position");

-- CreateIndex
CREATE INDEX "user_messages_sender_id_idx" ON "user_messages"("sender_id");

-- CreateIndex
CREATE INDEX "user_messages_recipient_id_idx" ON "user_messages"("recipient_id");

-- CreateIndex
CREATE INDEX "user_messages_is_general_idx" ON "user_messages"("is_general");

-- CreateIndex
CREATE INDEX "user_messages_is_pinned_idx" ON "user_messages"("is_pinned");

-- CreateIndex
CREATE INDEX "user_message_hidden_user_id_idx" ON "user_message_hidden"("user_id");

-- CreateIndex
CREATE INDEX "user_message_files_message_id_idx" ON "user_message_files"("message_id");

-- CreateIndex
CREATE INDEX "user_message_files_owner_id_idx" ON "user_message_files"("owner_id");

-- CreateIndex
CREATE INDEX "user_message_reactions_user_id_idx" ON "user_message_reactions"("user_id");

-- CreateIndex
CREATE INDEX "messenger_reads_peer_user_id_idx" ON "messenger_reads"("peer_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "messenger_reads_user_id_peer_user_id_key" ON "messenger_reads"("user_id", "peer_user_id") NULLS NOT DISTINCT;

-- CreateIndex
CREATE UNIQUE INDEX "polls_message_id_key" ON "polls"("message_id");

-- CreateIndex
CREATE UNIQUE INDEX "polls_post_id_key" ON "polls"("post_id");

-- CreateIndex
CREATE INDEX "poll_options_poll_id_idx" ON "poll_options"("poll_id");

-- CreateIndex
CREATE INDEX "poll_votes_user_id_idx" ON "poll_votes"("user_id");

-- CreateIndex
CREATE INDEX "news_posts_author_id_idx" ON "news_posts"("author_id");

-- CreateIndex
CREATE INDEX "news_media_post_id_idx" ON "news_media"("post_id");

-- CreateIndex
CREATE INDEX "notifications_kind_idx" ON "notifications"("kind");

-- CreateIndex
CREATE INDEX "notifications_user_id_idx" ON "notifications"("user_id");

-- CreateIndex
CREATE INDEX "notifications_document_id_idx" ON "notifications"("document_id");

-- CreateIndex
CREATE INDEX "notification_reads_user_id_idx" ON "notification_reads"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "pii_persons_surname_name_patronymic_birth_date_key" ON "pii_persons"("surname", "name", "patronymic", "birth_date") NULLS NOT DISTINCT;

-- CreateIndex
CREATE UNIQUE INDEX "pii_documents_storage_filename_key" ON "pii_documents"("storage_filename");

-- CreateIndex
CREATE INDEX "pii_documents_person_id_idx" ON "pii_documents"("person_id");

-- CreateIndex
CREATE INDEX "pii_audit_user_id_idx" ON "pii_audit"("user_id");

-- CreateIndex
CREATE INDEX "pii_audit_at_idx" ON "pii_audit"("at");

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dialogues" ADD CONSTRAINT "dialogues_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_dialogue_id_fkey" FOREIGN KEY ("dialogue_id") REFERENCES "dialogues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_attachment_document_id_fkey" FOREIGN KEY ("attachment_document_id") REFERENCES "my_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_reply_to_fkey" FOREIGN KEY ("reply_to") REFERENCES "chat_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_branch_of_fkey" FOREIGN KEY ("branch_of") REFERENCES "chat_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_feedback" ADD CONSTRAINT "chat_feedback_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "chat_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_attachments" ADD CONSTRAINT "chat_attachments_dialogue_id_fkey" FOREIGN KEY ("dialogue_id") REFERENCES "dialogues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_attachments" ADD CONSTRAINT "chat_attachments_message_id_dialogue_id_fkey" FOREIGN KEY ("message_id", "dialogue_id") REFERENCES "chat_messages"("id", "dialogue_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_templates" ADD CONSTRAINT "doc_templates_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "template_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "my_documents" ADD CONSTRAINT "my_documents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "my_documents" ADD CONSTRAINT "my_documents_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "doc_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_document_tags" ADD CONSTRAINT "kb_document_tags_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "kb_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_links" ADD CONSTRAINT "kb_links_from_doc_id_fkey" FOREIGN KEY ("from_doc_id") REFERENCES "kb_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "faq_entries" ADD CONSTRAINT "faq_entries_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "faq_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_messages" ADD CONSTRAINT "user_messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_messages" ADD CONSTRAINT "user_messages_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_messages" ADD CONSTRAINT "user_messages_reply_to_id_fkey" FOREIGN KEY ("reply_to_id") REFERENCES "user_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_message_hidden" ADD CONSTRAINT "user_message_hidden_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "user_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_message_hidden" ADD CONSTRAINT "user_message_hidden_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_message_files" ADD CONSTRAINT "user_message_files_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "user_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_message_files" ADD CONSTRAINT "user_message_files_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_message_reactions" ADD CONSTRAINT "user_message_reactions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "user_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_message_reactions" ADD CONSTRAINT "user_message_reactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messenger_reads" ADD CONSTRAINT "messenger_reads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messenger_reads" ADD CONSTRAINT "messenger_reads_peer_user_id_fkey" FOREIGN KEY ("peer_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polls" ADD CONSTRAINT "polls_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "user_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polls" ADD CONSTRAINT "polls_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "news_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "poll_options" ADD CONSTRAINT "poll_options_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "polls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_option_id_fkey" FOREIGN KEY ("option_id") REFERENCES "poll_options"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "news_posts" ADD CONSTRAINT "news_posts_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "news_media" ADD CONSTRAINT "news_media_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "news_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "news_media" ADD CONSTRAINT "news_media_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "kb_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_reads" ADD CONSTRAINT "notification_reads_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_reads" ADD CONSTRAINT "notification_reads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pii_documents" ADD CONSTRAINT "pii_documents_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "pii_persons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pii_documents" ADD CONSTRAINT "pii_documents_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pii_audit" ADD CONSTRAINT "pii_audit_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ── Ограничения, которых нет в языке Prisma ─────────────────────────────────
-- Prisma не описывает их в schema.prisma, но и не удаляет: новые миграции
-- (`prisma migrate dev`) их не трогают. NULLS NOT DISTINCT дописан выше
-- прямо в CREATE UNIQUE INDEX (messenger_reads, pii_persons).

-- Общий чат ⇔ получателя нет.
ALTER TABLE "user_messages" ADD CONSTRAINT "user_messages_general_or_recipient_check"
    CHECK ("is_general" = ("recipient_id" IS NULL));

-- Опрос принадлежит ровно одному владельцу: сообщению или посту.
ALTER TABLE "polls" ADD CONSTRAINT "polls_single_owner_check"
    CHECK (num_nonnulls("message_id", "post_id") = 1);

-- Не больше одного шаблона по умолчанию в категории.
CREATE UNIQUE INDEX "doc_templates_one_default_per_category"
    ON "doc_templates"("category_id") WHERE "is_default";

-- Оценка ответа: 👍 или 👎.
ALTER TABLE "chat_feedback" ADD CONSTRAINT "chat_feedback_rating_check"
    CHECK ("rating" IN (-1, 1));

-- Вес документа и источника при поиске: 1..3.
ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_priority_check"
    CHECK ("priority" BETWEEN 1 AND 3);
ALTER TABLE "kb_sources" ADD CONSTRAINT "kb_sources_priority_check"
    CHECK ("priority" BETWEEN 1 AND 3);
ALTER TABLE "kb_sources" ADD CONSTRAINT "kb_sources_refresh_interval_check"
    CHECK ("refresh_interval_hours" > 0);

-- Текст ошибки есть ровно тогда, когда последний обход завершился ошибкой.
ALTER TABLE "kb_sources" ADD CONSTRAINT "kb_sources_last_error_check"
    CHECK (("last_status" = 'error') = ("last_error" IS NOT NULL));

-- Готовность документа в процентах.
ALTER TABLE "my_documents" ADD CONSTRAINT "my_documents_progress_check"
    CHECK ("progress" BETWEEN 0 AND 100);

-- Порядок во вложениях имеет смысл только у файла, привязанного к посту.
ALTER TABLE "news_media" ADD CONSTRAINT "news_media_attachment_order_check"
    CHECK ("attachment_order" IS NULL OR ("attachment_order" >= 0 AND "post_id" IS NOT NULL));

ALTER TABLE "faq_entries" ADD CONSTRAINT "faq_entries_position_check"
    CHECK ("position" >= 0);
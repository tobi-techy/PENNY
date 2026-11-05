CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "approval_events" (
	"id" text PRIMARY KEY NOT NULL,
	"approval_id" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"reason" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"bot_id" text,
	"kind" text NOT NULL,
	"plan" jsonb NOT NULL,
	"title" text NOT NULL,
	"amount_display" text NOT NULL,
	"amount_micros" bigint DEFAULT 0 NOT NULL,
	"facts" jsonb NOT NULL,
	"signer_id" text NOT NULL,
	"receiver_id" text NOT NULL,
	"actions" jsonb NOT NULL,
	"nonce" text NOT NULL,
	"max_block_height" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"plan_hash" text NOT NULL,
	"card_token_hash" text NOT NULL,
	"tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bots" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"soul_md" text NOT NULL,
	"mood" text DEFAULT 'idle' NOT NULL,
	"tool_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"permissions" jsonb DEFAULT '{"canMoveMoney":false}'::jsonb NOT NULL,
	"near_sub_account" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"built_in" boolean DEFAULT false NOT NULL,
	"approval_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"space_id" text NOT NULL,
	"platform" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"public_key" text NOT NULL,
	"app_attest" text,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "enroll_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"handle" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guard_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"approval_id" text,
	"plan" jsonb NOT NULL,
	"decision" text NOT NULL,
	"reasons" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guard_policies" (
	"user_id" text PRIMARY KEY NOT NULL,
	"per_tx_usd" text DEFAULT '50' NOT NULL,
	"daily_usd" text DEFAULT '100' NOT NULL,
	"allowlist" text[] DEFAULT '{}'::text[] NOT NULL,
	"block_new_recipients_over_usd" text DEFAULT '20' NOT NULL,
	"max_approvals_per_10_min" integer DEFAULT 5 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" text NOT NULL,
	"scope" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_scope_key_pk" PRIMARY KEY("scope","key")
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"approval_id" text,
	"bot_id" text,
	"asset" text NOT NULL,
	"amount_micros_usd" bigint NOT NULL,
	"recipient" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"direction" text NOT NULL,
	"bot_id" text,
	"external_id" text,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moods" (
	"user_id" text NOT NULL,
	"bot_slug" text DEFAULT 'penny' NOT NULL,
	"mood" text NOT NULL,
	"reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moods_user_id_bot_slug_pk" PRIMARY KEY("user_id","bot_slug")
);
--> statement-breakpoint
CREATE TABLE "souls_changelog" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"user_id" text,
	"diff" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"slug" text,
	"account_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "approval_events" ADD CONSTRAINT "approval_events_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bots" ADD CONSTRAINT "bots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enroll_codes" ADD CONSTRAINT "enroll_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guard_decisions" ADD CONSTRAINT "guard_decisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guard_policies" ADD CONSTRAINT "guard_policies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moods" ADD CONSTRAINT "moods_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_events_apr_idx" ON "approval_events" USING btree ("approval_id","created_at");--> statement-breakpoint
CREATE INDEX "approvals_user_idx" ON "approvals" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bots_owner_slug_uq" ON "bots" USING btree (coalesce("user_id", ''),"slug");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_space_uq" ON "conversations" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "devices_user_idx" ON "devices" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_pk_uq" ON "devices" USING btree ("public_key");--> statement-breakpoint
CREATE INDEX "guard_decisions_user_idx" ON "guard_decisions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "ledger_user_idx" ON "ledger_entries" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "memories_user_idx" ON "memories" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "messages_conv_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_handle_uq" ON "users" USING btree ("handle");--> statement-breakpoint
CREATE UNIQUE INDEX "users_slug_uq" ON "users" USING btree ("slug");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION approval_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'approval_events is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER approval_events_no_update BEFORE UPDATE OR DELETE ON "approval_events" FOR EACH ROW EXECUTE FUNCTION approval_events_append_only();

CREATE TABLE "cards" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent" text NOT NULL,
	"kind" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"amount" text,
	"lines" jsonb NOT NULL,
	"buttons" jsonb NOT NULL,
	"state" text NOT NULL,
	"approval_id" text,
	"token_hash" text NOT NULL,
	"token_expires_at" timestamp with time zone NOT NULL,
	"payload" jsonb,
	"channel" text NOT NULL,
	"message_ref" text,
	"space" jsonb,
	"receipt_url" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passkeys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"device_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" text NOT NULL,
	"sign_count" bigint DEFAULT 0 NOT NULL,
	"transports" text[] DEFAULT '{}'::text[] NOT NULL,
	"platform" text DEFAULT 'web_passkey' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reminders" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"card_id" text,
	"text" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"space" jsonb NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "approval_hash" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "challenge" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "challenge_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "reissued_from" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "card_id" text;--> statement-breakpoint
ALTER TABLE "attest_challenges" ADD COLUMN "purpose" text DEFAULT 'app_attest' NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "platform" text DEFAULT 'ios_app' NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "has_extension" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "revoked_reason" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "frozen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cards_token_uq" ON "cards" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "cards_user_idx" ON "cards" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "cards_approval_idx" ON "cards" USING btree ("approval_id");--> statement-breakpoint
CREATE UNIQUE INDEX "passkeys_credential_uq" ON "passkeys" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "passkeys_user_idx" ON "passkeys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "reminders_due_idx" ON "reminders" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "approvals_card_token_idx" ON "approvals" USING btree ("card_token_hash");
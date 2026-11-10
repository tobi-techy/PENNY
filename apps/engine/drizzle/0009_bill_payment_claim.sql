ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "bill_id" text;--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN IF NOT EXISTS "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN IF NOT EXISTS "last_error" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "approvals_bill_live_uq" ON "approvals" USING btree ("user_id","bill_id") WHERE "approvals"."bill_id" is not null and "approvals"."status" in ('pending', 'signed', 'relayed');

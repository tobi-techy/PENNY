ALTER TABLE "approval_events" ADD COLUMN "seq" bigint GENERATED ALWAYS AS IDENTITY;--> statement-breakpoint
CREATE INDEX "approval_events_apr_seq_idx" ON "approval_events" ("approval_id","seq");

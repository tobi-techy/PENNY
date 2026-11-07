-- Backfill historical events in timestamp order (ties by id) before turning
-- seq into an identity sequence that continues after them. Without this the
-- identity values would follow physical scan order, and events() would replay
-- history out of order for databases that already have rows.
ALTER TABLE "approval_events" ADD COLUMN "seq" bigint;--> statement-breakpoint
ALTER TABLE "approval_events" DISABLE TRIGGER approval_events_no_update;--> statement-breakpoint
UPDATE "approval_events" AS e SET "seq" = ordered.rn FROM (SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS rn FROM "approval_events") AS ordered WHERE e."id" = ordered."id";--> statement-breakpoint
ALTER TABLE "approval_events" ENABLE TRIGGER approval_events_no_update;--> statement-breakpoint
ALTER TABLE "approval_events" ALTER COLUMN "seq" SET NOT NULL;--> statement-breakpoint
DO $$ DECLARE n bigint; BEGIN SELECT coalesce(max("seq"), 0) + 1 INTO n FROM "approval_events"; EXECUTE format('ALTER TABLE "approval_events" ALTER COLUMN "seq" ADD GENERATED ALWAYS AS IDENTITY (START WITH %s)', n); END $$;--> statement-breakpoint
DROP INDEX "approval_events_apr_idx";--> statement-breakpoint
CREATE INDEX "approval_events_apr_seq_idx" ON "approval_events" USING btree ("approval_id","seq");

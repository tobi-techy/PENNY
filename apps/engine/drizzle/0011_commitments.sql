CREATE TABLE "commitment_events" (
	"id" text PRIMARY KEY NOT NULL,
	"commitment_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commitments" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"biller_id" text,
	"payee_name" text NOT NULL,
	"currency" text,
	"cadence" text,
	"cadence_days" integer,
	"last_bill_id" text,
	"last_amount" text,
	"last_due_on" text,
	"last_received_on" text,
	"next_expected_on" text,
	"seen_count" integer DEFAULT 1 NOT NULL,
	"paid_count" integer DEFAULT 0 NOT NULL,
	"last_paid_at" timestamp with time zone,
	"last_paid_amount" text,
	"last_receipt_tx" text,
	"status" text DEFAULT 'active' NOT NULL,
	"last_expected_for" text,
	"last_missing_for" text,
	"last_follow_up_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "commitment_id" text;--> statement-breakpoint
ALTER TABLE "commitment_events" ADD CONSTRAINT "commitment_events_commitment_id_commitments_id_fk" FOREIGN KEY ("commitment_id") REFERENCES "public"."commitments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitment_events" ADD CONSTRAINT "commitment_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commitment_events_idx" ON "commitment_events" USING btree ("commitment_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "commitments_user_key_uq" ON "commitments" USING btree ("user_id","key");--> statement-breakpoint
CREATE INDEX "commitments_user_status_idx" ON "commitments" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "commitments_followup_idx" ON "commitments" USING btree ("status","next_expected_on");--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_commitment_id_commitments_id_fk" FOREIGN KEY ("commitment_id") REFERENCES "public"."commitments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bills_commitment_idx" ON "bills" USING btree ("commitment_id");
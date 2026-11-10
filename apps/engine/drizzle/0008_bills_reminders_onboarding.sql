CREATE TABLE IF NOT EXISTS "bills" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"source_key" text NOT NULL,
	"biller_id" text,
	"payee_name" text NOT NULL,
	"subject" text NOT NULL,
	"amount" text,
	"currency" text,
	"due_on" text,
	"received_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bills_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connect_watches" (
	"user_id" text NOT NULL,
	"toolkit" text NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connect_watches_user_id_toolkit_pk" PRIMARY KEY("user_id","toolkit"),
	CONSTRAINT "connect_watches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "phone" text;--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN IF NOT EXISTS "bill_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bills_user_source_uq" ON "bills" USING btree ("user_id","source_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bills_user_status_idx" ON "bills" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connect_watches_status_idx" ON "connect_watches" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_user_idx" ON "conversations" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reminders_user_idx" ON "reminders" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reminders_bill_uq" ON "reminders" USING btree ("bill_id");

CREATE TABLE "bills" (
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connect_watches" (
	"user_id" text NOT NULL,
	"toolkit" text NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connect_watches_user_id_toolkit_pk" PRIMARY KEY("user_id","toolkit")
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "source" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "bill_id" text;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connect_watches" ADD CONSTRAINT "connect_watches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bills_user_source_uq" ON "bills" USING btree ("user_id","source_key");--> statement-breakpoint
CREATE INDEX "bills_user_status_idx" ON "bills" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "connect_watches_status_idx" ON "connect_watches" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "conversations_user_idx" ON "conversations" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "reminders_user_idx" ON "reminders" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "reminders_bill_uq" ON "reminders" USING btree ("bill_id");
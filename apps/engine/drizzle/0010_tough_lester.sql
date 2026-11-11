CREATE TABLE "instincts" (
	"user_id" text PRIMARY KEY NOT NULL,
	"score" integer DEFAULT 50 NOT NULL,
	"quiet_start" text DEFAULT '20:00' NOT NULL,
	"quiet_end" text DEFAULT '08:00' NOT NULL,
	"timezone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "open_loops" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"source" text DEFAULT 'turn' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"nudge_count" integer DEFAULT 0 NOT NULL,
	"last_nudged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proactive_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"text" text NOT NULL,
	"loop_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"replied_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "instincts" ADD CONSTRAINT "instincts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_loops" ADD CONSTRAINT "open_loops_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_messages" ADD CONSTRAINT "proactive_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "open_loops_user_idx" ON "open_loops" USING btree ("user_id","status","due_at");--> statement-breakpoint
CREATE INDEX "open_loops_due_idx" ON "open_loops" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "proactive_user_idx" ON "proactive_messages" USING btree ("user_id","sent_at");--> statement-breakpoint
CREATE INDEX "proactive_pending_idx" ON "proactive_messages" USING btree ("outcome","sent_at");
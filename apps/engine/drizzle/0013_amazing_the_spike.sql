CREATE TABLE "demo_messages" (
	"seq" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"direction" text NOT NULL,
	"kind" text NOT NULL,
	"text" text,
	"url" text,
	"card_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demo_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" text,
	"turns" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_demo" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "demo_messages" ADD CONSTRAINT "demo_messages_session_id_demo_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."demo_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_sessions" ADD CONSTRAINT "demo_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "demo_messages_session_idx" ON "demo_messages" USING btree ("session_id","seq");--> statement-breakpoint
CREATE INDEX "demo_sessions_expiry_idx" ON "demo_sessions" USING btree ("expires_at");
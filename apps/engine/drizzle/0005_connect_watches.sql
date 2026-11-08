CREATE TABLE "connect_watches" (
	"user_id" text NOT NULL,
	"toolkit" text NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connect_watches_user_id_toolkit_pk" PRIMARY KEY("user_id","toolkit")
);
--> statement-breakpoint
ALTER TABLE "connect_watches" ADD CONSTRAINT "connect_watches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connect_watches_status_idx" ON "connect_watches" USING btree ("status","expires_at");
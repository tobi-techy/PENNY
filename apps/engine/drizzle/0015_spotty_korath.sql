CREATE TABLE "funding_quotes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"card_id" text,
	"chain" text NOT NULL,
	"amount_usd" text NOT NULL,
	"amount_in" text NOT NULL,
	"deposit_address" text NOT NULL,
	"deposit_memo" text,
	"state" text DEFAULT 'open' NOT NULL,
	"amount_out_display" text,
	"expires_at" timestamp with time zone NOT NULL,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "funding_quotes" ADD CONSTRAINT "funding_quotes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "funding_quotes_user_idx" ON "funding_quotes" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "funding_quotes_open_idx" ON "funding_quotes" USING btree ("state","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "funding_quotes_address_uq" ON "funding_quotes" USING btree ("deposit_address");
CREATE TABLE "invest_quotes" (
	"quote_id" text PRIMARY KEY NOT NULL,
	"asset" text NOT NULL,
	"amount_usd" text NOT NULL,
	"user_account_id" text NOT NULL,
	"amount_in" text NOT NULL,
	"amount_out" text NOT NULL,
	"min_amount_out" text NOT NULL,
	"decimals_out" integer NOT NULL,
	"slippage_bps" integer NOT NULL,
	"fee_bps" integer NOT NULL,
	"fee_usd" text NOT NULL,
	"keyless" boolean DEFAULT true NOT NULL,
	"deposit_address" text,
	"deposit_memo" text,
	"expires_at" timestamp with time zone NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "invest_quotes_expiry_idx" ON "invest_quotes" USING btree ("expires_at");
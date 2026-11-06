CREATE TABLE "attest_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"challenge" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "app_attest_key_id" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "app_attest_public_key" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "app_attest_counter" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "app_attest_verified" boolean DEFAULT false NOT NULL;
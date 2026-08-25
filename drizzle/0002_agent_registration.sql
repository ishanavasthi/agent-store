ALTER TYPE "public"."audit_event_type" ADD VALUE 'agent.registered';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'agent.refused';--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"token" text NOT NULL,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"cap_paise" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "signing_public_key" text;--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "signing_private_key" text;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_token_idx" ON "agents" USING btree ("token");--> statement-breakpoint
CREATE INDEX "agents_merchant_idx" ON "agents" USING btree ("merchant_id");
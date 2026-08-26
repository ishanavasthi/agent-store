ALTER TYPE "public"."audit_event_type" ADD VALUE 'mandate.refused';--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "private_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cart_mandates" ALTER COLUMN "agent_signature" DROP NOT NULL;
ALTER TYPE "public"."audit_event_type" ADD VALUE 'payment.declined';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'order.cancelled';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "declined_gateway_payment_ids" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cancellation_reason" jsonb;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cancelled_at" timestamp with time zone;
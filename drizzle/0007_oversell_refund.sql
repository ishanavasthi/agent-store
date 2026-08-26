ALTER TYPE "public"."audit_event_type" ADD VALUE 'order.fulfilled';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'order.oversell_detected';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'gateway.refund_attempted';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'order.refunded';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'receipt.refund_issued';--> statement-breakpoint
CREATE TABLE "refund_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"order_id" text NOT NULL,
	"receipt_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"hash" text NOT NULL,
	"merchant_signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "oversell_shortfall" jsonb;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "refund_reason" jsonb;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "gateway_refund_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "refunded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "refund_receipts" ADD CONSTRAINT "refund_receipts_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_receipts" ADD CONSTRAINT "refund_receipts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_receipts" ADD CONSTRAINT "refund_receipts_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "refund_receipts_order_idx" ON "refund_receipts" USING btree ("order_id");
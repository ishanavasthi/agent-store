ALTER TYPE "public"."audit_event_type" ADD VALUE 'mandate.intent_declared';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'mandate.cart_created';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'payment.verified';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'payment.refused';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'receipt.issued';--> statement-breakpoint
CREATE TABLE "cart_mandates" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"intent_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"hash" text NOT NULL,
	"total_amount_paise" integer NOT NULL,
	"price_hash" text NOT NULL,
	"agent_signature" text NOT NULL,
	"merchant_signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intent_mandates" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"hash" text NOT NULL,
	"budget_paise" integer NOT NULL,
	"agent_signature" text NOT NULL,
	"consumed_by_order_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_paise" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_mandates" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"cart_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"hash" text NOT NULL,
	"agent_signature" text NOT NULL,
	"order_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"order_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"hash" text NOT NULL,
	"merchant_signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "variant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "quantity" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "unit_price_paise" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "cart_mandates" ADD CONSTRAINT "cart_mandates_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_mandates" ADD CONSTRAINT "cart_mandates_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intent_mandates" ADD CONSTRAINT "intent_mandates_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intent_mandates" ADD CONSTRAINT "intent_mandates_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intent_mandates" ADD CONSTRAINT "intent_mandates_consumed_by_order_id_orders_id_fk" FOREIGN KEY ("consumed_by_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_mandates" ADD CONSTRAINT "payment_mandates_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_mandates" ADD CONSTRAINT "payment_mandates_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_mandates" ADD CONSTRAINT "payment_mandates_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cart_mandates_hash_idx" ON "cart_mandates" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "cart_mandates_agent_idx" ON "cart_mandates" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "intent_mandates_hash_idx" ON "intent_mandates" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "intent_mandates_agent_idx" ON "intent_mandates" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_mandates_hash_idx" ON "payment_mandates" USING btree ("hash");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_mandates_agent_idempotency_idx" ON "payment_mandates" USING btree ("agent_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_order_idx" ON "receipts" USING btree ("order_id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
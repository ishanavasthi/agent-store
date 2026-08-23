import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { AUDIT_EVENT_TYPES } from '../domain/auditEvents.js';

/**
 * Schema notes that outlive T1:
 *
 * - Money columns are `integer` paise and are always named `*PricePaise` /
 *   `*AmountPaise`. There is no numeric/decimal column anywhere (CONTEXT.md →
 *   Money).
 * - Razorpay's identifiers are always `gateway*`; the unqualified `orderId`
 *   belongs to our domain Order (CONTEXT.md → Order vs Gateway order).
 * - `auditEvents` is append-only: no code path updates or deletes a row, and
 *   migration 0001 installs a trigger that refuses UPDATE/DELETE at the
 *   database (ADR-0003).
 */

export const productStatus = pgEnum('product_status', [
  'draft',
  'needs_confirmation',
  'published',
]);

/**
 * Order lifecycle for T1. `awaiting_payment` is the state the Order sits in
 * while the human decides on the hosted Payment Link — the consent step.
 * `cancelled` / `refunded` are reached by the rehearsed failures (T-later);
 * declared now so the enum does not need a migration to gain them.
 */
export const orderStatus = pgEnum('order_status', [
  'created',
  'awaiting_payment',
  'paid',
  'cancelled',
  'refunded',
]);

export const auditEventType = pgEnum('audit_event_type', AUDIT_EVENT_TYPES);

export const merchants = pgTable('merchants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const products = pgTable(
  'products',
  {
    id: text('id').primaryKey(),
    merchantId: text('merchant_id')
      .notNull()
      .references(() => merchants.id),
    title: text('title').notNull(),
    description: text('description'),
    status: productStatus('status').notNull().default('draft'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('products_merchant_status_idx').on(table.merchantId, table.status)],
);

/**
 * The sellable unit (CONTEXT.md → Variant). Every Product has at least one, so
 * checkout never branches on "has variants?" — a product with no stated
 * size/colour gets one row with `isDefault = true` and a null label.
 */
export const variants = pgTable(
  'variants',
  {
    id: text('id').primaryKey(),
    productId: text('product_id')
      .notNull()
      .references(() => products.id),
    /** e.g. "M / Black". Null on the implicit default Variant. */
    label: text('label'),
    isDefault: boolean('is_default').notNull().default(false),
    pricePaise: integer('price_paise').notNull(),
    currency: text('currency').notNull().default('INR'),
    stock: integer('stock').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('variants_product_idx').on(table.productId)],
);

export const orders = pgTable(
  'orders',
  {
    id: text('id').primaryKey(),
    merchantId: text('merchant_id')
      .notNull()
      .references(() => merchants.id),
    variantId: text('variant_id')
      .notNull()
      .references(() => variants.id),
    quantity: integer('quantity').notNull(),
    /** Unit price snapshotted at checkout, so a later catalog edit cannot rewrite history. */
    unitPricePaise: integer('unit_price_paise').notNull(),
    amountPaise: integer('amount_paise').notNull(),
    currency: text('currency').notNull().default('INR'),
    status: orderStatus('status').notNull().default('created'),

    /** Razorpay's objects — always qualified, never a bare `orderId`. */
    gatewayOrderId: text('gateway_order_id'),
    gatewayPaymentId: text('gateway_payment_id'),
    gatewayPaymentLinkId: text('gateway_payment_link_id'),
    paymentLinkUrl: text('payment_link_url'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
  },
  (table) => [
    index('orders_merchant_idx').on(table.merchantId),
    uniqueIndex('orders_gateway_order_id_idx').on(table.gatewayOrderId),
    uniqueIndex('orders_gateway_payment_link_id_idx').on(table.gatewayPaymentLinkId),
  ],
);

/**
 * Append-only (ADR-0003). `seq` is the ordering the audit chain is read back in;
 * timestamps are not, because events written in one transaction share a time.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    merchantId: text('merchant_id')
      .notNull()
      .references(() => merchants.id),
    /** Null for events that could not be attributed to a domain Order. */
    orderId: text('order_id').references(() => orders.id),
    type: auditEventType('type').notNull(),
    payload: jsonb('payload').notNull().default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('audit_events_order_seq_idx').on(table.orderId, table.seq)],
);

/**
 * Enum unions derived from the pgEnums, so a status is never widened to
 * `string` on its way out of the database and into a view.
 */
export type ProductStatus = (typeof productStatus.enumValues)[number];
export type OrderStatus = (typeof orderStatus.enumValues)[number];

export type MerchantRow = typeof merchants.$inferSelect;
export type ProductRow = typeof products.$inferSelect;
export type VariantRow = typeof variants.$inferSelect;
export type OrderRow = typeof orders.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;

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
import type { ProductExtractionRecord } from '../ingestion/extractionRecord.js';

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
  /**
   * The Merchant's own Ed25519 signing keypair (CONTEXT.md → Merchant: "a
   * first-class entity owning a catalog and a signing key"), stored as base64
   * DER — SPKI public, PKCS8 private (see `src/domain/keys.ts`). Nullable
   * because rows predate the key; `ensureMerchantSigningKey` mints it
   * idempotently at seed time. T4's Receipts are signed with it.
   */
  signingPublicKey: text('signing_public_key'),
  signingPrivateKey: text('signing_private_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * An Agent IS its registration (ADR-0001): one custodial Ed25519 keypair plus
 * one bearer token plus one buyer-declared Cap, minted together by
 * `register_agent` and immutable for the registration's lifetime — hence no
 * `updatedAt`. Re-registering inserts a new row; nothing ever links two rows to
 * "the same buyer". The Cap is per Agent×Merchant (CONTEXT.md → Cap), which is
 * why the ceiling lives here rather than in config.
 */
export const agents = pgTable(
  'agents',
  {
    id: text('id').primaryKey(),
    merchantId: text('merchant_id')
      .notNull()
      .references(() => merchants.id),
    /** Bearer token the Agent presents on every tool call (`agt_tok_…`). */
    token: text('token').notNull(),
    /**
     * The Agent's Ed25519 key material, base64 DER (ADR-0004, split custody).
     * Custodial Agents (connector buyers) store the whole keypair and the
     * server signs on their behalf (T4). Client-custody Agents (the SDK buyer,
     * T6) registered with their own public key: `private_key` is NULL, the
     * server never held it, and every agent signature arrives from the client.
     * `private_key IS NULL` ⇔ client custody — there is no separate flag.
     */
    publicKey: text('public_key').notNull(),
    privateKey: text('private_key'),
    /** The buyer-declared spend ceiling for this registration. Integer paise. */
    capPaise: integer('cap_paise').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('agents_token_idx').on(table.token),
    index('agents_merchant_idx').on(table.merchantId),
  ],
);

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
    /**
     * How ingestion read this Product's fields — per-field values, confidences
     * and hold reasons (T12). Null for hand-seeded rows that never went through
     * extraction. T13's confirmation screen renders this; checkout never reads
     * it — the numbers money trusts live in the `variants` columns.
     */
    extraction: jsonb('extraction').$type<ProductExtractionRecord>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('products_merchant_status_idx').on(table.merchantId, table.status)],
);

/**
 * The sellable unit (CONTEXT.md → Variant). Every Product has at least one, so
 * checkout never branches on "has variants?" — a product with no stated
 * size/colour gets one row with `isDefault = true` and a null label.
 *
 * `pricePaise` and `stock` are nullable since T12: a Variant belonging to a
 * Product in `needs-confirmation` may honestly not know them yet — the caption
 * never stated a count, or stated a total the merchant still has to split
 * across sizes — and writing a defaulted number would be fiction in exactly
 * the columns checkout and the oversell check trust. The invariant, enforced
 * by the ingestion gate and asserted in `domain/catalog.ts`: **every Variant
 * of a `published` Product has non-null price and stock.**
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
    pricePaise: integer('price_paise'),
    currency: text('currency').notNull().default('INR'),
    stock: integer('stock'),
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
    /**
     * The registered Agent the Order was created for. Nullable because pre-T4
     * rows predate agent-backed checkout; the cumulative Cap math (T5's
     * OVER_CAP) sums per Agent×Merchant over these rows, non-cancelled and
     * non-refunded statuses counting.
     */
    agentId: text('agent_id').references(() => agents.id),
    /**
     * Legacy single-variant shape (T1). Nullable since T4: line items live in
     * `orderItems` and these stay only for rows that predate it. The Order's
     * `amountPaise` remains the authoritative total either way.
     */
    variantId: text('variant_id').references(() => variants.id),
    quantity: integer('quantity'),
    /** Unit price snapshotted at checkout, so a later catalog edit cannot rewrite history. */
    unitPricePaise: integer('unit_price_paise'),
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
 * One purchased line of an Order (CONTEXT.md → Cart mandate: "Variant-level
 * items", plural). Introduced in T4 because a Cart mandate carries N items
 * while the legacy `orders` columns carried exactly one. `orders.amountPaise`
 * stays the authoritative total; these rows are the breakdown.
 */
export const orderItems = pgTable(
  'order_items',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id),
    variantId: text('variant_id')
      .notNull()
      .references(() => variants.id),
    quantity: integer('quantity').notNull(),
    /** Unit price snapshotted from the Cart mandate, not re-read from the catalog. */
    unitPricePaise: integer('unit_price_paise').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('order_items_order_idx').on(table.orderId)],
);

/**
 * The mandate tables — insert-only records of *immutable signed artifacts*.
 *
 * ADR-0002 forbids a mutable draft cart, not storage of signed mandates: no
 * code path updates a mandate row's payload or signatures — with exactly one
 * sanctioned exception: a client-custody Agent's deferred Cart signature is
 * filled NULL → value at payment time, after verification, under an `IS NULL`
 * guard (ADR-0004). Each `payload` jsonb is the exact canonical-signed
 * payload; signatures are base64 text stored alongside it, never inside it
 * (signing a payload containing its own signature would be circular). `hash`
 * is sha256 of the canonical payload and is how chain links resolve — Cart
 * embeds the Intent's hash, Payment embeds the Cart's (CONTEXT.md → Mandate
 * chain).
 */

/** Root of the chain: Agent-signed want + Budget (CONTEXT.md → Intent mandate). */
export const intentMandates = pgTable(
  'intent_mandates',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    merchantId: text('merchant_id')
      .notNull()
      .references(() => merchants.id),
    payload: jsonb('payload').notNull(),
    hash: text('hash').notNull(),
    /** The per-Intent spend ceiling (Budget, never "limit"/"quota"). Integer paise. */
    budgetPaise: integer('budget_paise').notNull(),
    agentSignature: text('agent_signature').notNull(),
    /**
     * The INTENT_CONSUMED marker (T5): an Intent is consumed by the first
     * Cart mandate that passes the trust gate. `submit_payment` writes it in
     * the order-insert transaction under a `WHERE consumed_by_order_id IS
     * NULL` guard (the house exactly-once pattern — guards live in the SQL,
     * not in a read-then-write); zero rows updated rolls the Order back.
     */
    consumedByOrderId: text('consumed_by_order_id').references(() => orders.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('intent_mandates_hash_idx').on(table.hash),
    index('intent_mandates_agent_idx').on(table.agentId),
  ],
);

/**
 * Both-sides-signed immutable snapshot of items + total + price hash
 * (CONTEXT.md → Cart mandate). Deliberately NO status column: unpaid Cart
 * mandates coexist freely and nothing ever invalidates one (ADR-0002).
 */
export const cartMandates = pgTable(
  'cart_mandates',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    merchantId: text('merchant_id')
      .notNull()
      .references(() => merchants.id),
    /** sha256 of the Intent mandate this cart was created under — the chain link. */
    intentHash: text('intent_hash').notNull(),
    payload: jsonb('payload').notNull(),
    hash: text('hash').notNull(),
    totalAmountPaise: integer('total_amount_paise').notNull(),
    /** Pin of the priced items; payment-time recompute mismatch → PRICE_CHANGED. */
    priceHash: text('price_hash').notNull(),
    /**
     * NULL only for a client-custody Agent's cart until it is paid (ADR-0004):
     * the server composes the Cart but never signs for such an Agent, so the
     * Agent's signature arrives with submit_payment, is verified against the
     * Agent's public key at the trust gate, and is persisted here (NULL →
     * value, exactly once, in the order transaction). The payload and the
     * merchant signature stay immutable as ever.
     */
    agentSignature: text('agent_signature'),
    merchantSignature: text('merchant_signature').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('cart_mandates_hash_idx').on(table.hash),
    index('cart_mandates_agent_idx').on(table.agentId),
  ],
);

/**
 * Agent-signed authorization to pay one Cart mandate by hash, carrying the
 * buyer-minted idempotency key (CONTEXT.md → Payment mandate).
 */
export const paymentMandates = pgTable(
  'payment_mandates',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    merchantId: text('merchant_id')
      .notNull()
      .references(() => merchants.id),
    /** sha256 of the Cart mandate being paid — the chain link. */
    cartHash: text('cart_hash').notNull(),
    /** Buyer-minted, scoped Agent×Merchant (DECISIONS 2026-08-23 idempotency). */
    idempotencyKey: text('idempotency_key').notNull(),
    payload: jsonb('payload').notNull(),
    hash: text('hash').notNull(),
    agentSignature: text('agent_signature').notNull(),
    /** The Order this authorization produced, once verification passed. */
    orderId: text('order_id').references(() => orders.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('payment_mandates_hash_idx').on(table.hash),
    /**
     * One idempotency key, one Payment mandate, per Agent. `submit_payment`
     * checks the key up front (replay / IDEMPOTENCY_REUSE); this index is the
     * race backstop that makes the rule hold in SQL, not just app logic.
     */
    uniqueIndex('payment_mandates_agent_idempotency_idx').on(
      table.agentId,
      table.idempotencyKey,
    ),
  ],
);

/**
 * Merchant-signed proof of a paid Order: all three mandate hashes, amount,
 * gateway payment id (CONTEXT.md → Receipt). A separate table rather than
 * columns on `orders` — a T-later refund receipt can reference the original.
 * `orderId` is unique: one Receipt per Order, minted exactly once in the same
 * transaction as `order.paid`.
 */
export const receipts = pgTable(
  'receipts',
  {
    id: text('id').primaryKey(),
    merchantId: text('merchant_id')
      .notNull()
      .references(() => merchants.id),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id),
    payload: jsonb('payload').notNull(),
    hash: text('hash').notNull(),
    merchantSignature: text('merchant_signature').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('receipts_order_idx').on(table.orderId)],
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
export type AgentRow = typeof agents.$inferSelect;
export type ProductRow = typeof products.$inferSelect;
export type VariantRow = typeof variants.$inferSelect;
export type OrderRow = typeof orders.$inferSelect;
export type OrderItemRow = typeof orderItems.$inferSelect;
export type IntentMandateRow = typeof intentMandates.$inferSelect;
export type CartMandateRow = typeof cartMandates.$inferSelect;
export type PaymentMandateRow = typeof paymentMandates.$inferSelect;
export type ReceiptRow = typeof receipts.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;

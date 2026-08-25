import { and, asc, eq, isNull, ne, type SQL } from 'drizzle-orm';
import type { Database, Executor } from '../db/client.js';
import {
  cartMandates,
  merchants,
  orderItems,
  orders,
  paymentMandates,
  products,
  receipts,
  variants,
  type OrderRow,
  type OrderStatus,
} from '../db/schema.js';
import type { GatewayWebhookEvent } from '../gateway/types.js';
import { namespaceGatewayEvent, type AnomalyReason } from './auditEvents.js';
import { appendAuditEvent } from './auditLog.js';
import { newId } from './ids.js';
import { hashMandate, signMandate, type ReceiptPayload } from './mandates.js';
import { moneyView, paise, type MoneyView } from './money.js';

/**
 * Domain Order reads, and the one write that money depends on: marking an
 * Order paid — and minting its merchant-signed Receipt — when a verified
 * gateway webhook says so.
 */

export async function findOrderById(
  executor: Executor,
  merchantId: string,
  orderId: string,
): Promise<OrderRow | null> {
  const rows = await executor
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.merchantId, merchantId)))
    .limit(1);
  return rows[0] ?? null;
}

/** How a webhook was attributed to an Order, strongest first. */
export type WebhookMatchStrategy = 'reference' | 'gateway_payment_link_id' | 'gateway_order_id';

export interface WebhookMatch {
  readonly order: OrderRow;
  readonly matchedBy: WebhookMatchStrategy;
  /** More than one Order matched. Fail closed rather than pick one. */
  readonly ambiguous: boolean;
}

/**
 * Find the Order a webhook is about, deterministically.
 *
 * Strategies are tried in strict priority order rather than OR-ed into one
 * query: an OR with `LIMIT 1` and no `ORDER BY` lets the planner decide which
 * Order gets marked paid, which is not a decision a query planner should be
 * making. `reference` wins because it is our own domain Order id, echoed back
 * from a field we set ourselves.
 *
 * Two rows are fetched, not one, so a multi-match is *detected* rather than
 * silently resolved; the ordering makes the first row stable either way.
 */
export async function findOrderForWebhook(
  executor: Executor,
  merchantId: string,
  event: GatewayWebhookEvent,
): Promise<WebhookMatch | null> {
  const strategies: readonly { readonly by: WebhookMatchStrategy; readonly where: SQL }[] = [
    ...(event.reference === null
      ? []
      : [{ by: 'reference' as const, where: eq(orders.id, event.reference) }]),
    ...(event.gatewayPaymentLinkId === null
      ? []
      : [
          {
            by: 'gateway_payment_link_id' as const,
            where: eq(orders.gatewayPaymentLinkId, event.gatewayPaymentLinkId),
          },
        ]),
    ...(event.gatewayOrderId === null
      ? []
      : [
          {
            by: 'gateway_order_id' as const,
            where: eq(orders.gatewayOrderId, event.gatewayOrderId),
          },
        ]),
  ];

  for (const strategy of strategies) {
    const rows = await executor
      .select()
      .from(orders)
      .where(and(eq(orders.merchantId, merchantId), strategy.where))
      .orderBy(asc(orders.createdAt), asc(orders.id))
      .limit(2);

    const first = rows[0];
    if (first !== undefined) {
      return { order: first, matchedBy: strategy.by, ambiguous: rows.length > 1 };
    }
  }

  return null;
}

export interface OrderStatusView {
  readonly orderId: string;
  readonly status: OrderStatus;
  readonly total: MoneyView;
  /** Null on multi-item Orders (T4): the legacy single-variant columns are unset there. */
  readonly quantity: number | null;
  readonly gatewayOrderId: string | null;
  readonly gatewayPaymentId: string | null;
  readonly gatewayPaymentLinkId: string | null;
  readonly paymentLinkUrl: string | null;
  readonly createdAt: string;
  readonly paidAt: string | null;
}

export function toOrderStatusView(row: OrderRow): OrderStatusView {
  return {
    orderId: row.id,
    status: row.status,
    total: moneyView(paise(row.amountPaise)),
    quantity: row.quantity,
    gatewayOrderId: row.gatewayOrderId,
    gatewayPaymentId: row.gatewayPaymentId,
    gatewayPaymentLinkId: row.gatewayPaymentLinkId,
    paymentLinkUrl: row.paymentLinkUrl,
    createdAt: row.createdAt.toISOString(),
    paidAt: row.paidAt === null ? null : row.paidAt.toISOString(),
  };
}

export type WebhookOutcome =
  | { readonly result: 'order_paid'; readonly orderId: string }
  | { readonly result: 'already_paid'; readonly orderId: string }
  | { readonly result: 'recorded'; readonly orderId: string }
  | { readonly result: 'anomaly'; readonly orderId: string; readonly reason: AnomalyReason }
  | { readonly result: 'unmatched'; readonly orderId: null };

/**
 * Apply an *already-signature-verified* gateway webhook.
 *
 * Both the `gateway.webhook_received` event and any resulting state change
 * commit in one transaction (ADR-0003), so the log can never show a payment
 * arriving without showing what it did — or vice versa.
 *
 * Fail-closed, in three places. An Order is **not** marked paid when:
 *   - more than one Order matched the webhook,
 *   - the webhook reports a gateway order id different from one already
 *     recorded (the payment may have hit a different object),
 *   - the webhook's amount is missing, or differs from the Order's amount.
 * Each case writes an `order.anomaly_detected` event and leaves the Order
 * exactly as it was. Nothing is ever silently overwritten or swallowed.
 *
 * Idempotent by design: Razorpay sends both `payment_link.paid` and
 * `payment.captured` for one purchase and redelivers on any non-2xx, so
 * re-entry must be free. The `UPDATE ... WHERE status <> 'paid'` guard is what
 * makes "paid" a one-way transition rather than a repeated one.
 */
export async function applyGatewayWebhook(
  db: Database,
  merchantId: string,
  event: GatewayWebhookEvent,
  gatewayName: string,
): Promise<WebhookOutcome> {
  const gatewayEvent = namespaceGatewayEvent(gatewayName, event.rawEvent);
  const match = await findOrderForWebhook(db, merchantId, event);

  if (match === null) {
    // Nothing to attribute it to — most likely an event for another deployment
    // sharing the test account. Recorded, but not against an Order.
    await db.transaction(async (tx) => {
      await appendAuditEvent(tx, {
        type: 'gateway.webhook_received',
        merchantId,
        orderId: null,
        payload: {
          gateway: gatewayName,
          gatewayEvent,
          kind: event.kind,
          matched: false,
          reference: event.reference,
          gatewayOrderId: event.gatewayOrderId,
          gatewayPaymentId: event.gatewayPaymentId,
        },
      });
    });
    return { result: 'unmatched', orderId: null };
  }

  const { order } = match;

  return db.transaction(async (tx) => {
    const anomaly = async (
      reason: AnomalyReason,
      detail: Record<string, unknown>,
    ): Promise<WebhookOutcome> => {
      await appendAuditEvent(tx, {
        type: 'order.anomaly_detected',
        merchantId,
        orderId: order.id,
        payload: { gateway: gatewayName, gatewayEvent, reason, ...detail },
      });
      return { result: 'anomaly', orderId: order.id, reason };
    };

    await appendAuditEvent(tx, {
      type: 'gateway.webhook_received',
      merchantId,
      orderId: order.id,
      payload: {
        gateway: gatewayName,
        gatewayEvent,
        kind: event.kind,
        matched: true,
        matchedBy: match.matchedBy,
        gatewayOrderId: event.gatewayOrderId,
        gatewayPaymentId: event.gatewayPaymentId,
        gatewayPaymentLinkId: event.gatewayPaymentLinkId,
        webhookAmountPaise: event.amountPaise,
      },
    });

    if (match.ambiguous) {
      return anomaly('ambiguous_webhook_match', { matchedBy: match.matchedBy });
    }

    // --- Learn the real gateway order id, exactly once ----------------------
    // Razorpay fires several webhooks for one purchase (payment_link.paid,
    // payment.captured, order.paid) effectively at once. Testing the value read
    // earlier in this transaction and then writing unconditionally is a
    // read-then-write race: every concurrent webhook sees NULL and every one of
    // them links, producing one `order_linked` event per webhook for a single
    // real linking. The guard therefore lives in the WHERE clause, exactly as
    // it does for the paid transition below: under READ COMMITTED the losers
    // block on the row lock, re-evaluate `IS NULL` after the winner commits,
    // and match nothing.
    if (event.gatewayOrderId !== null) {
      const [linked] = await tx
        .update(orders)
        .set({ gatewayOrderId: event.gatewayOrderId, updatedAt: new Date() })
        .where(and(eq(orders.id, order.id), isNull(orders.gatewayOrderId)))
        .returning();

      if (linked !== undefined) {
        await appendAuditEvent(tx, {
          type: 'gateway.order_linked',
          merchantId,
          orderId: order.id,
          payload: { gateway: gatewayName, gatewayEvent, gatewayOrderId: event.gatewayOrderId },
        });
      } else {
        // Already linked — by an earlier webhook or a concurrent one. Re-read
        // rather than trusting the stale snapshot, so a genuine conflict is
        // still caught. Never overwrite: a second, different gateway order for
        // one domain Order means we do not know which object the money hit.
        const current = await tx.query.orders.findFirst({ where: eq(orders.id, order.id) });
        if (current !== undefined && current.gatewayOrderId !== event.gatewayOrderId) {
          return anomaly('gateway_order_id_conflict', {
            recordedGatewayOrderId: current.gatewayOrderId,
            webhookGatewayOrderId: event.gatewayOrderId,
          });
        }
      }
    }

    if (event.kind !== 'payment_succeeded') {
      // T-later: a Decline drives the bounded-retry / fail-closed path (PLAN §5.6).
      return { result: 'recorded', orderId: order.id } as const;
    }

    // --- Assert the amount before any money is acknowledged -----------------
    if (event.amountPaise === null) {
      return anomaly('amount_missing', { expectedAmountPaise: order.amountPaise });
    }
    if (event.amountPaise !== order.amountPaise) {
      return anomaly('amount_mismatch', {
        expectedAmountPaise: order.amountPaise,
        webhookAmountPaise: event.amountPaise,
      });
    }

    const paidAt = new Date();
    const updated = await tx
      .update(orders)
      .set({
        status: 'paid',
        paidAt,
        updatedAt: paidAt,
        ...(event.gatewayPaymentId === null ? {} : { gatewayPaymentId: event.gatewayPaymentId }),
      })
      .where(
        and(eq(orders.id, order.id), eq(orders.merchantId, merchantId), ne(orders.status, 'paid')),
      )
      .returning({ id: orders.id });

    if (updated.length === 0) {
      // Already paid by an earlier delivery of this or a sibling event. No
      // second `order.paid` is written: the transition happened exactly once.
      return { result: 'already_paid', orderId: order.id } as const;
    }

    await appendAuditEvent(tx, {
      type: 'order.paid',
      merchantId,
      orderId: order.id,
      payload: {
        gateway: gatewayName,
        gatewayEvent,
        gatewayPaymentId: event.gatewayPaymentId,
        gatewayOrderId: event.gatewayOrderId,
        // The amount the *gateway* reported, which is what was actually paid.
        // It equalled the Order's amount — that is asserted above, not assumed.
        amountPaise: event.amountPaise,
        currency: order.currency,
        paidAt: paidAt.toISOString(),
      },
    });

    // --- Mint the merchant-signed Receipt, exactly once ---------------------
    // Guarded by the one-way paid UPDATE above: only the delivery that won the
    // `status <> 'paid'` transition reaches this line, so Razorpay's
    // near-simultaneous sibling webhooks (see engineering log) can never mint
    // a second Receipt — the `already_paid` branch returned before it. Same
    // transaction as `order.paid` (ADR-0003). Receipts exist only for
    // mandate-backed Orders; a pre-T4 Order has no chain to prove, so it gets
    // none (DECISIONS 2026-08-26).
    const [paymentMandate] = await tx
      .select()
      .from(paymentMandates)
      .where(eq(paymentMandates.orderId, order.id))
      .limit(1);
    if (paymentMandate !== undefined) {
      const [merchantRow] = await tx
        .select({ signingPrivateKey: merchants.signingPrivateKey })
        .from(merchants)
        .where(eq(merchants.id, merchantId))
        .limit(1);
      if (merchantRow === undefined || merchantRow.signingPrivateKey === null) {
        // The Order IS paid — that already committed above and stands. What
        // cannot happen is the signed proof, and a webhook handler must not
        // throw for it (redelivery would fix nothing). Recorded loudly instead.
        await appendAuditEvent(tx, {
          type: 'order.anomaly_detected',
          merchantId,
          orderId: order.id,
          payload: {
            gateway: gatewayName,
            gatewayEvent,
            reason: 'missing_merchant_signing_key' satisfies AnomalyReason,
            detail: 'Order paid but no merchant signing key exists to mint its Receipt',
          },
        });
      } else {
        const [cartRow] = await tx
          .select({ intentHash: cartMandates.intentHash })
          .from(cartMandates)
          .where(eq(cartMandates.hash, paymentMandate.cartHash))
          .limit(1);
        if (cartRow === undefined) {
          // Impossible by construction: submit_payment only stores a Payment
          // mandate after resolving its Cart row. A miss means the mandate
          // store was mutilated out-of-band — fail loudly, don't sign fiction.
          throw new Error(
            `Payment mandate ${paymentMandate.id} references no stored Cart mandate ${paymentMandate.cartHash}`,
          );
        }
        const receiptPayload: ReceiptPayload = {
          orderId: order.id,
          intentHash: cartRow.intentHash,
          cartHash: paymentMandate.cartHash,
          paymentHash: paymentMandate.hash,
          // The gateway-reported amount — asserted equal to the Order's above.
          amountPaise: paise(event.amountPaise),
          gatewayPaymentId: event.gatewayPaymentId ?? order.gatewayPaymentId ?? '',
          issuedAt: paidAt.toISOString(),
        };
        const receiptHash = hashMandate(receiptPayload);
        const merchantSignature = signMandate(merchantRow.signingPrivateKey, receiptPayload);
        await tx.insert(receipts).values({
          id: newId('receipt'),
          merchantId,
          orderId: order.id,
          payload: receiptPayload,
          hash: receiptHash,
          merchantSignature,
        });
        await appendAuditEvent(tx, {
          type: 'receipt.issued',
          merchantId,
          orderId: order.id,
          payload: {
            receiptHash,
            intentHash: receiptPayload.intentHash,
            cartHash: receiptPayload.cartHash,
            paymentHash: receiptPayload.paymentHash,
            amountPaise: receiptPayload.amountPaise,
            gatewayPaymentId: receiptPayload.gatewayPaymentId,
          },
        });
      }
    }

    return { result: 'order_paid', orderId: order.id } as const;
  });
}

/** One purchased line of an Order, as `get_order_status` reports it. */
export interface OrderItemView {
  readonly variantId: string;
  readonly productTitle: string;
  readonly label: string | null;
  readonly quantity: number;
  readonly unitPrice: MoneyView;
}

/**
 * An Order's line items, joined to their catalog rows for display. Deliberately
 * NOT filtered to `published`: a purchase already made must keep reporting what
 * it bought even after the merchant unpublishes the product.
 */
export async function listOrderItems(
  executor: Executor,
  orderId: string,
): Promise<OrderItemView[]> {
  const rows = await executor
    .select({
      variantId: orderItems.variantId,
      productTitle: products.title,
      label: variants.label,
      quantity: orderItems.quantity,
      unitPricePaise: orderItems.unitPricePaise,
    })
    .from(orderItems)
    .innerJoin(variants, eq(orderItems.variantId, variants.id))
    .innerJoin(products, eq(variants.productId, products.id))
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.variantId));
  return rows.map((row) => ({
    variantId: row.variantId,
    productTitle: row.productTitle,
    label: row.label,
    quantity: row.quantity,
    unitPrice: moneyView(paise(row.unitPricePaise)),
  }));
}

/**
 * The Receipt as the buyer retrieves it: payload, detached merchant signature,
 * and the merchant public key — everything an independent verifier needs
 * (`verifyMessage(merchantPublicKey, canonicalJson(payload), signature)`),
 * because no other endpoint publishes the key yet.
 */
export interface OrderReceiptView {
  readonly payload: ReceiptPayload;
  readonly signature: string;
  readonly merchantPublicKey: string;
}

export async function findOrderReceipt(
  executor: Executor,
  merchantId: string,
  orderId: string,
): Promise<OrderReceiptView | null> {
  const rows = await executor
    .select({
      payload: receipts.payload,
      signature: receipts.merchantSignature,
      merchantPublicKey: merchants.signingPublicKey,
    })
    .from(receipts)
    .innerJoin(merchants, eq(receipts.merchantId, merchants.id))
    .where(and(eq(receipts.orderId, orderId), eq(receipts.merchantId, merchantId)))
    .limit(1);
  const row = rows[0];
  if (row === undefined || row.merchantPublicKey === null) return null;
  return {
    payload: row.payload as ReceiptPayload,
    signature: row.signature,
    merchantPublicKey: row.merchantPublicKey,
  };
}

import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StorefrontDeps } from '../deps.js';
import { agents, auditEvents, orders, receipts, type AgentRow } from '../db/schema.js';
import { StubGateway, type SyntheticWebhook } from '../gateway/stubGateway.js';
import { registerAgent } from './agents.js';
import { createCart, declareIntent } from './mandateFlow.js';
import {
  applyGatewayWebhook,
  findOrderById,
  toOrderStatusView,
  type WebhookOutcome,
} from './orders.js';
import { submitPayment, type SubmitPaymentResult } from '../domain/submitPayment.js';
import { createTestDatabase, type TestDatabaseHandle } from '../testSupport/pgliteDatabase.js';
import { MERCHANT_ID, seedCatalog } from '../testSupport/seedCatalog.js';

/**
 * T8's acceptance proof (issue #9, PLAN §5.6 failure 1): decline → exactly one
 * bounded retry → fail closed. The gateway is allowed to say no twice; the
 * second distinct failure cancels the Order with a structured reason, zero
 * charge — and the buyer's answer is a Decline, never a Refusal.
 *
 * Webhook delivery mirrors `http/app.ts`'s route exactly, as the T2 suite does:
 * verify signature over the raw bytes, parse, then `applyGatewayWebhook`.
 */

async function deliver(deps: StorefrontDeps, hook: SyntheticWebhook): Promise<WebhookOutcome> {
  expect(deps.gateway.verifyWebhookSignature(hook.rawBody, hook.signature)).toBe(true);
  const event = deps.gateway.parseWebhookEvent(hook.rawBody);
  return applyGatewayWebhook(deps.db, deps.merchantId, event, deps.gateway.name);
}

async function registeredAgent(deps: StorefrontDeps): Promise<AgentRow> {
  const registration = await registerAgent(deps.db, MERCHANT_ID, { capPaise: 500000 });
  const [row] = await deps.db.select().from(agents).where(eq(agents.id, registration.agentId));
  return row!;
}

async function placeOrder(deps: StorefrontDeps, agent: AgentRow): Promise<SubmitPaymentResult> {
  const intent = await declareIntent(deps.db, agent, { want: 'one tee', budgetPaise: 200000 });
  const cart = await createCart(deps.db, agent, {
    intentHash: intent.intentHash,
    items: [{ variantId: 'var_test_tee_default', quantity: 1 }],
  });
  return submitPayment(deps, agent, { cartHash: cart.cartHash, idempotencyKey: randomUUID() });
}

async function auditTypes(deps: StorefrontDeps, orderId: string) {
  const chain = await deps.db
    .select({ type: auditEvents.type, payload: auditEvents.payload })
    .from(auditEvents)
    .where(eq(auditEvents.orderId, orderId))
    .orderBy(asc(auditEvents.seq));
  return chain;
}

describe('T8: decline, bounded retry, fail closed', () => {
  let handle: TestDatabaseHandle;
  let gateway: StubGateway;
  let deps: StorefrontDeps;

  beforeEach(async () => {
    handle = await createTestDatabase();
    gateway = new StubGateway();
    deps = {
      db: handle.db,
      gateway,
      merchantId: MERCHANT_ID,
      publicBaseUrl: 'https://merchant.example',
    };
    await seedCatalog(deps.db, 3);
  });

  afterEach(async () => {
    await handle.close();
  });

  it('decline → retry declined → Order cancelled with a structured Decline, zero charge', async () => {
    const agent = await registeredAgent(deps);
    const result = await placeOrder(deps, agent);

    // Attempt 1 fails: counted, one bounded retry remains, the Order still waits.
    const first = await deliver(deps, gateway.failPayment(result.gatewayPaymentLinkId)[0]!);
    expect(first).toEqual({
      result: 'decline_recorded',
      orderId: result.orderId,
      attempt: 1,
      retriesRemaining: 1,
    });
    const afterFirst = await findOrderById(deps.db, MERCHANT_ID, result.orderId);
    expect(afterFirst?.status).toBe('awaiting_payment');

    // Attempt 2 — the one bounded retry — also fails: the Order fails closed.
    const second = await deliver(deps, gateway.failPayment(result.gatewayPaymentLinkId)[0]!);
    expect(second).toMatchObject({
      result: 'order_cancelled',
      orderId: result.orderId,
      decline: { kind: 'decline', code: 'PAYMENT_DECLINED', attempts: 2 },
    });

    // Zero charge, structurally: never paid, no gateway payment captured, no
    // Receipt minted, and the cancellation is stamped on the row.
    const order = await findOrderById(deps.db, MERCHANT_ID, result.orderId);
    expect(order?.status).toBe('cancelled');
    expect(order?.paidAt).toBeNull();
    expect(order?.gatewayPaymentId).toBeNull();
    expect(order?.cancelledAt).not.toBeNull();
    expect(await deps.db.select().from(receipts)).toHaveLength(0);

    // The buyer's answer (get_order_status view) is a Decline, never a Refusal:
    // `kind: 'decline'`, no `recoverable`, structured reason attached.
    const view = toOrderStatusView(order!);
    expect(view.status).toBe('cancelled');
    expect(view.decline).toMatchObject({
      kind: 'decline',
      code: 'PAYMENT_DECLINED',
      attempts: 2,
      gatewayErrorCode: 'BAD_REQUEST_ERROR',
    });
    expect(view.decline).not.toHaveProperty('recoverable');
    expect(view.cancelledAt).not.toBeNull();

    // The full sequence is in the audit trail: both declines and the
    // cancellation, each in the same transaction as its state change.
    const chain = await auditTypes(deps, result.orderId);
    expect(chain.map((e) => e.type)).toEqual([
      'payment.verified',
      'order.created',
      'gateway.payment_link_attempted',
      'gateway.payment_link_issued',
      'gateway.webhook_received',
      'gateway.order_linked',
      'payment.declined',
      'gateway.webhook_received',
      'payment.declined',
      'order.cancelled',
    ]);
    expect(chain[6]!.payload).toMatchObject({
      attempt: 1,
      attemptLimit: 2,
      retriesRemaining: 1,
      gatewayPaymentId: 'pay_stub_1_fail1',
      gatewayErrorCode: 'BAD_REQUEST_ERROR',
    });
    expect(chain[8]!.payload).toMatchObject({
      attempt: 2,
      retriesRemaining: 0,
      gatewayPaymentId: 'pay_stub_1_fail2',
    });
    // The ledger records the exact structured reason the buyer was told.
    expect(chain[9]!.payload).toMatchObject({
      decline: { kind: 'decline', code: 'PAYMENT_DECLINED', attempts: 2 },
    });
  });

  it('a redelivered payment.failed is free — one failed payment is one attempt', async () => {
    const agent = await registeredAgent(deps);
    const result = await placeOrder(deps, agent);

    // Razorpay redelivers the same event bytes on any hiccup; the stub can
    // hand the same delivery out twice for exactly this rehearsal.
    const delivery = gateway.failPayment(result.gatewayPaymentLinkId)[0]!;
    const first = await deliver(deps, delivery);
    expect(first).toMatchObject({ result: 'decline_recorded', attempt: 1 });
    const redelivered = await deliver(deps, delivery);
    expect(redelivered).toEqual({ result: 'recorded', orderId: result.orderId });

    // Still awaiting payment — the bound counts failed payments, not deliveries.
    const order = await findOrderById(deps.db, MERCHANT_ID, result.orderId);
    expect(order?.status).toBe('awaiting_payment');
    const chain = await auditTypes(deps, result.orderId);
    expect(chain.filter((e) => e.type === 'payment.declined')).toHaveLength(1);
  });

  it('the retry that succeeds still pays the Order after one decline', async () => {
    const agent = await registeredAgent(deps);
    const result = await placeOrder(deps, agent);

    await deliver(deps, gateway.failPayment(result.gatewayPaymentLinkId)[0]!);
    const paid = await deliver(deps, gateway.completePayment(result.gatewayPaymentLinkId)[0]!);
    expect(paid).toEqual({ result: 'order_paid', orderId: result.orderId });

    const order = await findOrderById(deps.db, MERCHANT_ID, result.orderId);
    expect(order?.status).toBe('paid');
    expect(order?.cancelledAt).toBeNull();
  });

  it('after fail-closed, more failures are free and a late capture is an anomaly, never paid', async () => {
    const agent = await registeredAgent(deps);
    const result = await placeOrder(deps, agent);

    await deliver(deps, gateway.failPayment(result.gatewayPaymentLinkId)[0]!);
    await deliver(deps, gateway.failPayment(result.gatewayPaymentLinkId)[0]!);

    // A third failure changes nothing — the Order already failed closed.
    const third = await deliver(deps, gateway.failPayment(result.gatewayPaymentLinkId)[0]!);
    expect(third).toEqual({ result: 'recorded', orderId: result.orderId });

    // Money moving *after* the buyer was told "zero charge" must never flip
    // the Order paid: it is recorded as a conflict for a human instead.
    const late = await deliver(deps, gateway.completePayment(result.gatewayPaymentLinkId)[0]!);
    expect(late).toEqual({
      result: 'anomaly',
      orderId: result.orderId,
      reason: 'payment_after_cancellation',
    });

    const order = await findOrderById(deps.db, MERCHANT_ID, result.orderId);
    expect(order?.status).toBe('cancelled');
    expect(order?.paidAt).toBeNull();
    expect(await deps.db.select().from(receipts)).toHaveLength(0);
    const chain = await auditTypes(deps, result.orderId);
    expect(chain.filter((e) => e.type === 'order.cancelled')).toHaveLength(1);
    expect(chain.at(-1)!.type).toBe('order.anomaly_detected');
    expect(chain.at(-1)!.payload).toMatchObject({ reason: 'payment_after_cancellation' });
  });

  it('cancellation frees the Cap headroom the Order was holding', async () => {
    const agent = await registeredAgent(deps);
    // Cap is ₹5,000.00; the tee is ₹1,299.00, so four non-cancelled Orders
    // exhaust it. Fail one closed and the headroom comes back.
    const first = await placeOrder(deps, agent);
    await deliver(deps, gateway.failPayment(first.gatewayPaymentLinkId)[0]!);
    await deliver(deps, gateway.failPayment(first.gatewayPaymentLinkId)[0]!);

    const [row] = await deps.db.select().from(orders).where(eq(orders.id, first.orderId));
    expect(row?.status).toBe('cancelled');

    // A fresh purchase for the full remaining Cap succeeds because the
    // cancelled Order no longer counts against it (submitPayment excludes
    // cancelled/refunded from the cumulative sum).
    const intent = await declareIntent(deps.db, agent, { want: 'three tees', budgetPaise: 500000 });
    const cart = await createCart(deps.db, agent, {
      intentHash: intent.intentHash,
      items: [{ variantId: 'var_test_tee_default', quantity: 3 }],
    });
    const second = await submitPayment(deps, agent, {
      cartHash: cart.cartHash,
      idempotencyKey: randomUUID(),
    });
    expect(second.status).toBe('awaiting_payment');
    expect(second.total.amountPaise).toBe(389700);
  });
});

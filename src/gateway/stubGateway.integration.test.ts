import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StorefrontDeps } from '../deps.js';
import { agents, auditEvents, orderItems, receipts, variants, type AgentRow } from '../db/schema.js';
import { registerAgent } from '../domain/agents.js';
import { createCart, declareIntent } from '../domain/mandateFlow.js';
import { paise } from '../domain/money.js';
import { applyGatewayWebhook, findOrderById, type WebhookOutcome } from '../domain/orders.js';
import { submitPayment, type SubmitPaymentResult } from '../domain/submitPayment.js';
import { createTestDatabase, type TestDatabaseHandle } from '../testSupport/pgliteDatabase.js';
import { MERCHANT_ID, seedCatalog } from '../testSupport/seedCatalog.js';
import { StubGateway, type SyntheticWebhook } from './stubGateway.js';
import type { GatewayWebhookEvent } from './types.js';

/**
 * T2's acceptance proof: a purchase runs fully in-process — StubGateway for
 * the rails, embedded PGlite for the database — with no network calls, and
 * Declines and Oversells are scriptable on demand (issue #3). Since T4 the
 * purchase is the mandate chain (declare_intent → create_cart →
 * submit_payment); the gateway seam this file exercises is unchanged.
 *
 * Webhook delivery mirrors `http/app.ts`'s route exactly: verify signature
 * over the raw bytes, parse, then `applyGatewayWebhook`.
 */

async function deliver(deps: StorefrontDeps, hook: SyntheticWebhook): Promise<WebhookOutcome> {
  // The same three steps the webhook route performs, minus the socket.
  expect(deps.gateway.verifyWebhookSignature(hook.rawBody, hook.signature)).toBe(true);
  const event = deps.gateway.parseWebhookEvent(hook.rawBody);
  return applyGatewayWebhook(deps.db, deps.merchantId, event, deps.gateway.name);
}

/** Register an Agent and fetch its row — submitPayment signs with its custodial key. */
async function registeredAgent(deps: StorefrontDeps): Promise<AgentRow> {
  const registration = await registerAgent(deps.db, MERCHANT_ID, { capPaise: 500000 });
  const [row] = await deps.db.select().from(agents).where(eq(agents.id, registration.agentId));
  return row!;
}

/** Run the whole mandate chain up to the payment link, for one tee. */
async function placeOrder(deps: StorefrontDeps, agent: AgentRow): Promise<SubmitPaymentResult> {
  const intent = await declareIntent(deps.db, agent, { want: 'one tee', budgetPaise: 200000 });
  const cart = await createCart(deps.db, agent, {
    intentHash: intent.intentHash,
    items: [{ variantId: 'var_test_tee_default', quantity: 1 }],
  });
  return submitPayment(deps, agent, { cartHash: cart.cartHash, idempotencyKey: randomUUID() });
}

describe('in-process purchase against the stub', () => {
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
  });

  afterEach(async () => {
    await handle.close();
  });

  it('happy path: mandate chain → synthetic webhooks → Order paid, audit chain complete', async () => {
    await seedCatalog(deps.db, 3);
    const agent = await registeredAgent(deps);

    const result = await placeOrder(deps, agent);
    expect(result.status).toBe('awaiting_payment');
    expect(result.gatewayPaymentLinkId).toBe('plink_stub_1');
    expect(result.paymentLinkUrl).toBe('https://stub.invalid/pay/plink_stub_1');
    expect(result.total.amountPaise).toBe(129900);

    const hooks = gateway.completePayment(result.gatewayPaymentLinkId);
    const first = await deliver(deps, hooks[0]!);
    expect(first).toEqual({ result: 'order_paid', orderId: result.orderId });
    // Razorpay fires sibling events for one purchase; the second must be free.
    const second = await deliver(deps, hooks[1]!);
    expect(second).toEqual({ result: 'already_paid', orderId: result.orderId });

    const order = await findOrderById(deps.db, MERCHANT_ID, result.orderId);
    expect(order?.status).toBe('paid');
    expect(order?.gatewayOrderId).toBe('order_stub_1');
    expect(order?.gatewayPaymentId).toBe('pay_stub_1');
    expect(order?.paidAt).not.toBeNull();

    const chain = await deps.db
      .select({ type: auditEvents.type, payload: auditEvents.payload })
      .from(auditEvents)
      .where(eq(auditEvents.orderId, result.orderId))
      .orderBy(asc(auditEvents.seq));
    expect(chain.map((e) => e.type)).toEqual([
      'payment.verified',
      'order.created',
      'gateway.payment_link_attempted',
      'gateway.payment_link_issued',
      'gateway.webhook_received',
      'gateway.order_linked',
      'order.paid',
      'receipt.issued',
      'gateway.webhook_received',
    ]);
    // Namespaced, so the rule-auditor never meets two meanings of one spelling.
    expect((chain[4]!.payload as { gatewayEvent: string }).gatewayEvent).toBe(
      'stub:payment_link.paid',
    );
    expect((chain[6]!.payload as { gateway: string }).gateway).toBe('stub');

    // Redelivery of an already-applied success is still free — and mints no
    // second Receipt (`already_paid` returns before the minting step).
    const redelivered = await deliver(deps, hooks[0]!);
    expect(redelivered).toEqual({ result: 'already_paid', orderId: result.orderId });
    expect(await deps.db.select().from(receipts)).toHaveLength(1);
  });

  it('a success webhook with no gateway payment id pays the Order but skips the Receipt', async () => {
    await seedCatalog(deps.db, 3);
    const agent = await registeredAgent(deps);
    const result = await placeOrder(deps, agent);

    // The stub always reports a payment id, so this event is crafted directly
    // at the domain seam a parsed webhook arrives through: a success with the
    // right amount but no payment id from any source.
    const event: GatewayWebhookEvent = {
      kind: 'payment_succeeded',
      rawEvent: 'payment_link.paid',
      reference: result.orderId,
      gatewayOrderId: null,
      gatewayPaymentId: null,
      gatewayPaymentLinkId: result.gatewayPaymentLinkId,
      amountPaise: paise(129900),
    };
    const outcome = await applyGatewayWebhook(deps.db, MERCHANT_ID, event, 'stub');
    expect(outcome).toEqual({ result: 'order_paid', orderId: result.orderId });

    // The payment is real and stands; the Receipt is not minted — a Receipt
    // attests WHICH charge the chain produced, and a blank binding is never
    // signed. The gap is recorded as an anomaly, not thrown.
    const order = await findOrderById(deps.db, MERCHANT_ID, result.orderId);
    expect(order?.status).toBe('paid');
    expect(await deps.db.select().from(receipts)).toHaveLength(0);
    const chain = await deps.db
      .select({ type: auditEvents.type, payload: auditEvents.payload })
      .from(auditEvents)
      .where(eq(auditEvents.orderId, result.orderId))
      .orderBy(asc(auditEvents.seq));
    expect(chain.some((e) => e.type === 'receipt.issued')).toBe(false);
    const anomaly = chain.find((e) => e.type === 'order.anomaly_detected')!;
    expect(anomaly.payload).toMatchObject({ reason: 'missing_gateway_payment_id' });
  });

  it('Decline on demand: payment.failed is recorded and the Order never becomes paid', async () => {
    await seedCatalog(deps.db, 3);
    const agent = await registeredAgent(deps);
    const result = await placeOrder(deps, agent);

    const declined = await deliver(deps, gateway.failPayment(result.gatewayPaymentLinkId)[0]!);
    expect(declined).toEqual({ result: 'recorded', orderId: result.orderId });

    const afterDecline = await findOrderById(deps.db, MERCHANT_ID, result.orderId);
    expect(afterDecline?.status).toBe('awaiting_payment');
    expect(afterDecline?.paidAt).toBeNull();

    // The retry that succeeds (T8's bounded-retry path needs this scriptable).
    const paid = await deliver(deps, gateway.completePayment(result.gatewayPaymentLinkId)[0]!);
    expect(paid).toEqual({ result: 'order_paid', orderId: result.orderId });
  });

  it('Oversell on demand: two captures land against stock that covers one', async () => {
    await seedCatalog(deps.db, 1);
    const agent = await registeredAgent(deps);

    // No reservations, deliberately (spec: the race window is what makes the
    // Oversell failure real). Both chains pass the pre-payment stock check.
    const a = await placeOrder(deps, agent);
    const b = await placeOrder(deps, agent);

    for (const r of [a, b]) {
      const outcome = await deliver(deps, gateway.completePayment(r.gatewayPaymentLinkId)[0]!);
      expect(outcome).toEqual({ result: 'order_paid', orderId: r.orderId });
    }

    // Both Orders are paid; stock still says 1: the shortfall now exists for
    // T9's fulfilment-time check to discover and refund. That is the Oversell,
    // manufactured deterministically.
    const [variantRow] = await deps.db
      .select()
      .from(variants)
      .where(eq(variants.id, 'var_test_tee_default'));
    expect(variantRow?.stock).toBe(1);
    const orderA = await findOrderById(deps.db, MERCHANT_ID, a.orderId);
    const orderB = await findOrderById(deps.db, MERCHANT_ID, b.orderId);
    expect(orderA?.status).toBe('paid');
    expect(orderB?.status).toBe('paid');
    // Line items live in order_items since T4 — the legacy quantity column is null.
    const lines = await deps.db.select().from(orderItems);
    const sold = lines.reduce((sum, line) => sum + line.quantity, 0);
    expect(sold).toBeGreaterThan(variantRow?.stock ?? 0);
  });
});

import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StorefrontDeps } from '../deps.js';
import { auditEvents, variants } from '../db/schema.js';
import { checkout } from '../domain/checkout.js';
import { applyGatewayWebhook, findOrderById, type WebhookOutcome } from '../domain/orders.js';
import { createTestDatabase, type TestDatabaseHandle } from '../testSupport/pgliteDatabase.js';
import { MERCHANT_ID, seedCatalog } from '../testSupport/seedCatalog.js';
import { StubGateway, type SyntheticWebhook } from './stubGateway.js';

/**
 * T2's acceptance proof: a purchase runs fully in-process — StubGateway for
 * the rails, embedded PGlite for the database — with no network calls, and
 * Declines and Oversells are scriptable on demand (issue #3).
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

  it('happy path: checkout → synthetic webhooks → Order paid, audit chain complete', async () => {
    await seedCatalog(deps.db, 3);

    const result = await checkout(deps, { merchantId: MERCHANT_ID, quantity: 1 });
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
      'order.created',
      'gateway.payment_link_attempted',
      'gateway.payment_link_issued',
      'gateway.webhook_received',
      'gateway.order_linked',
      'order.paid',
      'gateway.webhook_received',
    ]);
    // Namespaced, so the rule-auditor never meets two meanings of one spelling.
    expect((chain[3]!.payload as { gatewayEvent: string }).gatewayEvent).toBe(
      'stub:payment_link.paid',
    );
    expect((chain[5]!.payload as { gateway: string }).gateway).toBe('stub');

    // Redelivery of an already-applied success is still free.
    const redelivered = await deliver(deps, hooks[0]!);
    expect(redelivered).toEqual({ result: 'already_paid', orderId: result.orderId });
  });

  it('Decline on demand: payment.failed is recorded and the Order never becomes paid', async () => {
    await seedCatalog(deps.db, 3);
    const result = await checkout(deps, { merchantId: MERCHANT_ID, quantity: 1 });

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

    // No reservations, deliberately (spec: the race window is what makes the
    // Oversell failure real). Both checkouts pass the pre-payment stock check.
    const a = await checkout(deps, { merchantId: MERCHANT_ID, quantity: 1 });
    const b = await checkout(deps, { merchantId: MERCHANT_ID, quantity: 1 });

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
    expect((orderA?.quantity ?? 0) + (orderB?.quantity ?? 0)).toBeGreaterThan(
      variantRow?.stock ?? 0,
    );
  });
});

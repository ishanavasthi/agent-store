import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StorefrontDeps } from '../deps.js';
import {
  agents,
  auditEvents,
  receipts,
  refundReceipts,
  variants,
  type AgentRow,
} from '../db/schema.js';
import { StubGateway, type SyntheticWebhook } from '../gateway/stubGateway.js';
import { registerAgent } from './agents.js';
import { createCart, declareIntent } from './mandateFlow.js';
import { verifyMandateSignature } from './mandates.js';
import { paise } from './money.js';
import {
  applyGatewayWebhook,
  findOrderById,
  toOrderStatusView,
  type WebhookOutcome,
} from './orders.js';
import { readOrderStatus } from './orderStatus.js';
import { refundOversoldOrder } from './oversell.js';
import { submitPayment, type SubmitPaymentResult } from './submitPayment.js';
import { createTestDatabase, type TestDatabaseHandle } from '../testSupport/pgliteDatabase.js';
import { MERCHANT_ID, seedCatalog } from '../testSupport/seedCatalog.js';

/**
 * T9's acceptance proof (issue #10, PLAN §5.6 failure 2): capture → Oversell →
 * automatic refund. Two rival buyers both pass payment-mandate verification
 * against the same last unit (no reservations — the race window is the
 * point); both captures complete; the first fulfils, the second oversells and
 * is refunded in full with a merchant-signed refund receipt referencing the
 * original Receipt by hash.
 *
 * Webhook delivery mirrors `http/app.ts`'s route exactly, including the
 * automatic refund step on an `oversell_detected` outcome.
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

async function placeOrder(
  deps: StorefrontDeps,
  agent: AgentRow,
  items: readonly { variantId: string; quantity: number }[],
): Promise<SubmitPaymentResult> {
  const intent = await declareIntent(deps.db, agent, { want: 'streetwear', budgetPaise: 400000 });
  const cart = await createCart(deps.db, agent, { intentHash: intent.intentHash, items: [...items] });
  return submitPayment(deps, agent, { cartHash: cart.cartHash, idempotencyKey: randomUUID() });
}

async function auditChain(deps: StorefrontDeps, orderId: string) {
  return deps.db
    .select({ type: auditEvents.type, payload: auditEvents.payload })
    .from(auditEvents)
    .where(eq(auditEvents.orderId, orderId))
    .orderBy(asc(auditEvents.seq));
}

async function stockOf(deps: StorefrontDeps, variantId: string): Promise<number> {
  const [row] = await deps.db
    .select({ stock: variants.stock })
    .from(variants)
    .where(eq(variants.id, variantId));
  return row!.stock;
}

describe('T9: oversell at fulfilment, automatic refund', () => {
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
    // One unit of everything: the second buyer's capture must oversell.
    await seedCatalog(deps.db, 1);
  });

  afterEach(async () => {
    await handle.close();
  });

  it('rival captures: first fulfils, second oversells and is refunded with a signed refund receipt', async () => {
    const buyerA = await registeredAgent(deps);
    const buyerB = await registeredAgent(deps);

    // Both pass payment-mandate verification against the same last tee —
    // stock is checked but nothing is reserved (PLAN §5.2).
    const orderA = await placeOrder(deps, buyerA, [{ variantId: 'var_test_tee_default', quantity: 1 }]);
    const orderB = await placeOrder(deps, buyerB, [{ variantId: 'var_test_tee_default', quantity: 1 }]);

    // Buyer A's capture wins the unit: fulfilment decrements 1 → 0.
    const paidA = await deliver(deps, gateway.completePayment(orderA.gatewayPaymentLinkId)[0]!);
    expect(paidA).toEqual({ result: 'order_paid', orderId: orderA.orderId });
    expect(await stockOf(deps, 'var_test_tee_default')).toBe(0);
    const chainA = await auditChain(deps, orderA.orderId);
    expect(chainA.map((e) => e.type)).toContain('order.fulfilled');

    // Buyer B's capture finds the shelf bare: the conditional decrement
    // misses, the Order is paid-but-oversold, and stock never goes negative.
    const paidB = await deliver(deps, gateway.completePayment(orderB.gatewayPaymentLinkId)[0]!);
    expect(paidB).toEqual({
      result: 'oversell_detected',
      orderId: orderB.orderId,
      shortfalls: [
        { variantId: 'var_test_tee_default', productTitle: 'Oversized Tee', requested: 1, available: 0 },
      ],
    });
    expect(await stockOf(deps, 'var_test_tee_default')).toBe(0);
    const oversoldRow = await findOrderById(deps.db, MERCHANT_ID, orderB.orderId);
    expect(oversoldRow?.status).toBe('paid');
    expect(oversoldRow?.oversellShortfall).not.toBeNull();

    // The automatic refund — what the webhook route runs on this outcome.
    const refund = await refundOversoldOrder(deps, orderB.orderId);
    expect(refund).toMatchObject({
      result: 'order_refunded',
      orderId: orderB.orderId,
      oversell: {
        kind: 'oversell',
        code: 'OVERSOLD',
        refund: { amountPaise: 129900, gatewayRefundId: 'rfnd_stub_2' },
      },
    });

    // Terminal state: refunded, with the structured Oversell on the row and
    // the gateway refund id qualified like every gateway identifier.
    const refundedRow = await findOrderById(deps.db, MERCHANT_ID, orderB.orderId);
    expect(refundedRow?.status).toBe('refunded');
    expect(refundedRow?.refundedAt).not.toBeNull();
    expect(refundedRow?.gatewayRefundId).toBe('rfnd_stub_2');

    // The buyer's answer is an Oversell — never a Refusal (no `recoverable`),
    // never a Decline (no `attempts`).
    const view = toOrderStatusView(refundedRow!);
    expect(view.status).toBe('refunded');
    expect(view.oversell).toMatchObject({ kind: 'oversell', code: 'OVERSOLD' });
    expect(view.oversell).not.toHaveProperty('recoverable');
    expect(view.oversell).not.toHaveProperty('attempts');
    expect(view.decline).toBeNull();

    // The refund receipt: merchant-signed, referencing the original Receipt
    // by hash — verifiable with nothing but the two documents and the key.
    const [original] = await deps.db
      .select()
      .from(receipts)
      .where(eq(receipts.orderId, orderB.orderId));
    expect(original).toBeDefined();
    const status = await readOrderStatus(deps, orderB.orderId);
    expect(status.receipt).not.toBeNull();
    expect(status.refundReceipt).not.toBeNull();
    expect(status.refundReceipt!.payload).toMatchObject({
      orderId: orderB.orderId,
      receiptHash: original!.hash,
      amountPaise: 129900,
      gatewayRefundId: 'rfnd_stub_2',
    });
    expect(
      verifyMandateSignature(
        status.refundReceipt!.merchantPublicKey,
        status.refundReceipt!.payload,
        status.refundReceipt!.signature,
      ),
    ).toBe(true);

    // The full oversell story is on the ledger, in order, each event in the
    // same transaction as its state change (ADR-0003).
    const chainB = await auditChain(deps, orderB.orderId);
    expect(chainB.map((e) => e.type)).toEqual([
      'payment.verified',
      'order.created',
      'gateway.payment_link_attempted',
      'gateway.payment_link_issued',
      'gateway.webhook_received',
      'gateway.order_linked',
      'order.paid',
      'receipt.issued',
      'order.oversell_detected',
      'gateway.refund_attempted',
      'order.refunded',
      'receipt.refund_issued',
    ]);
    // The ledger records the exact structured reason the buyer was told.
    const refundedEvent = chainB.find((e) => e.type === 'order.refunded');
    expect(refundedEvent!.payload).toMatchObject({
      gatewayRefundId: 'rfnd_stub_2',
      amountPaise: 129900,
      oversell: { kind: 'oversell', code: 'OVERSOLD' },
    });
  });

  it('a multi-line oversell fulfils nothing — earlier decrements are restored', async () => {
    // Cap has 1 in stock; tee also 1. Bump the tee so only the cap oversells.
    await deps.db.update(variants).set({ stock: 5 }).where(eq(variants.id, 'var_test_tee_default'));
    const rival = await registeredAgent(deps);
    const buyer = await registeredAgent(deps);

    const rivalOrder = await placeOrder(deps, rival, [
      { variantId: 'var_test_cap_default', quantity: 1 },
    ]);
    const order = await placeOrder(deps, buyer, [
      { variantId: 'var_test_tee_default', quantity: 2 },
      { variantId: 'var_test_cap_default', quantity: 1 },
    ]);

    // The rival takes the last cap first.
    await deliver(deps, gateway.completePayment(rivalOrder.gatewayPaymentLinkId)[0]!);
    expect(await stockOf(deps, 'var_test_cap_default')).toBe(0);

    const outcome = await deliver(deps, gateway.completePayment(order.gatewayPaymentLinkId)[0]!);
    expect(outcome).toMatchObject({
      result: 'oversell_detected',
      shortfalls: [
        { variantId: 'var_test_cap_default', productTitle: 'Trucker Cap', requested: 1, available: 0 },
      ],
    });
    // The tee's decrement (5 → 3) was restored in the same transaction: an
    // oversold Order fulfils nothing, and no line is half-shipped.
    expect(await stockOf(deps, 'var_test_tee_default')).toBe(5);

    const refund = await refundOversoldOrder(deps, order.orderId);
    expect(refund.result).toBe('order_refunded');
  });

  it('a redelivered capture on a refunded Order is free — refunded is terminal', async () => {
    const buyerA = await registeredAgent(deps);
    const buyerB = await registeredAgent(deps);
    const orderA = await placeOrder(deps, buyerA, [{ variantId: 'var_test_tee_default', quantity: 1 }]);
    const orderB = await placeOrder(deps, buyerB, [{ variantId: 'var_test_tee_default', quantity: 1 }]);
    await deliver(deps, gateway.completePayment(orderA.gatewayPaymentLinkId)[0]!);
    const deliveries = gateway.completePayment(orderB.gatewayPaymentLinkId);
    await deliver(deps, deliveries[0]!);
    await refundOversoldOrder(deps, orderB.orderId);

    // Razorpay's sibling event (payment.captured) lands after the refund: it
    // must not flip the Order back to paid, mint a second Receipt, or
    // decrement anything.
    const redelivered = await deliver(deps, deliveries[1]!);
    expect(redelivered).toEqual({ result: 'already_paid', orderId: orderB.orderId });
    const row = await findOrderById(deps.db, MERCHANT_ID, orderB.orderId);
    expect(row?.status).toBe('refunded');
    expect(await deps.db.select().from(refundReceipts)).toHaveLength(1);
  });

  it('a failed gateway refund parks as an anomaly — the Order stays paid, never pretends', async () => {
    const buyerA = await registeredAgent(deps);
    const buyerB = await registeredAgent(deps);
    const orderA = await placeOrder(deps, buyerA, [{ variantId: 'var_test_tee_default', quantity: 1 }]);
    const orderB = await placeOrder(deps, buyerB, [{ variantId: 'var_test_tee_default', quantity: 1 }]);
    await deliver(deps, gateway.completePayment(orderA.gatewayPaymentLinkId)[0]!);
    await deliver(deps, gateway.completePayment(orderB.gatewayPaymentLinkId)[0]!);

    const brokenDeps: StorefrontDeps = {
      ...deps,
      gateway: {
        ...gateway,
        name: gateway.name,
        createPaymentLink: gateway.createPaymentLink.bind(gateway),
        verifyWebhookSignature: gateway.verifyWebhookSignature.bind(gateway),
        parseWebhookEvent: gateway.parseWebhookEvent.bind(gateway),
        refundPayment: async () => {
          throw new Error('refund endpoint down');
        },
      },
    };
    const outcome = await refundOversoldOrder(brokenDeps, orderB.orderId);
    expect(outcome).toMatchObject({ result: 'refund_failed', orderId: orderB.orderId });

    // Still paid, shortfall still on the row, the failure on the ledger — and
    // a later retry (gateway back up) completes the refund.
    const row = await findOrderById(deps.db, MERCHANT_ID, orderB.orderId);
    expect(row?.status).toBe('paid');
    const chain = await auditChain(deps, orderB.orderId);
    expect(chain.at(-1)!.type).toBe('order.anomaly_detected');
    expect(chain.at(-1)!.payload).toMatchObject({ reason: 'refund_failed' });

    const retried = await refundOversoldOrder(deps, orderB.orderId);
    expect(retried.result).toBe('order_refunded');
  });

  it('refundOversoldOrder refuses Orders that are not oversold-and-paid', async () => {
    const buyer = await registeredAgent(deps);
    const order = await placeOrder(deps, buyer, [{ variantId: 'var_test_tee_default', quantity: 1 }]);

    // Awaiting payment: nothing captured, nothing to refund.
    expect(await refundOversoldOrder(deps, order.orderId)).toEqual({
      result: 'not_oversold',
      orderId: order.orderId,
    });

    // Cleanly fulfilled: paid but no shortfall on the row.
    await deliver(deps, gateway.completePayment(order.gatewayPaymentLinkId)[0]!);
    expect(await refundOversoldOrder(deps, order.orderId)).toEqual({
      result: 'not_oversold',
      orderId: order.orderId,
    });
    expect((await findOrderById(deps.db, MERCHANT_ID, order.orderId))?.status).toBe('paid');
  });

  it('the stub refuses a second full refund — the double-refund backstop is at the gateway', async () => {
    const buyerA = await registeredAgent(deps);
    const buyerB = await registeredAgent(deps);
    const orderA = await placeOrder(deps, buyerA, [{ variantId: 'var_test_tee_default', quantity: 1 }]);
    const orderB = await placeOrder(deps, buyerB, [{ variantId: 'var_test_tee_default', quantity: 1 }]);
    await deliver(deps, gateway.completePayment(orderA.gatewayPaymentLinkId)[0]!);
    await deliver(deps, gateway.completePayment(orderB.gatewayPaymentLinkId)[0]!);
    await refundOversoldOrder(deps, orderB.orderId);

    // The Order already left `paid`, so the domain never re-calls the gateway…
    expect(await refundOversoldOrder(deps, orderB.orderId)).toEqual({
      result: 'not_oversold',
      orderId: orderB.orderId,
    });
    // …and even a direct second refund call is refused by the (stub) gateway,
    // mirroring Razorpay's "fully refunded" error.
    await expect(
      gateway.refundPayment({
        gatewayPaymentId: 'pay_stub_2',
        amountPaise: paise(129900),
        notes: {},
      }),
    ).rejects.toThrow(/already fully refunded/);
  });
});

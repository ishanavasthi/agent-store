import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { agents, receipts, refundReceipts, variants, type AgentRow } from '../db/schema.js';
import type { StorefrontDeps } from '../deps.js';
import { registerAgent } from '../domain/agents.js';
import { readPurchaseAuditChain } from '../domain/auditLog.js';
import { createCart, declareIntent } from '../domain/mandateFlow.js';
import { parseRefundReceiptPayload, verifyMandateSignature } from '../domain/mandates.js';
import { formatPaise, paise } from '../domain/money.js';
import { applyGatewayWebhook, findOrderById, toOrderStatusView } from '../domain/orders.js';
import { refundOversoldOrder } from '../domain/oversell.js';
import { submitPayment, type SubmitPaymentResult } from '../domain/submitPayment.js';
import { StubGateway, type SyntheticWebhook } from '../gateway/stubGateway.js';
import { createTestDatabase } from '../testSupport/pgliteDatabase.js';
import { MERCHANT_ID, seedCatalog } from '../testSupport/seedCatalog.js';

/**
 * Rehearsed failure 2 — Oversell, automatic refund (T9, PLAN §5.6):
 *
 *   npm run failure:oversell
 *
 * One command, fully deterministic, no network and no credentials: an embedded
 * PGlite Postgres runs the real migrations, the StubGateway plays Razorpay, and
 * webhook delivery walks the exact verify → parse → apply → refund path the
 * HTTP route does. Two rival buyers pass payment-mandate verification against
 * the same last unit — no stock is reserved, deliberately (the race window is
 * what makes this failure real). Both captures complete; the first fulfils,
 * the second finds the shelf bare at the fulfilment-time re-check and is
 * automatically refunded in full, with a merchant-signed refund receipt
 * referencing the original Receipt by hash. The script prints the audit
 * timeline and *asserts* every guarantee, exiting non-zero if any fails —
 * a rehearsal that cannot fail proves nothing.
 *
 * On real rails the same path runs unchanged through `RazorpayGateway`
 * (`payments.refund`, test mode), and the refund is visible in the Razorpay
 * test dashboard — that manual check is issue #10's last acceptance box.
 *
 * Compiles first and runs out of `dist` rather than running the `.ts` under
 * `--experimental-strip-types`: type stripping does not rewrite `./x.js`
 * import specifiers, so every `src` entrypoint dies on its first relative
 * import. See the engineering log.
 */

function step(title: string): void {
  console.log(`\n── ${title}`);
}

function assertThat(condition: boolean, claim: string): void {
  if (!condition) {
    console.error(`  ✗ FAILED: ${claim}`);
    process.exitCode = 1;
    throw new Error(`Rehearsal assertion failed: ${claim}`);
  }
  console.log(`  ✓ ${claim}`);
}

async function main(): Promise<void> {
  console.log('Rehearsed failure 2 — Oversell, automatic refund (issue #10)');
  console.log('Stub gateway + embedded Postgres: deterministic, zero network, full refund.');

  const handle = await createTestDatabase();
  const gateway = new StubGateway();
  const deps: StorefrontDeps = {
    db: handle.db,
    gateway,
    merchantId: MERCHANT_ID,
    publicBaseUrl: 'https://merchant.example',
  };

  const deliver = async (hook: SyntheticWebhook) => {
    if (!gateway.verifyWebhookSignature(hook.rawBody, hook.signature)) {
      throw new Error('Synthetic webhook failed signature verification');
    }
    const event = gateway.parseWebhookEvent(hook.rawBody);
    return applyGatewayWebhook(deps.db, deps.merchantId, event, gateway.name);
  };

  const buyer = async (): Promise<AgentRow> => {
    const registration = await registerAgent(deps.db, MERCHANT_ID, { capPaise: 500000 });
    const [row] = await deps.db.select().from(agents).where(eq(agents.id, registration.agentId));
    return row!;
  };

  const placeOrder = async (agent: AgentRow, want: string): Promise<SubmitPaymentResult> => {
    const intent = await declareIntent(deps.db, agent, { want, budgetPaise: 200000 });
    const cart = await createCart(deps.db, agent, {
      intentHash: intent.intentHash,
      items: [{ variantId: 'var_test_tee_default', quantity: 1 }],
    });
    return submitPayment(deps, agent, { cartHash: cart.cartHash, idempotencyKey: randomUUID() });
  };

  const stockOf = async (): Promise<number> => {
    const [row] = await deps.db
      .select({ stock: variants.stock })
      .from(variants)
      .where(eq(variants.id, 'var_test_tee_default'));
    return row!.stock;
  };

  try {
    step('The setup: ONE tee in stock, TWO rival buyers, no reservations');
    await seedCatalog(deps.db, 1);
    const buyerA = await buyer();
    const buyerB = await buyer();
    const orderA = await placeOrder(buyerA, 'the last oversized tee');
    const orderB = await placeOrder(buyerB, 'that same last tee');
    assertThat(
      (await stockOf()) === 1,
      'both mandate chains verified against the same last unit — nothing reserved (PLAN §5.2)',
    );
    console.log(`  Buyer A: Order ${orderA.orderId} awaiting payment (${orderA.total.amountDisplay})`);
    console.log(`  Buyer B: Order ${orderB.orderId} awaiting payment (${orderB.total.amountDisplay})`);

    step('Buyer A pays first: capture → fulfilment decrements the last unit');
    const paidA = await deliver(gateway.completePayment(orderA.gatewayPaymentLinkId)[0]!);
    assertThat(paidA.result === 'order_paid', `Buyer A's Order is paid and fulfilled`);
    assertThat((await stockOf()) === 0, 'stock 1 → 0 by atomic conditional decrement (WHERE stock >= qty)');

    step('Buyer B pays: capture stands, but the fulfilment-time re-check finds the shelf bare');
    const paidB = await deliver(gateway.completePayment(orderB.gatewayPaymentLinkId)[0]!);
    assertThat(
      paidB.result === 'oversell_detected',
      'the missed decrement IS the Oversell — detected in the same transaction as order.paid',
    );
    assertThat((await stockOf()) === 0, 'stock never went negative — the conditional decrement cannot overdraw');

    step('The automatic refund (what the webhook route runs on this outcome)');
    const refund = await refundOversoldOrder(deps, orderB.orderId);
    assertThat(refund.result === 'order_refunded', 'the gateway refunded the captured payment in full');

    step('Outcome: refunded, structured reason, receipt pair');
    const finalRow = await findOrderById(deps.db, MERCHANT_ID, orderB.orderId);
    const view = toOrderStatusView(finalRow!);
    assertThat(view.status === 'refunded', `Order status is 'refunded' — a terminal state`);
    assertThat(
      view.oversell !== null && view.oversell.code === 'OVERSOLD',
      'the refund carries a structured reason (code OVERSOLD)',
    );
    assertThat(
      view.oversell !== null &&
        view.oversell.kind === 'oversell' &&
        !('recoverable' in view.oversell) &&
        !('attempts' in view.oversell),
      'the buyer response is an Oversell — not a Refusal (no `recoverable`), not a Decline (no `attempts`)',
    );
    assertThat(
      view.oversell !== null && view.oversell.refund.amountPaise === finalRow!.amountPaise,
      `the FULL ${formatPaise(paise(finalRow!.amountPaise))} was refunded, not a partial`,
    );

    const [original] = await deps.db.select().from(receipts).where(eq(receipts.orderId, orderB.orderId));
    const [refundReceipt] = await deps.db
      .select({
        payload: refundReceipts.payload,
        signature: refundReceipts.merchantSignature,
      })
      .from(refundReceipts)
      .where(eq(refundReceipts.orderId, orderB.orderId));
    assertThat(
      original !== undefined && refundReceipt !== undefined,
      'both documents exist: the original Receipt (the charge was real) and the refund receipt',
    );
    const refundPayload = parseRefundReceiptPayload(refundReceipt!.payload);
    assertThat(
      refundPayload.receiptHash === original!.hash,
      'the refund receipt references the original Receipt by hash — charge and reversal verify as a pair',
    );
    const [merchant] = await deps.db.query.merchants.findMany({ limit: 1 });
    assertThat(
      merchant !== undefined &&
        merchant.signingPublicKey !== null &&
        verifyMandateSignature(merchant.signingPublicKey, refundPayload, refundReceipt!.signature),
      'the refund receipt is merchant-SIGNED — Ed25519 verifies against the merchant public key',
    );

    console.log('\n  What get_order_status now tells the buyer:');
    console.log(
      JSON.stringify({ status: view.status, refundedAt: view.refundedAt, oversell: view.oversell }, null, 2)
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n'),
    );

    step('The audit trail (what the T7 viewer replays)');
    const chain = await readPurchaseAuditChain(deps.db, orderB.orderId);
    for (const event of chain) {
      console.log(`  #${event.seq}  ${event.type}`);
      console.log(`      ${event.summary}`);
    }
    const types = chain.map((event) => event.type);
    for (const required of [
      'order.paid',
      'receipt.issued',
      'order.oversell_detected',
      'gateway.refund_attempted',
      'order.refunded',
      'receipt.refund_issued',
    ] as const) {
      assertThat(types.includes(required), `audit trail contains ${required}`);
    }
    assertThat(
      types.indexOf('order.oversell_detected') > types.indexOf('order.paid') &&
        types.indexOf('order.refunded') > types.indexOf('gateway.refund_attempted'),
      'the ledger tells the story in order: paid → oversell detected → refund attempted → refunded',
    );

    console.log(
      `\nOversell rehearsal complete: ${formatPaise(paise(finalRow!.amountPaise))} captured and ` +
        `automatically refunded, Order ${orderB.orderId} refunded, buyer told why.`,
    );
    console.log(
      'Viewer: this same sequence renders at /viewer/orders/<orderId> on a deployed instance.',
    );
    console.log(
      'Real rails: the identical path runs through RazorpayGateway.refundPayment — the refund ' +
        'appears in the Razorpay test dashboard (refunds work only against captured test payments, PLAN §5.5).',
    );
  } finally {
    await handle.close();
  }
}

main().catch((error) => {
  console.error('\nRehearsal did not complete:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { agents, receipts } from '../db/schema.js';
import type { StorefrontDeps } from '../deps.js';
import { registerAgent } from '../domain/agents.js';
import { readPurchaseAuditChain } from '../domain/auditLog.js';
import { createCart, declareIntent } from '../domain/mandateFlow.js';
import { formatPaise, paise } from '../domain/money.js';
import { applyGatewayWebhook, findOrderById, toOrderStatusView } from '../domain/orders.js';
import { submitPayment } from '../domain/submitPayment.js';
import { StubGateway, type SyntheticWebhook } from '../gateway/stubGateway.js';
import { createTestDatabase } from '../testSupport/pgliteDatabase.js';
import { MERCHANT_ID, seedCatalog } from '../testSupport/seedCatalog.js';

/**
 * Rehearsed failure 1 — Decline, fail closed (T8, PLAN §5.6):
 *
 *   npm run failure:decline
 *
 * One command, fully deterministic, no network and no credentials: an embedded
 * PGlite Postgres runs the real migrations, the StubGateway plays Razorpay, and
 * webhook delivery walks the exact verify → parse → apply path the HTTP route
 * does. The script drives the whole sequence — mandate chain → payment link →
 * decline → one bounded retry → decline → Order cancelled — then prints the
 * audit timeline and *asserts* the fail-closed outcome, exiting non-zero if any
 * guarantee does not hold. A rehearsal that cannot fail proves nothing.
 *
 * The live-video variant of this failure is driven manually with
 * `failure@razorpay` on a hosted Payment Link (issue #9); the sequence and the
 * audit chain are the same — only the gateway is real.
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
  console.log('Rehearsed failure 1 — Decline, fail closed (issue #9)');
  console.log('Stub gateway + embedded Postgres: deterministic, zero network, zero charge.');

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

  try {
    step('The purchase that will fail: mandate chain → payment link');
    await seedCatalog(deps.db, 3);
    const registration = await registerAgent(deps.db, MERCHANT_ID, { capPaise: 500000 });
    const [agent] = await deps.db
      .select()
      .from(agents)
      .where(eq(agents.id, registration.agentId));
    const intent = await declareIntent(deps.db, agent!, {
      want: 'one oversized tee',
      budgetPaise: 200000,
    });
    const cart = await createCart(deps.db, agent!, {
      intentHash: intent.intentHash,
      items: [{ variantId: 'var_test_tee_default', quantity: 1 }],
    });
    const order = await submitPayment(deps, agent!, {
      cartHash: cart.cartHash,
      idempotencyKey: randomUUID(),
    });
    console.log(`  Order ${order.orderId} awaiting payment: ${order.total.amountDisplay}`);
    console.log(`  Payment link: ${order.paymentLinkUrl}`);

    step('Attempt 1: the gateway declines');
    const first = await deliver(gateway.failPayment(order.gatewayPaymentLinkId)[0]!);
    assertThat(
      first.result === 'decline_recorded' && first.attempt === 1 && first.retriesRemaining === 1,
      'decline counted as attempt 1 of 2 — one bounded retry remains',
    );
    const afterFirst = await findOrderById(deps.db, MERCHANT_ID, order.orderId);
    assertThat(
      afterFirst?.status === 'awaiting_payment',
      'the Order still waits — a single decline does not cancel',
    );

    step('Attempt 2: the bounded retry — the gateway declines again');
    const second = await deliver(gateway.failPayment(order.gatewayPaymentLinkId)[0]!);
    assertThat(
      second.result === 'order_cancelled',
      'the attempt limit is exhausted — the Order failed closed',
    );

    step('Outcome: cancelled, structured reason, zero charge');
    const finalRow = await findOrderById(deps.db, MERCHANT_ID, order.orderId);
    const view = toOrderStatusView(finalRow!);
    assertThat(view.status === 'cancelled', `Order status is 'cancelled'`);
    assertThat(
      view.decline !== null && view.decline.code === 'PAYMENT_DECLINED',
      'the cancellation carries a structured reason (code PAYMENT_DECLINED)',
    );
    assertThat(
      view.decline !== null && view.decline.kind === 'decline' && !('recoverable' in view.decline),
      'the buyer response is a Decline, not a Refusal (kind "decline", no `recoverable`)',
    );
    assertThat(
      view.paidAt === null && view.gatewayPaymentId === null,
      'zero charge: never paid, no gateway payment captured',
    );
    assertThat(
      (await deps.db.select().from(receipts)).length === 0,
      'no Receipt exists — a Receipt attests a charge, and there was none',
    );
    console.log('\n  What get_order_status now tells the buyer:');
    console.log(
      JSON.stringify({ status: view.status, cancelledAt: view.cancelledAt, decline: view.decline }, null, 2)
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n'),
    );

    step('The audit trail (what the T7 viewer replays)');
    const chain = await readPurchaseAuditChain(deps.db, order.orderId);
    for (const event of chain) {
      console.log(`  #${event.seq}  ${event.type}`);
      console.log(`      ${event.summary}`);
    }
    const types = chain.map((event) => event.type);
    for (const required of ['payment.declined', 'order.cancelled'] as const) {
      assertThat(types.includes(required), `audit trail contains ${required}`);
    }
    assertThat(
      types.filter((type) => type === 'payment.declined').length === 2,
      'both declined attempts are on the record',
    );
    assertThat(
      !types.includes('order.paid') && !types.includes('receipt.issued'),
      'the ledger shows no money moving — no order.paid, no receipt.issued',
    );

    console.log(
      `\nFail-closed rehearsal complete: ${formatPaise(paise(0))} charged, ` +
        `Order ${order.orderId} cancelled, buyer told why.`,
    );
    console.log(
      'Viewer: this same sequence renders at /viewer/orders/<orderId> on a deployed instance.',
    );
  } finally {
    await handle.close();
  }
}

main().catch((error) => {
  console.error('\nRehearsal did not complete:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

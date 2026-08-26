import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { intentMandates, orders, paymentMandates } from '../db/schema.js';
import type { StorefrontDeps } from '../deps.js';
import { applyGatewayWebhook, type WebhookOutcome } from '../domain/orders.js';
import type { RefusalCode } from '../domain/refusal.js';
import { StubGateway, type SyntheticWebhook } from '../gateway/stubGateway.js';
import { auditChain, call, type ToolCallResult } from '../testSupport/mcpTestClient.js';
import { createTestDatabase, type TestDatabaseHandle } from '../testSupport/pgliteDatabase.js';
import { MERCHANT_ID, seedCatalog } from '../testSupport/seedCatalog.js';
import { createMcpServer } from './server.js';

/**
 * T5's acceptance proof (issue #6): every policy check at Payment-mandate
 * verification — Budget, Cap, idempotency replay/reuse, Intent consumption —
 * driven through the protocol seam and asserted via wire responses plus
 * DB/audit rows, never server internals.
 *
 * Refusal discipline throughout: assert `code`, `recoverable`, and shape
 * (reason a non-empty string, retryAfter absent or a number) — never exact
 * reason prose, which is written for LLM buyers and free to change.
 *
 * The tampered-cart M2 attack is deliberately NOT repeated here:
 * `mandateChain.integration.test.ts` already proves it ("a tampered stored
 * signature refuses INVALID_MANDATE and is audited; no Order exists"), and a
 * doctored payload fails the same signature-over-canonical-payload gate.
 */

const TEE = 'var_test_tee_default';
/** A hat. Named to keep the Variant id apart from the Cap spend ceiling. */
const CAP_VARIANT = 'var_test_cap_default';
const TEE_PRICE = 129900; // the ₹499.00 cap rides alongside where a second price is needed

describe('T5 enforcement, through the MCP tools', () => {
  let handle: TestDatabaseHandle;
  let gateway: StubGateway;
  let deps: StorefrontDeps;
  let client: Client;
  let agentToken: string;
  let agentId: string;

  /** The same three steps the webhook route performs, minus the socket. */
  async function deliver(hook: SyntheticWebhook): Promise<WebhookOutcome> {
    expect(deps.gateway.verifyWebhookSignature(hook.rawBody, hook.signature)).toBe(true);
    const event = deps.gateway.parseWebhookEvent(hook.rawBody);
    return applyGatewayWebhook(deps.db, deps.merchantId, event, deps.gateway.name);
  }

  async function declareIntent(budgetPaise: number, token = agentToken): Promise<string> {
    const { isError, body } = await call(client, 'declare_intent', {
      agentToken: token,
      want: 'a tee and a cap',
      budgetPaise,
    });
    expect(isError).toBe(false);
    return body['intentHash'] as string;
  }

  async function createCart(
    intentHash: string,
    items: Array<{ variantId: string; quantity: number }>,
    token = agentToken,
  ): Promise<Record<string, unknown>> {
    const { isError, body } = await call(client, 'create_cart', {
      agentToken: token,
      intentHash,
      items,
    });
    expect(isError).toBe(false);
    return body;
  }

  /**
   * `submit_payment` with the parse failure turned into an assertion: the tool
   * promises a structured JSON body on every path, so a non-JSON leak fails
   * here with the leaked body in the message, not as a harness crash.
   */
  async function submit(
    cartHash: string,
    idempotencyKey: string,
    token = agentToken,
  ): Promise<ToolCallResult> {
    const result = await client.callTool({
      name: 'submit_payment',
      arguments: { agentToken: token, cartHash, idempotencyKey },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const text = content[0]!.text;
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // asserted below, with the leaked body in the failure message
    }
    expect(body, `submit_payment must answer with a structured JSON body, got: ${text}`).not.toBeNull();
    return { isError: result.isError === true, body: body! };
  }

  /** The one shape discipline every refusal in this suite is held to. */
  function expectRefusal(result: ToolCallResult, code: RefusalCode, recoverable: boolean): void {
    expect(result.isError).toBe(true);
    const refusal = result.body['refusal'] as Record<string, unknown> | undefined;
    expect(refusal, `expected a Refusal body, got: ${JSON.stringify(result.body)}`).toBeDefined();
    expect(refusal!['code']).toBe(code);
    expect(refusal!['recoverable']).toBe(recoverable);
    expect(typeof refusal!['reason']).toBe('string');
    expect((refusal!['reason'] as string).length).toBeGreaterThan(0);
    if (refusal!['retryAfter'] !== undefined) {
      expect(typeof refusal!['retryAfter']).toBe('number');
    }
  }

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
    const server = createMcpServer(deps);
    client = new Client({ name: 'test-buyer', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const registration = await call(client, 'register_agent', { capPaise: 500000 });
    agentToken = registration.body['agentToken'] as string;
    agentId = registration.body['agentId'] as string;
  });

  afterEach(async () => {
    await client.close();
    await handle.close();
  });

  it('a cart over its Budget refuses OVER_BUDGET: no Order, no gateway contact, refusal audited', async () => {
    const intentHash = await declareIntent(100000);
    const cart = await createCart(intentHash, [{ variantId: TEE, quantity: 1 }]);
    expect((cart['total'] as Record<string, unknown>)['amountPaise']).toBe(TEE_PRICE);

    const refused = await submit(cart['cartHash'] as string, randomUUID());
    expectRefusal(refused, 'OVER_BUDGET', true);

    expect(await deps.db.select().from(orders)).toHaveLength(0);
    const chain = await auditChain(deps.db);
    expect(chain.some((e) => e.type.startsWith('gateway.'))).toBe(false);
    const refusedEvent = chain.find((e) => e.type === 'payment.refused')!;
    expect(refusedEvent).toBeDefined();
    expect(refusedEvent.orderId).toBeNull();
    expect(refusedEvent.payload).toMatchObject({ code: 'OVER_BUDGET' });
  });

  it('the Cap refuses OVER_CAP cumulatively, distinctly from OVER_BUDGET', async () => {
    // Big Budgets, tight Cap: the second purchase is fine per-Intent but
    // breaches the Agent's lifetime ceiling — the code must say which rule hit.
    const tight = await call(client, 'register_agent', { capPaise: 150000 });
    const tightToken = tight.body['agentToken'] as string;

    const firstIntent = await declareIntent(400000, tightToken);
    const firstCart = await createCart(firstIntent, [{ variantId: TEE, quantity: 1 }], tightToken);
    const paid = await submit(firstCart['cartHash'] as string, randomUUID(), tightToken);
    expect(paid.isError).toBe(false);
    const orderId = paid.body['orderId'] as string;

    const hooks = gateway.completePayment(paid.body['gatewayPaymentLinkId'] as string);
    expect(await deliver(hooks[0]!)).toEqual({ result: 'order_paid', orderId });
    expect(await deliver(hooks[1]!)).toEqual({ result: 'already_paid', orderId });

    // 129900 captured + 49900 pending would be 179800 > the 150000 Cap.
    const secondIntent = await declareIntent(400000, tightToken);
    const secondCart = await createCart(secondIntent, [{ variantId: CAP_VARIANT, quantity: 1 }], tightToken);
    const refused = await submit(secondCart['cartHash'] as string, randomUUID(), tightToken);
    expectRefusal(refused, 'OVER_CAP', false);

    expect(await deps.db.select().from(orders)).toHaveLength(1);
    const chain = await auditChain(deps.db);
    expect(chain.find((e) => e.type === 'payment.refused')!.payload).toMatchObject({
      code: 'OVER_CAP',
    });
  });

  it('a pending (awaiting_payment) Order counts toward the Cap', async () => {
    const tight = await call(client, 'register_agent', { capPaise: 150000 });
    const tightToken = tight.body['agentToken'] as string;

    const firstIntent = await declareIntent(400000, tightToken);
    const firstCart = await createCart(firstIntent, [{ variantId: TEE, quantity: 1 }], tightToken);
    const pending = await submit(firstCart['cartHash'] as string, randomUUID(), tightToken);
    expect(pending.isError).toBe(false);
    expect(pending.body['status']).toBe('awaiting_payment');
    // No webhook delivered: the first Order never leaves awaiting_payment.

    const secondIntent = await declareIntent(400000, tightToken);
    const secondCart = await createCart(secondIntent, [{ variantId: CAP_VARIANT, quantity: 1 }], tightToken);
    const refused = await submit(secondCart['cartHash'] as string, randomUUID(), tightToken);
    expectRefusal(refused, 'OVER_CAP', false);

    expect(await deps.db.select().from(orders)).toHaveLength(1);
  });

  it('same key + same cart replays the original result: one Order, one link, no second charge', async () => {
    const intentHash = await declareIntent(400000);
    const cart = await createCart(intentHash, [{ variantId: TEE, quantity: 1 }]);
    const cartHash = cart['cartHash'] as string;
    const key = randomUUID();

    const first = await submit(cartHash, key);
    expect(first.isError).toBe(false);
    const orderId = first.body['orderId'] as string;

    const replay = await submit(cartHash, key);
    expect(replay.isError).toBe(false);
    expect(replay.body['orderId']).toBe(orderId);
    expect(replay.body['gatewayPaymentLinkId']).toBe(first.body['gatewayPaymentLinkId']);
    expect(replay.body['paymentLinkUrl']).toBe(first.body['paymentLinkUrl']);
    expect((replay.body['total'] as Record<string, unknown>)['amountPaise']).toBe(TEE_PRICE);
    expect(replay.body['items']).toHaveLength(1);
    expect((replay.body['paymentMandate'] as Record<string, unknown>)['paymentHash']).toBe(
      (first.body['paymentMandate'] as Record<string, unknown>)['paymentHash'],
    );

    // Exactly one Order, one Payment mandate, one link ever minted at the
    // gateway — the replay touched nothing.
    expect(await deps.db.select().from(orders)).toHaveLength(1);
    expect(await deps.db.select().from(paymentMandates)).toHaveLength(1);
    const chain = await auditChain(deps.db);
    expect(chain.filter((e) => e.type === 'gateway.payment_link_attempted')).toHaveLength(1);
    expect(chain.filter((e) => e.type === 'gateway.payment_link_issued')).toHaveLength(1);

    // The replay is itself an audited fact, attributed to the original Order.
    const replayed = chain.filter((e) => e.type === 'payment.replayed');
    expect(replayed).toHaveLength(1);
    expect(replayed[0]!.orderId).toBe(orderId);
    expect(replayed[0]!.payload).toMatchObject({ agentId, idempotencyKey: key, cartHash });
    expect(chain.some((e) => e.type === 'payment.refused')).toBe(false);
  });

  it('same key + different cart refuses IDEMPOTENCY_REUSE; no second Order', async () => {
    const key = randomUUID();
    const firstIntent = await declareIntent(400000);
    const firstCart = await createCart(firstIntent, [{ variantId: TEE, quantity: 1 }]);
    const first = await submit(firstCart['cartHash'] as string, key);
    expect(first.isError).toBe(false);

    // The first Intent was consumed by that submission, so the different cart
    // rides a fresh Intent — isolating the key reuse as the only violation.
    const secondIntent = await declareIntent(400000);
    const secondCart = await createCart(secondIntent, [{ variantId: CAP_VARIANT, quantity: 1 }]);
    const refused = await submit(secondCart['cartHash'] as string, key);
    expectRefusal(refused, 'IDEMPOTENCY_REUSE', true);

    expect(await deps.db.select().from(orders)).toHaveLength(1);
    const chain = await auditChain(deps.db);
    expect(chain.filter((e) => e.type === 'gateway.payment_link_issued')).toHaveLength(1);
    expect(chain.find((e) => e.type === 'payment.refused')!.payload).toMatchObject({
      code: 'IDEMPOTENCY_REUSE',
    });
  });

  it('a second purchase on a consumed Intent refuses INTENT_CONSUMED; carting stays free', async () => {
    const intentHash = await declareIntent(400000);
    const cartA = await createCart(intentHash, [{ variantId: TEE, quantity: 1 }]);
    const paid = await submit(cartA['cartHash'] as string, randomUUID());
    expect(paid.isError).toBe(false);
    const orderId = paid.body['orderId'] as string;
    const hooks = gateway.completePayment(paid.body['gatewayPaymentLinkId'] as string);
    expect(await deliver(hooks[0]!)).toEqual({ result: 'order_paid', orderId });
    expect(await deliver(hooks[1]!)).toEqual({ result: 'already_paid', orderId });

    // Creating another cart under the same Intent must still succeed — carts
    // coexist freely and have no lifecycle (ADR-0002). Paying it must not.
    const cartB = await createCart(intentHash, [{ variantId: CAP_VARIANT, quantity: 1 }]);
    const refused = await submit(cartB['cartHash'] as string, randomUUID());
    expectRefusal(refused, 'INTENT_CONSUMED', true);

    // 1:1:1 persisted: the Intent names exactly the Order that consumed it.
    const [intentRow] = await deps.db
      .select()
      .from(intentMandates)
      .where(eq(intentMandates.hash, intentHash));
    expect(intentRow!.consumedByOrderId).toBe(orderId);
    expect(await deps.db.select().from(orders)).toHaveLength(1);
    const chain = await auditChain(deps.db);
    expect(chain.find((e) => e.type === 'payment.refused')!.payload).toMatchObject({
      code: 'INTENT_CONSUMED',
    });
  });

  it('a gateway Decline is never labeled a Refusal: no payment.refused, no Refusal wire shape', async () => {
    const intentHash = await declareIntent(400000);
    const cart = await createCart(intentHash, [{ variantId: TEE, quantity: 1 }]);
    const submitted = await submit(cart['cartHash'] as string, randomUUID());
    expect(submitted.isError).toBe(false);
    const orderId = submitted.body['orderId'] as string;

    // The trust layer said yes; the gateway then says no. That is a Decline —
    // counted on the Order's chain (T8), never a payment.refused event.
    const hooks = gateway.failPayment(submitted.body['gatewayPaymentLinkId'] as string);
    expect(await deliver(hooks[0]!)).toEqual({
      result: 'decline_recorded',
      orderId,
      attempt: 1,
      retriesRemaining: 1,
    });

    const chain = await auditChain(deps.db);
    expect(chain.some((e) => e.type === 'payment.refused')).toBe(false);

    const status = await call(client, 'get_order_status', { agentToken, orderId });
    expect(status.isError).toBe(false);
    expect(status.body['refusal']).toBeUndefined();
    expect(status.body['status']).toBe('awaiting_payment');
  });

  it('a refusal does not burn the idempotency key: the same key then pays a compliant cart', async () => {
    const key = randomUUID();
    const overIntent = await declareIntent(100000);
    const overCart = await createCart(overIntent, [{ variantId: TEE, quantity: 1 }]);
    const refused = await submit(overCart['cartHash'] as string, key);
    expectRefusal(refused, 'OVER_BUDGET', true);

    // Refused means nothing persisted — in particular no payment_mandates row
    // holding the key hostage.
    expect(await deps.db.select().from(paymentMandates)).toHaveLength(0);

    const goodIntent = await declareIntent(100000);
    const goodCart = await createCart(goodIntent, [{ variantId: CAP_VARIANT, quantity: 1 }]);
    const paid = await submit(goodCart['cartHash'] as string, key);
    expect(paid.isError).toBe(false);
    const orderId = paid.body['orderId'] as string;
    const hooks = gateway.completePayment(paid.body['gatewayPaymentLinkId'] as string);
    expect(await deliver(hooks[0]!)).toEqual({ result: 'order_paid', orderId });

    expect(await deps.db.select().from(orders)).toHaveLength(1);
    expect(await deps.db.select().from(paymentMandates)).toHaveLength(1);
  });
});

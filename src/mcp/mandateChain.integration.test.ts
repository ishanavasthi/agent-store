import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agents,
  cartMandates,
  merchants,
  orderItems,
  orders,
  receipts,
  variants,
} from '../db/schema.js';
import type { StorefrontDeps } from '../deps.js';
import { missingHappyPathSteps, REQUIRED_HAPPY_PATH } from '../domain/auditEvents.js';
import { readPurchaseAuditChain } from '../domain/auditLog.js';
import { canonicalJson } from '../domain/canonicalJson.js';
import { verifyMessage } from '../domain/keys.js';
import { applyGatewayWebhook, type WebhookOutcome } from '../domain/orders.js';
import { StubGateway, type SyntheticWebhook } from '../gateway/stubGateway.js';
import { auditChain, call } from '../testSupport/mcpTestClient.js';
import { createTestDatabase, type TestDatabaseHandle } from '../testSupport/pgliteDatabase.js';
import { MERCHANT_ID, seedCatalog } from '../testSupport/seedCatalog.js';
import { createMcpServer } from './server.js';

/**
 * T4's acceptance proof (issue #5), driven through the protocol seam — the MCP
 * tools a real buyer calls — with webhooks delivered the way the HTTP route
 * delivers them. Assertions read wire payloads and DB/audit rows back, never
 * server internals; the Receipt is re-verified *independently*, exactly as a
 * third party holding only the public keys would.
 *
 * Timestamped payloads hash differently on every run, so no test asserts an
 * exact hash value — hashes are asserted to *match each other* across the
 * chain, which is the property the protocol actually promises.
 */

const TEE = 'var_test_tee_default';
const CAP = 'var_test_cap_default';

describe('the mandate chain, through the MCP tools', () => {
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

  async function declareIntent(budgetPaise = 400000): Promise<string> {
    const { isError, body } = await call(client, 'declare_intent', {
      agentToken,
      want: 'a tee and a cap',
      budgetPaise,
    });
    expect(isError).toBe(false);
    return body['intentHash'] as string;
  }

  async function createCart(
    intentHash: string,
    items: Array<{ variantId: string; quantity: number }>,
  ): Promise<Record<string, unknown>> {
    const { isError, body } = await call(client, 'create_cart', { agentToken, intentHash, items });
    expect(isError).toBe(false);
    return body;
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

  it('happy path: intent → two-item cart → payment → webhooks → paid Order with a verifiable Receipt', async () => {
    const intent = await call(client, 'declare_intent', {
      agentToken,
      want: 'two tees and a cap',
      budgetPaise: 400000,
    });
    expect(intent.isError).toBe(false);
    const intentHash = intent.body['intentHash'] as string;
    expect(intentHash).toMatch(/^[0-9a-f]{64}$/);

    const cart = await createCart(intentHash, [
      { variantId: TEE, quantity: 2 },
      { variantId: CAP, quantity: 1 },
    ]);
    const cartHash = cart['cartHash'] as string;
    const cartPayload = cart['payload'] as Record<string, unknown>;
    expect(cartPayload['intentHash']).toBe(intentHash);
    expect((cart['total'] as Record<string, unknown>)['amountPaise']).toBe(2 * 129900 + 49900);

    // Both signatures on the Cart verify against the public keys the buyer can
    // hold — the agent's from registration, the merchant's from the storefront.
    const [agentRow] = await deps.db.select().from(agents).where(eq(agents.id, agentId));
    const [merchantRow] = await deps.db
      .select()
      .from(merchants)
      .where(eq(merchants.id, MERCHANT_ID));
    expect(
      verifyMessage(agentRow!.publicKey, canonicalJson(cartPayload), cart['agentSignature'] as string),
    ).toBe(true);
    expect(
      verifyMessage(
        merchantRow!.signingPublicKey!,
        canonicalJson(cartPayload),
        cart['merchantSignature'] as string,
      ),
    ).toBe(true);

    const payment = await call(client, 'submit_payment', {
      agentToken,
      cartHash,
      idempotencyKey: randomUUID(),
    });
    expect(payment.isError).toBe(false);
    const orderId = payment.body['orderId'] as string;
    expect(payment.body['status']).toBe('awaiting_payment');
    expect((payment.body['total'] as Record<string, unknown>)['amountPaise']).toBe(309700);
    expect(payment.body['items']).toHaveLength(2);
    expect(typeof payment.body['paymentLinkUrl']).toBe('string');
    const paymentMandate = payment.body['paymentMandate'] as Record<string, unknown>;
    const paymentHash = paymentMandate['paymentHash'] as string;

    // The Order row is mandate-shaped: attributed to the Agent, line items in
    // order_items, legacy single-variant columns never written.
    const [orderRow] = await deps.db.select().from(orders).where(eq(orders.id, orderId));
    expect(orderRow!.agentId).toBe(agentId);
    expect(orderRow!.variantId).toBeNull();
    expect(orderRow!.quantity).toBeNull();
    expect(orderRow!.amountPaise).toBe(309700);
    expect(await deps.db.select().from(orderItems)).toHaveLength(2);

    // Both sibling webhooks for the one purchase; the second must be free.
    const hooks = gateway.completePayment(payment.body['gatewayPaymentLinkId'] as string);
    expect(await deliver(hooks[0]!)).toEqual({ result: 'order_paid', orderId });
    expect(await deliver(hooks[1]!)).toEqual({ result: 'already_paid', orderId });

    // The buyer retrieves the Receipt and the TEST re-verifies it
    // independently: merchant public key + canonical payload + signature,
    // nothing taken on the server's word.
    const status = await call(client, 'get_order_status', { agentToken, orderId });
    expect(status.isError).toBe(false);
    expect(status.body['status']).toBe('paid');
    expect(status.body['items']).toHaveLength(2);
    const receipt = status.body['receipt'] as Record<string, unknown>;
    const receiptPayload = receipt['payload'] as Record<string, unknown>;
    expect(
      verifyMessage(
        receipt['merchantPublicKey'] as string,
        canonicalJson(receiptPayload),
        receipt['signature'] as string,
      ),
    ).toBe(true);
    // The Receipt names exactly the three mandates the buyer holds.
    expect(receiptPayload['orderId']).toBe(orderId);
    expect(receiptPayload['intentHash']).toBe(intentHash);
    expect(receiptPayload['cartHash']).toBe(cartHash);
    expect(receiptPayload['paymentHash']).toBe(paymentHash);
    expect(receiptPayload['amountPaise']).toBe(309700);
    expect(receiptPayload['gatewayPaymentId']).toBe('pay_stub_1');

    // The audit chain, by seq, shows every step of the purchase exactly once.
    const chain = await auditChain(deps.db);
    expect(chain.map((e) => e.type)).toEqual([
      'agent.registered',
      'mandate.intent_declared',
      'mandate.cart_created',
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
    const verified = chain.find((e) => e.type === 'payment.verified')!;
    expect(verified.payload).toMatchObject({ intentHash, cartHash, paymentHash });

    // /audit/:orderId-style completeness: the purchase-scoped chain carries
    // every REQUIRED_HAPPY_PATH step, including the two mandate events written
    // before the Order existed.
    const purchaseChain = await readPurchaseAuditChain(deps.db, orderId);
    expect(missingHappyPathSteps(purchaseChain)).toEqual([]);
    for (const step of REQUIRED_HAPPY_PATH) {
      // Every transition happened exactly once. `gateway.webhook_received` is
      // the exception by design: both sibling deliveries are recorded facts.
      const expected = step === 'gateway.webhook_received' ? 2 : 1;
      expect(purchaseChain.filter((e) => e.type === step)).toHaveLength(expected);
    }

    // No secret ever reaches the audit log: not the bearer token, not the
    // custodial private key, not the merchant signing key.
    const serialized = JSON.stringify(chain.map((e) => e.payload));
    expect(serialized).not.toContain(agentToken);
    expect(serialized).not.toContain(agentRow!.privateKey);
    expect(serialized).not.toContain(merchantRow!.signingPrivateKey!);

    // A webhook redelivery after the fact mints no second Receipt.
    expect(await deliver(hooks[0]!)).toEqual({ result: 'already_paid', orderId });
    expect(await deps.db.select().from(receipts)).toHaveLength(1);
  });

  it('a tampered price fails closed: PRICE_CHANGED, no Order, no gateway contact — then recovers', async () => {
    const intentHash = await declareIntent();
    const cart = await createCart(intentHash, [{ variantId: TEE, quantity: 1 }]);

    // The merchant edits the price after the Cart was signed. The pinned price
    // hash is now a lie about the live catalog.
    await deps.db.update(variants).set({ pricePaise: 149900 }).where(eq(variants.id, TEE));

    const refused = await call(client, 'submit_payment', {
      agentToken,
      cartHash: cart['cartHash'] as string,
      idempotencyKey: randomUUID(),
    });
    expect(refused.isError).toBe(true);
    expect(refused.body['refusal']).toMatchObject({ code: 'PRICE_CHANGED', recoverable: true });

    // Fail-closed means *nothing* moved: no Order row, no gateway audit event
    // of any kind — and the refusal itself is on the log.
    expect(await deps.db.select().from(orders)).toHaveLength(0);
    const chain = await auditChain(deps.db);
    expect(chain.some((e) => e.type.startsWith('gateway.'))).toBe(false);
    const refusedEvent = chain.find((e) => e.type === 'payment.refused')!;
    expect(refusedEvent.orderId).toBeNull();
    expect(refusedEvent.payload).toMatchObject({
      code: 'PRICE_CHANGED',
      recoverable: true,
      cartHash: cart['cartHash'],
    });

    // Recoverable proven: a fresh Cart at the new price sails through.
    const recart = await createCart(intentHash, [{ variantId: TEE, quantity: 1 }]);
    expect((recart['total'] as Record<string, unknown>)['amountPaise']).toBe(149900);
    const paid = await call(client, 'submit_payment', {
      agentToken,
      cartHash: recart['cartHash'] as string,
      idempotencyKey: randomUUID(),
    });
    expect(paid.isError).toBe(false);
    expect(paid.body['status']).toBe('awaiting_payment');
  });

  it('unpaid Cart mandates coexist: paying one leaves the other stored, byte for byte', async () => {
    const intentHash = await declareIntent();
    const first = await createCart(intentHash, [{ variantId: TEE, quantity: 1 }]);
    const second = await createCart(intentHash, [{ variantId: CAP, quantity: 2 }]);

    const firstRowBefore = await deps.db
      .select()
      .from(cartMandates)
      .where(eq(cartMandates.hash, first['cartHash'] as string));
    expect(firstRowBefore).toHaveLength(1);

    // Paying the *second* cart works — creating it invalidated nothing, and
    // paying it invalidates nothing either (ADR-0002: no cart lifecycle).
    const paid = await call(client, 'submit_payment', {
      agentToken,
      cartHash: second['cartHash'] as string,
      idempotencyKey: randomUUID(),
    });
    expect(paid.isError).toBe(false);

    expect(await deps.db.select().from(cartMandates)).toHaveLength(2);
    const firstRowAfter = await deps.db
      .select()
      .from(cartMandates)
      .where(eq(cartMandates.hash, first['cartHash'] as string));
    expect(firstRowAfter).toEqual(firstRowBefore);
  });

  it('unknown mandate references are validation errors, not Refusals', async () => {
    const bogusHash = 'a'.repeat(64);

    const cart = await call(client, 'create_cart', {
      agentToken,
      intentHash: bogusHash,
      items: [{ variantId: TEE, quantity: 1 }],
    });
    expect(cart.isError).toBe(true);
    expect((cart.body['validationError'] as Record<string, unknown>)['code']).toBe(
      'INTENT_NOT_FOUND',
    );
    expect('refusal' in cart.body).toBe(false);

    const payment = await call(client, 'submit_payment', {
      agentToken,
      cartHash: bogusHash,
      idempotencyKey: randomUUID(),
    });
    expect(payment.isError).toBe(true);
    expect((payment.body['validationError'] as Record<string, unknown>)['code']).toBe(
      'CART_NOT_FOUND',
    );

    // Bad references never reach policy: no payment.refused, no Order.
    const chain = await auditChain(deps.db);
    expect(chain.some((e) => e.type === 'payment.refused')).toBe(false);
    expect(await deps.db.select().from(orders)).toHaveLength(0);
  });

  it('a tampered stored signature refuses INVALID_MANDATE and is audited; no Order exists', async () => {
    const intentHash = await declareIntent();
    const cart = await createCart(intentHash, [{ variantId: TEE, quantity: 1 }]);
    const cartHash = cart['cartHash'] as string;

    // Corrupt the stored agent signature with a *well-formed but wrong* one —
    // the merchant's signature over the same payload: valid base64, valid
    // Ed25519 bytes, wrong key. Verification must fail on substance, not shape.
    const wrongSignature = cart['merchantSignature'] as string;
    await deps.db
      .update(cartMandates)
      .set({ agentSignature: wrongSignature })
      .where(eq(cartMandates.hash, cartHash));

    const refused = await call(client, 'submit_payment', {
      agentToken,
      cartHash,
      idempotencyKey: randomUUID(),
    });
    expect(refused.isError).toBe(true);
    expect(refused.body['refusal']).toMatchObject({ code: 'INVALID_MANDATE', recoverable: false });

    expect(await deps.db.select().from(orders)).toHaveLength(0);
    const chain = await auditChain(deps.db);
    expect(chain.some((e) => e.type.startsWith('gateway.'))).toBe(false);
    expect(chain.find((e) => e.type === 'payment.refused')!.payload).toMatchObject({
      code: 'INVALID_MANDATE',
      cartHash,
    });
  });

  it('insufficient stock at payment time refuses OUT_OF_STOCK before the gateway', async () => {
    const intentHash = await declareIntent();
    // Carting reserves nothing and checks nothing — five tees cart fine
    // against a stock of three. Payment is where stock is enforced.
    const cart = await createCart(intentHash, [{ variantId: TEE, quantity: 5 }]);

    const refused = await call(client, 'submit_payment', {
      agentToken,
      cartHash: cart['cartHash'] as string,
      idempotencyKey: randomUUID(),
    });
    expect(refused.isError).toBe(true);
    expect(refused.body['refusal']).toMatchObject({ code: 'OUT_OF_STOCK', recoverable: true });

    expect(await deps.db.select().from(orders)).toHaveLength(0);
    const chain = await auditChain(deps.db);
    expect(chain.some((e) => e.type.startsWith('gateway.'))).toBe(false);
    expect(chain.some((e) => e.type === 'payment.refused')).toBe(true);
  });
});

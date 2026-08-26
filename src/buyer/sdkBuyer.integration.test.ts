import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agents,
  cartMandates,
  intentMandates,
  orders,
  paymentMandates,
} from '../db/schema.js';
import type { StorefrontDeps } from '../deps.js';
import { missingHappyPathSteps } from '../domain/auditEvents.js';
import { readPurchaseAuditChain } from '../domain/auditLog.js';
import { canonicalJson } from '../domain/canonicalJson.js';
import { generateSigningKeypair, verifyMessage } from '../domain/keys.js';
import { parseCartMandatePayload } from '../domain/mandates.js';
import { applyGatewayWebhook, type WebhookOutcome } from '../domain/orders.js';
import { StubGateway, type SyntheticWebhook } from '../gateway/stubGateway.js';
import { auditChain, call } from '../testSupport/mcpTestClient.js';
import { createTestDatabase, type TestDatabaseHandle } from '../testSupport/pgliteDatabase.js';
import { MERCHANT_ID, seedCatalog } from '../testSupport/seedCatalog.js';
import { createMcpServer } from '../mcp/server.js';
import { LocalSigner } from './localSigner.js';
import { runSdkBuyerPurchase } from './sdkBuyer.js';

/**
 * T6's acceptance proof (issue #7): the client-custody buyer completes a full
 * purchase against the SAME protocol surface, holding its Ed25519 key
 * client-side (ADR-0004). Driven through the MCP tools over an in-memory
 * client/server pair exactly like the custodial suites — the custody split
 * lives in the protocol arguments, not in a different door.
 *
 * What must hold, and is asserted from wire payloads and DB/audit rows only:
 * the server never stores a private key for this Agent; every agent-side
 * signature stored or verified server-side is byte-identical to one computed
 * locally; a wrong local signature fails closed before any Order or gateway
 * contact; and the Receipt independently verifies against the merchant key.
 */

const TEE = 'var_test_tee_default';
const CAP = 'var_test_cap_default';

describe('the client-custody SDK buyer, through the MCP tools', () => {
  let handle: TestDatabaseHandle;
  let gateway: StubGateway;
  let deps: StorefrontDeps;
  let client: Client;

  /** The same three steps the webhook route performs, minus the socket. */
  async function deliver(hook: SyntheticWebhook): Promise<WebhookOutcome> {
    expect(deps.gateway.verifyWebhookSignature(hook.rawBody, hook.signature)).toBe(true);
    const event = deps.gateway.parseWebhookEvent(hook.rawBody);
    return applyGatewayWebhook(deps.db, deps.merchantId, event, deps.gateway.name);
  }

  /** Register a client-custody Agent for the manual (non-runSdkBuyerPurchase) tests. */
  async function registerClientAgent(signer: LocalSigner) {
    const { isError, body } = await call(client, 'register_agent', {
      capPaise: 500000,
      publicKey: signer.publicKey,
    });
    expect(isError).toBe(false);
    return {
      agentId: body['agentId'] as string,
      agentToken: body['agentToken'] as string,
      merchantId: body['merchantId'] as string,
    };
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
    client = new Client({ name: 'sdk-buyer-test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await handle.close();
  });

  it('full purchase with locally-computed signatures: paid Order, verifiable Receipt, no private key server-side', async () => {
    // The keypair is minted OUTSIDE the server process's reach; holding it
    // here also lets the test assert the private key appears nowhere.
    const keypair = generateSigningKeypair();
    const signer = new LocalSigner(keypair);

    const purchase = await runSdkBuyerPurchase(client, signer, {
      capPaise: 500000,
      want: 'a tee and a cap, signed locally',
      budgetPaise: 400000,
      items: [
        { variantId: TEE, quantity: 2 },
        { variantId: CAP, quantity: 1 },
      ],
      approvePayment: async (payment) => {
        const hooks = gateway.completePayment(payment.gatewayPaymentLinkId);
        expect(await deliver(hooks[0]!)).toEqual({
          result: 'order_paid',
          orderId: payment.orderId,
        });
        expect(await deliver(hooks[1]!)).toEqual({
          result: 'already_paid',
          orderId: payment.orderId,
        });
      },
    });

    // (b) The server never held the key: the Agent row stores the public key
    // with private_key NULL — custody is the column, not a flag.
    const [agentRow] = await deps.db
      .select()
      .from(agents)
      .where(eq(agents.id, purchase.agentId));
    expect(agentRow!.publicKey).toBe(signer.publicKey);
    expect(agentRow!.privateKey).toBeNull();

    // (a) Every stored agent-side signature is byte-identical to the one the
    // buyer computed locally, and verifies against the registered public key —
    // the server verified them, it could not have made them.
    const [intentRow] = await deps.db
      .select()
      .from(intentMandates)
      .where(eq(intentMandates.hash, purchase.intent.hash));
    expect(intentRow!.agentSignature).toBe(purchase.intent.signature);
    expect(
      verifyMessage(signer.publicKey, canonicalJson(intentRow!.payload), intentRow!.agentSignature),
    ).toBe(true);

    const [cartRow] = await deps.db
      .select()
      .from(cartMandates)
      .where(eq(cartMandates.hash, purchase.cart.hash));
    // The deferred cart signature was persisted at payment time (NULL → value).
    expect(cartRow!.agentSignature).toBe(purchase.cart.signature);
    expect(
      verifyMessage(signer.publicKey, canonicalJson(cartRow!.payload), cartRow!.agentSignature!),
    ).toBe(true);
    expect(
      verifyMessage(
        purchase.receipt.merchantPublicKey,
        canonicalJson(cartRow!.payload),
        cartRow!.merchantSignature,
      ),
    ).toBe(true);

    const [paymentRow] = await deps.db
      .select()
      .from(paymentMandates)
      .where(eq(paymentMandates.hash, purchase.payment.hash));
    expect(paymentRow!.agentSignature).toBe(purchase.payment.signature);
    expect(
      verifyMessage(
        signer.publicKey,
        canonicalJson(paymentRow!.payload),
        paymentRow!.agentSignature,
      ),
    ).toBe(true);

    // The Order is paid and the buyer's independently-verified Receipt names
    // exactly the three locally-known mandate hashes (runSdkBuyerPurchase
    // already verified the merchant signature; re-check from the test too).
    const [orderRow] = await deps.db.select().from(orders).where(eq(orders.id, purchase.orderId));
    expect(orderRow!.status).toBe('paid');
    expect(orderRow!.amountPaise).toBe(2 * 129900 + 49900);
    expect(
      verifyMessage(
        purchase.receipt.merchantPublicKey,
        canonicalJson({ ...purchase.receipt.payload }),
        purchase.receipt.signature,
      ),
    ).toBe(true);
    expect(purchase.receipt.payload.intentHash).toBe(purchase.intent.hash);
    expect(purchase.receipt.payload.cartHash).toBe(purchase.cart.hash);
    expect(purchase.receipt.payload.paymentHash).toBe(purchase.payment.hash);

    // The audit chain is the custodial happy path, step for step — the custody
    // split changed who signs, not what is recorded. Registration says which.
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
    expect(chain[0]!.payload).toMatchObject({ custody: 'client', publicKey: signer.publicKey });
    expect(missingHappyPathSteps(await readPurchaseAuditChain(deps.db, purchase.orderId))).toEqual(
      [],
    );

    // The private key reached NOTHING the server stores: not the agents row
    // (asserted NULL above), not a mandate row, not the audit log.
    expect(JSON.stringify(await auditChain(deps.db))).not.toContain(keypair.privateKey);
    expect(JSON.stringify(purchase)).not.toContain(keypair.privateKey);
  });

  it("create_cart stores no agent signature for a client-custody Agent until payment persists the buyer's own", async () => {
    const signer = new LocalSigner();
    const { agentId, agentToken, merchantId } = await registerClientAgent(signer);

    const intent = signer.composeIntent({
      agentId,
      merchantId,
      want: 'a tee',
      budgetPaise: 200000,
    });
    const declared = await call(client, 'declare_intent', {
      agentToken,
      want: 'a tee',
      budgetPaise: 200000,
      createdAt: intent.payload.createdAt,
      signature: intent.signature,
    });
    expect(declared.isError).toBe(false);
    expect(declared.body['intentHash']).toBe(intent.hash);

    const cartBody = await call(client, 'create_cart', {
      agentToken,
      intentHash: intent.hash,
      items: [{ variantId: TEE, quantity: 1 }],
    });
    expect(cartBody.isError).toBe(false);
    // On the wire and in the row: the server did NOT sign for the Agent.
    expect(cartBody.body['agentSignature']).toBeNull();
    const cartHash = cartBody.body['cartHash'] as string;
    const [rowBefore] = await deps.db
      .select()
      .from(cartMandates)
      .where(eq(cartMandates.hash, cartHash));
    expect(rowBefore!.agentSignature).toBeNull();
    expect(rowBefore!.merchantSignature).not.toBe('');

    const cart = signer.signCart(parseCartMandatePayload(cartBody.body['payload']));
    const payment = signer.composePayment({
      agentId,
      merchantId,
      cartHash,
      idempotencyKey: randomUUID(),
    });
    const submitted = await call(client, 'submit_payment', {
      agentToken,
      cartHash,
      idempotencyKey: payment.payload.idempotencyKey,
      cartSignature: cart.signature,
      paymentCreatedAt: payment.payload.createdAt,
      paymentSignature: payment.signature,
    });
    expect(submitted.isError).toBe(false);

    const [rowAfter] = await deps.db
      .select()
      .from(cartMandates)
      .where(eq(cartMandates.hash, cartHash));
    expect(rowAfter!.agentSignature).toBe(cart.signature);
    // Only the deferred signature changed — payload and merchant signature are
    // immutable as ever (ADR-0002).
    expect(rowAfter!.payload).toEqual(rowBefore!.payload);
    expect(rowAfter!.merchantSignature).toBe(rowBefore!.merchantSignature);
  });

  it("a wrong Intent signature refuses INVALID_MANDATE, is audited, and stores nothing", async () => {
    const signer = new LocalSigner();
    const imposter = new LocalSigner();
    const { agentId, agentToken, merchantId } = await registerClientAgent(signer);

    // Signed by the WRONG key over the right payload: well-formed base64,
    // real Ed25519 bytes — verification must fail on substance, not shape.
    const forged = imposter.composeIntent({
      agentId,
      merchantId,
      want: 'a tee',
      budgetPaise: 200000,
    });
    const { isError, body } = await call(client, 'declare_intent', {
      agentToken,
      want: 'a tee',
      budgetPaise: 200000,
      createdAt: forged.payload.createdAt,
      signature: forged.signature,
    });
    expect(isError).toBe(true);
    expect(body['refusal']).toMatchObject({ code: 'INVALID_MANDATE', recoverable: false });

    // Fail closed: no Intent mandate row, and the refusal is on the log.
    expect(await deps.db.select().from(intentMandates)).toHaveLength(0);
    const chain = await auditChain(deps.db);
    expect(chain.map((e) => e.type)).toEqual(['agent.registered', 'mandate.refused']);
    expect(chain[1]!.payload).toMatchObject({
      code: 'INVALID_MANDATE',
      recoverable: false,
      tool: 'declare_intent',
      agentId,
    });
  });

  it('a tampered cart or payment signature at submit_payment refuses INVALID_MANDATE; no Order, no gateway contact', async () => {
    const signer = new LocalSigner();
    const imposter = new LocalSigner();
    const { agentId, agentToken, merchantId } = await registerClientAgent(signer);

    const intent = signer.composeIntent({
      agentId,
      merchantId,
      want: 'a tee',
      budgetPaise: 200000,
    });
    await call(client, 'declare_intent', {
      agentToken,
      want: 'a tee',
      budgetPaise: 200000,
      createdAt: intent.payload.createdAt,
      signature: intent.signature,
    });
    const cartBody = await call(client, 'create_cart', {
      agentToken,
      intentHash: intent.hash,
      items: [{ variantId: TEE, quantity: 1 }],
    });
    const cartHash = cartBody.body['cartHash'] as string;
    const cartPayload = parseCartMandatePayload(cartBody.body['payload']);
    const goodCart = signer.signCart(cartPayload);
    const wrongCart = imposter.signCart(cartPayload);

    // Wrong key on the cart signature.
    const payment = signer.composePayment({
      agentId,
      merchantId,
      cartHash,
      idempotencyKey: randomUUID(),
    });
    const refusedCart = await call(client, 'submit_payment', {
      agentToken,
      cartHash,
      idempotencyKey: payment.payload.idempotencyKey,
      cartSignature: wrongCart.signature,
      paymentCreatedAt: payment.payload.createdAt,
      paymentSignature: payment.signature,
    });
    expect(refusedCart.isError).toBe(true);
    expect(refusedCart.body['refusal']).toMatchObject({
      code: 'INVALID_MANDATE',
      recoverable: false,
    });

    // Right cart signature, but the payment signature covers OTHER bytes than
    // the payload named by (cartHash, idempotencyKey, createdAt).
    const otherPayment = signer.composePayment({
      agentId,
      merchantId,
      cartHash,
      idempotencyKey: randomUUID(),
    });
    const refusedPayment = await call(client, 'submit_payment', {
      agentToken,
      cartHash,
      idempotencyKey: randomUUID(),
      cartSignature: goodCart.signature,
      paymentCreatedAt: new Date().toISOString(),
      paymentSignature: otherPayment.signature,
    });
    expect(refusedPayment.isError).toBe(true);
    expect(refusedPayment.body['refusal']).toMatchObject({
      code: 'INVALID_MANDATE',
      recoverable: false,
    });

    // Fail closed, both times: no Order, no payment mandate, cart signature
    // still NULL, gateway never contacted — and both refusals audited.
    expect(await deps.db.select().from(orders)).toHaveLength(0);
    expect(await deps.db.select().from(paymentMandates)).toHaveLength(0);
    const [cartRow] = await deps.db
      .select()
      .from(cartMandates)
      .where(eq(cartMandates.hash, cartHash));
    expect(cartRow!.agentSignature).toBeNull();
    const chain = await auditChain(deps.db);
    expect(chain.some((e) => e.type.startsWith('gateway.'))).toBe(false);
    expect(chain.filter((e) => e.type === 'payment.refused')).toHaveLength(2);

    // Recoverability proven the honest way: the SAME cart, correctly signed,
    // sails through — the refusals above were about those signatures only.
    // (The first attempt's key is reusable: a refusal persists no payment
    // mandate, so it never consumed the key the payment payload was signed over.)
    const goodSubmit = await call(client, 'submit_payment', {
      agentToken,
      cartHash,
      idempotencyKey: payment.payload.idempotencyKey,
      cartSignature: goodCart.signature,
      paymentCreatedAt: payment.payload.createdAt,
      paymentSignature: payment.signature,
    });
    expect(goodSubmit.isError).toBe(false);
    expect(goodSubmit.body['status']).toBe('awaiting_payment');
  });

  it('custody arguments that contradict the registration are validation errors, not Refusals', async () => {
    // A client-custody Agent omitting its signature inputs...
    const signer = new LocalSigner();
    const clientAgent = await registerClientAgent(signer);
    const missing = await call(client, 'declare_intent', {
      agentToken: clientAgent.agentToken,
      want: 'a tee',
      budgetPaise: 200000,
    });
    expect(missing.isError).toBe(true);
    expect((missing.body['validationError'] as Record<string, unknown>)['code']).toBe(
      'CUSTODY_MISMATCH',
    );
    expect('refusal' in missing.body).toBe(false);

    // ...a malformed client-minted timestamp...
    const badCreatedAt = await call(client, 'declare_intent', {
      agentToken: clientAgent.agentToken,
      want: 'a tee',
      budgetPaise: 200000,
      createdAt: 'not-a-timestamp',
      signature: signer.composeIntent({
        agentId: clientAgent.agentId,
        merchantId: clientAgent.merchantId,
        want: 'a tee',
        budgetPaise: 200000,
      }).signature,
    });
    expect(badCreatedAt.isError).toBe(true);
    expect((badCreatedAt.body['validationError'] as Record<string, unknown>)['code']).toBe(
      'INVALID_CREATED_AT',
    );

    // ...and a custodial Agent supplying signature arguments are all malformed
    // requests — never policy, never silently "corrected" by server signing.
    const custodial = await call(client, 'register_agent', { capPaise: 500000 });
    const custodialToken = custodial.body['agentToken'] as string;
    expect(custodial.body['custody']).toBe('custodial');
    const unexpected = await call(client, 'declare_intent', {
      agentToken: custodialToken,
      want: 'a tee',
      budgetPaise: 200000,
      createdAt: new Date().toISOString(),
      signature: 'someone-elses-signature',
    });
    expect(unexpected.isError).toBe(true);
    expect((unexpected.body['validationError'] as Record<string, unknown>)['code']).toBe(
      'CUSTODY_MISMATCH',
    );

    // Nothing mandate-shaped was stored by any of them.
    expect(await deps.db.select().from(intentMandates)).toHaveLength(0);
  });

  it('a garbage publicKey at registration is INVALID_PUBLIC_KEY; no Agent is minted', async () => {
    for (const publicKey of ['not-a-key', 'aGVsbG8=', generateSigningKeypair().privateKey]) {
      const { isError, body } = await call(client, 'register_agent', {
        capPaise: 500000,
        publicKey,
      });
      expect(isError).toBe(true);
      expect((body['validationError'] as Record<string, unknown>)['code']).toBe(
        'INVALID_PUBLIC_KEY',
      );
    }
    expect(await deps.db.select().from(agents)).toHaveLength(0);
    expect((await auditChain(deps.db)).map((e) => e.type)).toEqual([]);
  });

  it('the custodial path is untouched: registering without a publicKey still mints a server-held keypair', async () => {
    const { isError, body } = await call(client, 'register_agent', { capPaise: 500000 });
    expect(isError).toBe(false);
    expect(body['custody']).toBe('custodial');
    const [row] = await deps.db
      .select()
      .from(agents)
      .where(eq(agents.id, body['agentId'] as string));
    expect(row!.privateKey).not.toBeNull();
    expect(row!.publicKey).toBe(body['publicKey']);
  });
});

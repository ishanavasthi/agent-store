import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MERCHANT_NAME } from '../config.js';
import type { StorefrontDeps } from '../deps.js';
import { missingHappyPathSteps } from '../domain/auditEvents.js';
import { readPurchaseAuditChain } from '../domain/auditLog.js';
import { canonicalJson } from '../domain/canonicalJson.js';
import { verifyMessage } from '../domain/keys.js';
import { RAZORPAY_SIGNATURE_HEADER } from '../gateway/razorpayWebhook.js';
import { StubGateway, type SyntheticWebhook } from '../gateway/stubGateway.js';
import { createMcpServer } from '../mcp/server.js';
import { call } from '../testSupport/mcpTestClient.js';
import { createTestDatabase, type TestDatabaseHandle } from '../testSupport/pgliteDatabase.js';
import { MERCHANT_ID, seedCatalog } from '../testSupport/seedCatalog.js';
import { createApp } from './app.js';

/**
 * T14's acceptance proof (issue #15): the ACP-flavored REST twin.
 *
 * Everything REST here goes over real HTTP against an ephemeral port —
 * including the gateway webhooks — so the suite is literally the curl sequence
 * from the PR, automated. The MCP face runs beside it (in-memory transport, as
 * every MCP suite drives it) purely as the *reference shape*: the acceptance
 * criterion is that a Refusal and a Receipt are identical across both faces,
 * so this suite performs the same purchases and the same failures through both
 * doors and compares the wire bodies.
 */

const TEE = 'var_test_tee_default';
const CAP_VARIANT = 'var_test_cap_default';
const TEE_PRICE = 129900;

const PUBLIC_BASE_URL = 'https://merchant.example';

interface HttpResult {
  readonly status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly body: any;
}

describe('T14 REST twin and discovery doc', () => {
  let handle: TestDatabaseHandle;
  let gateway: StubGateway;
  let deps: StorefrontDeps;
  let server: Server;
  let baseUrl: string;
  let mcpClient: Client;

  async function getJson(pathname: string, token?: string): Promise<HttpResult> {
    const response = await fetch(`${baseUrl}${pathname}`, {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });
    return { status: response.status, body: await response.json() };
  }

  async function postJson(
    pathname: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ): Promise<HttpResult> {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  /** Deliver a stub webhook exactly as Razorpay would: over the HTTP route. */
  async function deliverOverHttp(hook: SyntheticWebhook): Promise<HttpResult> {
    const response = await fetch(`${baseUrl}/webhooks/razorpay`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [RAZORPAY_SIGNATURE_HEADER]: hook.signature,
      },
      body: hook.rawBody,
    });
    return { status: response.status, body: await response.json() };
  }

  /** register → intent → cart, via REST. Returns what the next step needs. */
  async function restCart(
    items: Array<{ variantId: string; quantity: number }>,
    budgetPaise = 400000,
  ): Promise<{ token: string; intentHash: string; cartHash: string }> {
    const agent = await postJson('/acp/agents', { capPaise: 500000 });
    expect(agent.status).toBe(201);
    const token = agent.body.agentToken as string;
    const intent = await postJson(
      '/acp/intents',
      { want: 'something nice', budgetPaise },
      { authorization: `Bearer ${token}` },
    );
    expect(intent.status).toBe(201);
    const cart = await postJson(
      '/acp/carts',
      { intentHash: intent.body.intentHash, items },
      { authorization: `Bearer ${token}` },
    );
    expect(cart.status).toBe(201);
    return {
      token,
      intentHash: intent.body.intentHash as string,
      cartHash: cart.body.cartHash as string,
    };
  }

  beforeEach(async () => {
    handle = await createTestDatabase();
    gateway = new StubGateway();
    deps = {
      db: handle.db,
      gateway,
      merchantId: MERCHANT_ID,
      publicBaseUrl: PUBLIC_BASE_URL,
    };
    await seedCatalog(deps.db, 3);

    server = createServer(createApp(deps));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const mcpServer = createMcpServer(deps);
    mcpClient = new Client({ name: 'test-buyer', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcpServer.connect(serverTransport), mcpClient.connect(clientTransport)]);
  });

  afterEach(async () => {
    server.close();
    await mcpClient.close();
    await handle.close();
  });

  it('serves a discovery doc at /.well-known/agent-store.json describing both faces', async () => {
    const { status, body } = await getJson('/.well-known/agent-store.json');
    expect(status).toBe(200);
    expect(body.service).toBe('agent-store');
    expect(body.merchant).toEqual({ id: MERCHANT_ID, name: MERCHANT_NAME });

    // Both faces, with URLs rooted at PUBLIC_BASE_URL — never the bind address.
    expect(body.faces.mcp.endpoint).toBe(`${PUBLIC_BASE_URL}/mcp`);
    expect(body.faces.mcp.transport).toBe('streamable-http');
    expect(body.faces.mcp.tools).toEqual([
      'get_product',
      'register_agent',
      'declare_intent',
      'create_cart',
      'submit_payment',
      'get_order_status',
    ]);
    expect(body.faces.rest.baseUrl).toBe(`${PUBLIC_BASE_URL}/acp`);

    // Every MCP tool has exactly one REST mirror, and every listed endpoint
    // answers (the doc can never describe a door that is not there).
    const endpoints = body.faces.rest.endpoints as Array<{
      method: string;
      path: string;
      mirrors: string;
    }>;
    expect(endpoints.map((e) => e.mirrors).sort()).toEqual(
      [...(body.faces.mcp.tools as string[])].sort(),
    );
    expect((await getJson('/acp/products')).status).toBe(200);

    // The failure vocabulary is documented: both shared shapes plus statuses.
    expect(body.faces.rest.errors.refusal.status).toBe(403);
    expect(body.faces.rest.errors.validationError).toBeDefined();

    // The root endpoint points at the doc too, for humans poking around.
    const root = await getJson('/');
    expect(root.body.discovery).toBe(`${PUBLIC_BASE_URL}/.well-known/agent-store.json`);
    expect(root.body.rest).toBe(`${PUBLIC_BASE_URL}/acp`);
  });

  it('a full purchase (register → intent → cart → payment) completes via REST alone', async () => {
    // --- 1. The shop window is public: no token, no registration -------------
    const products = await getJson('/acp/products');
    expect(products.status).toBe(200);
    expect(products.body.merchant).toBe(MERCHANT_NAME);
    const tee = (products.body.variants as Array<Record<string, unknown>>).find(
      (v) => v['variantId'] === TEE,
    )!;
    expect(tee['price']).toMatchObject({ amountPaise: TEE_PRICE });

    // --- 2. Register, declaring the Cap --------------------------------------
    const registration = await postJson('/acp/agents', { capPaise: 500000 });
    expect(registration.status).toBe(201);
    const token = registration.body.agentToken as string;
    expect(token).not.toBe('');
    expect(registration.body.custody).toBe('custodial');
    expect(registration.body.cap).toMatchObject({ amountPaise: 500000 });

    // --- 3. Intent mandate ----------------------------------------------------
    const intent = await postJson(
      '/acp/intents',
      { want: 'two tees and a cap', budgetPaise: 400000 },
      { authorization: `Bearer ${token}` },
    );
    expect(intent.status).toBe(201);
    const intentHash = intent.body.intentHash as string;
    expect(intentHash).toMatch(/^[0-9a-f]{64}$/);

    // --- 4. Cart mandate ------------------------------------------------------
    const cart = await postJson(
      '/acp/carts',
      {
        intentHash,
        items: [
          { variantId: TEE, quantity: 2 },
          { variantId: CAP_VARIANT, quantity: 1 },
        ],
      },
      { authorization: `Bearer ${token}` },
    );
    expect(cart.status).toBe(201);
    const cartHash = cart.body.cartHash as string;
    expect(cart.body.total).toMatchObject({ amountPaise: 2 * TEE_PRICE + 49900 });
    expect(cart.body.payload.intentHash).toBe(intentHash);

    // --- 5. Payment mandate — idempotency key on the ACP-style header ---------
    const payment = await postJson(
      '/acp/payments',
      { cartHash },
      { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
    );
    expect(payment.status).toBe(201);
    const orderId = payment.body.orderId as string;
    expect(payment.body.status).toBe('awaiting_payment');
    expect(typeof payment.body.paymentLinkUrl).toBe('string');
    expect(payment.body.auditUrl).toBe(`${PUBLIC_BASE_URL}/audit/${orderId}`);

    // --- 6. The human approves; Razorpay calls the webhook over HTTP ----------
    const hooks = gateway.completePayment(payment.body.gatewayPaymentLinkId as string);
    const first = await deliverOverHttp(hooks[0]!);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ received: true, result: 'order_paid', orderId });

    // --- 7. Order status carries the Receipt; verify it independently ---------
    const status = await getJson(`/acp/orders/${orderId}`, token);
    expect(status.status).toBe(200);
    expect(status.body.status).toBe('paid');
    expect(status.body.items).toHaveLength(2);
    const receipt = status.body.receipt as Record<string, unknown>;
    const receiptPayload = receipt['payload'] as Record<string, unknown>;
    expect(
      verifyMessage(
        receipt['merchantPublicKey'] as string,
        canonicalJson(receiptPayload),
        receipt['signature'] as string,
      ),
    ).toBe(true);
    expect(receiptPayload['orderId']).toBe(orderId);
    expect(receiptPayload['intentHash']).toBe(intentHash);
    expect(receiptPayload['cartHash']).toBe(cartHash);
    expect(receiptPayload['amountPaise']).toBe(2 * TEE_PRICE + 49900);

    // The purchase reads complete off the audit log — the REST door leaves the
    // same trail the MCP door does.
    expect(missingHappyPathSteps(await readPurchaseAuditChain(deps.db, orderId))).toEqual([]);

    // Reading an order without a token refuses like any other trust-gated call.
    const anonymous = await getJson(`/acp/orders/${orderId}`);
    expect(anonymous.status).toBe(403);
    expect(anonymous.body.refusal).toMatchObject({ code: 'UNREGISTERED_AGENT' });
  });

  it('Refusals, Receipts and validation errors are identical in shape across both faces', async () => {
    // --- The same happy purchase through each door ---------------------------
    // MCP face, exactly as every MCP suite drives it.
    const mcpRegistration = await call(mcpClient, 'register_agent', { capPaise: 500000 });
    const mcpToken = mcpRegistration.body['agentToken'] as string;
    const mcpIntent = await call(mcpClient, 'declare_intent', {
      agentToken: mcpToken,
      want: 'something nice',
      budgetPaise: 400000,
    });
    const mcpCart = await call(mcpClient, 'create_cart', {
      agentToken: mcpToken,
      intentHash: mcpIntent.body['intentHash'],
      items: [{ variantId: TEE, quantity: 1 }],
    });
    const mcpPayment = await call(mcpClient, 'submit_payment', {
      agentToken: mcpToken,
      cartHash: mcpCart.body['cartHash'],
      idempotencyKey: randomUUID(),
    });
    expect(mcpPayment.isError).toBe(false);

    // REST face, over the wire.
    const rest = await restCart([{ variantId: TEE, quantity: 1 }]);
    const restPayment = await postJson(
      '/acp/payments',
      { cartHash: rest.cartHash, idempotencyKey: randomUUID() },
      { authorization: `Bearer ${rest.token}` },
    );
    expect(restPayment.status).toBe(201);

    // Same keys at every shared step — the faces may word their `note`/
    // `nextStep` prose differently, but never differ in structure.
    const mcpProducts = await call(mcpClient, 'get_product', {});
    const restProducts = await getJson('/acp/products');
    expect(Object.keys(restProducts.body).sort()).toEqual(Object.keys(mcpProducts.body).sort());
    const restRegistration = await postJson('/acp/agents', { capPaise: 500000 });
    expect(Object.keys(restRegistration.body).sort()).toEqual(
      Object.keys(mcpRegistration.body).sort(),
    );
    expect(Object.keys(restPayment.body).sort()).toEqual(Object.keys(mcpPayment.body).sort());

    // Pay both orders through the same webhook door.
    for (const linkId of [
      mcpPayment.body['gatewayPaymentLinkId'] as string,
      restPayment.body.gatewayPaymentLinkId as string,
    ]) {
      const hooks = gateway.completePayment(linkId);
      expect((await deliverOverHttp(hooks[0]!)).status).toBe(200);
    }

    // --- Receipts: identical shape, independently verifiable, on both faces --
    const mcpStatus = await call(mcpClient, 'get_order_status', {
      agentToken: mcpToken,
      orderId: mcpPayment.body['orderId'],
    });
    const restStatus = await getJson(`/acp/orders/${restPayment.body.orderId}`, rest.token);
    expect(mcpStatus.body['status']).toBe('paid');
    expect(restStatus.body.status).toBe('paid');
    expect(Object.keys(restStatus.body).sort()).toEqual(Object.keys(mcpStatus.body).sort());

    const mcpReceipt = mcpStatus.body['receipt'] as Record<string, unknown>;
    const restReceipt = restStatus.body.receipt as Record<string, unknown>;
    expect(Object.keys(restReceipt).sort()).toEqual(Object.keys(mcpReceipt).sort());
    expect(Object.keys(restReceipt['payload'] as object).sort()).toEqual(
      Object.keys(mcpReceipt['payload'] as object).sort(),
    );
    for (const receipt of [mcpReceipt, restReceipt]) {
      expect(
        verifyMessage(
          receipt['merchantPublicKey'] as string,
          canonicalJson(receipt['payload'] as Record<string, unknown>),
          receipt['signature'] as string,
        ),
      ).toBe(true);
    }

    // --- Refusals: byte-identical payloads ------------------------------------
    // OUT_OF_STOCK — same items, same live stock, one refusal per face. The
    // cap variant is untouched by the tee purchases above, so both faces see
    // the same stock and must produce the very same reason string.
    const mcpSoldOutIntent = await call(mcpClient, 'declare_intent', {
      agentToken: mcpToken,
      want: 'five caps',
      budgetPaise: 400000,
    });
    const mcpSoldOutCart = await call(mcpClient, 'create_cart', {
      agentToken: mcpToken,
      intentHash: mcpSoldOutIntent.body['intentHash'],
      items: [{ variantId: CAP_VARIANT, quantity: 5 }],
    });
    const mcpRefused = await call(mcpClient, 'submit_payment', {
      agentToken: mcpToken,
      cartHash: mcpSoldOutCart.body['cartHash'],
      idempotencyKey: randomUUID(),
    });
    expect(mcpRefused.isError).toBe(true);

    const restSoldOut = await restCart([{ variantId: CAP_VARIANT, quantity: 5 }]);
    const restRefused = await postJson(
      '/acp/payments',
      { cartHash: restSoldOut.cartHash, idempotencyKey: randomUUID() },
      { authorization: `Bearer ${restSoldOut.token}` },
    );
    expect(restRefused.status).toBe(403);
    expect(restRefused.body.refusal).toMatchObject({ code: 'OUT_OF_STOCK', recoverable: true });
    // The acceptance criterion, literally: the Refusal is IDENTICAL — code,
    // reason, recoverable, the lot — not merely similar.
    expect(restRefused.body.refusal).toEqual(mcpRefused.body['refusal']);

    // UNREGISTERED_AGENT — the no-chain refusal, same token presented to both.
    const mcpUnregistered = await call(mcpClient, 'get_order_status', {
      agentToken: 'agt_tok_bogus',
      orderId: mcpPayment.body['orderId'],
    });
    const restUnregistered = await getJson(
      `/acp/orders/${restPayment.body.orderId}`,
      'agt_tok_bogus',
    );
    expect(restUnregistered.status).toBe(403);
    expect(restUnregistered.body.refusal).toEqual(mcpUnregistered.body['refusal']);

    // --- Validation errors: same shape, and REST maps the GET miss to 404 -----
    const mcpMissing = await call(mcpClient, 'get_order_status', {
      agentToken: mcpToken,
      orderId: 'ord_never_existed',
    });
    const restMissing = await getJson('/acp/orders/ord_never_existed', rest.token);
    expect(restMissing.status).toBe(404);
    expect(restMissing.body.validationError).toEqual(mcpMissing.body['validationError']);

    // A malformed body is the transport's no — deliberately NOT dressed as a
    // domain ValidationError, exactly as an MCP schema rejection is not.
    const malformed = await postJson('/acp/agents', { capPaise: 'lots' });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toBe('invalid_request');
    expect('validationError' in malformed.body).toBe(false);
  });
});

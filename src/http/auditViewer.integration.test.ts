import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalSigner } from '../buyer/localSigner.js';
import { MERCHANT_NAME } from '../config.js';
import { auditEvents, variants } from '../db/schema.js';
import type { StorefrontDeps } from '../deps.js';
import { applyGatewayWebhook, type WebhookOutcome } from '../domain/orders.js';
import { StubGateway, type SyntheticWebhook } from '../gateway/stubGateway.js';
import { createMcpServer } from '../mcp/server.js';
import { call } from '../testSupport/mcpTestClient.js';
import { createTestDatabase, type TestDatabaseHandle } from '../testSupport/pgliteDatabase.js';
import { MERCHANT_ID, seedCatalog } from '../testSupport/seedCatalog.js';
import { createApp } from './app.js';

/**
 * T7's server half (issue #8): the audit directory and refusal-timeline
 * endpoints the viewer SPA reads, plus the SPA serving contract itself —
 * driven exactly as production is driven: purchases through the MCP seam,
 * reads over real HTTP against an ephemeral port.
 */

const TEE = 'var_test_tee_default';
const CAP_VARIANT = 'var_test_cap_default';
const TEE_PRICE = 129900;

/**
 * One wire-shaped audit event, as every `/audit*` response spells it.
 * Deliberately re-declared, not imported: the test pins the wire contract
 * independently of the server's `WireAuditEvent` (src/domain/auditEvents.ts),
 * so a drift there fails here.
 */
interface WireAuditEvent {
  readonly seq: number;
  readonly type: string;
  readonly summary: string;
  readonly occurredAt: string;
  readonly payload: Record<string, unknown>;
}

describe('T7 audit endpoints and viewer serving', () => {
  let handle: TestDatabaseHandle;
  let gateway: StubGateway;
  let deps: StorefrontDeps;
  let client: Client;
  let agentToken: string;
  let server: Server;
  let baseUrl: string;
  let tempRoot: string;
  let viewerDistDir: string;

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
  ): Promise<string> {
    const { isError, body } = await call(client, 'create_cart', {
      agentToken: token,
      intentHash,
      items,
    });
    expect(isError).toBe(false);
    return body['cartHash'] as string;
  }

  async function getJson(pathname: string): Promise<{ status: number; body: any }> {
    const response = await fetch(`${baseUrl}${pathname}`);
    return { status: response.status, body: await response.json() };
  }

  beforeEach(async () => {
    handle = await createTestDatabase();
    gateway = new StubGateway();
    tempRoot = mkdtempSync(path.join(tmpdir(), 'agent-store-viewer-'));
    // Deliberately not created yet: the default state is "no viewer build".
    viewerDistDir = path.join(tempRoot, 'dist-viewer');
    deps = {
      db: handle.db,
      gateway,
      merchantId: MERCHANT_ID,
      publicBaseUrl: 'https://merchant.example',
      viewerDistDir,
    };
    await seedCatalog(deps.db, 3);

    const mcpServer = createMcpServer(deps);
    client = new Client({ name: 'test-buyer', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
    const registration = await call(client, 'register_agent', { capPaise: 500000 });
    agentToken = registration.body['agentToken'] as string;

    server = createServer(createApp(deps));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.close();
    await client.close();
    await handle.close();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('the directory and refusal timelines replay a happy purchase and each M2 refusal', async () => {
    // --- One happy purchase, paid end to end -------------------------------
    const paidIntent = await declareIntent(400000);
    const paidCart = await createCart(paidIntent, [{ variantId: TEE, quantity: 1 }]);
    const paidKey = randomUUID();
    const paid = await call(client, 'submit_payment', {
      agentToken,
      cartHash: paidCart,
      idempotencyKey: paidKey,
    });
    expect(paid.isError).toBe(false);
    const orderId = paid.body['orderId'] as string;
    const hooks = gateway.completePayment(paid.body['gatewayPaymentLinkId'] as string);
    expect(await deliver(hooks[0]!)).toEqual({ result: 'order_paid', orderId });

    // --- The M2 refusals, one per code -------------------------------------
    // OVER_BUDGET: a ₹1,299.00 tee against a ₹1,000.00 Budget.
    const overBudgetIntent = await declareIntent(100000);
    const overBudgetCart = await createCart(overBudgetIntent, [{ variantId: TEE, quantity: 1 }]);
    const overBudget = await call(client, 'submit_payment', {
      agentToken,
      cartHash: overBudgetCart,
      idempotencyKey: randomUUID(),
    });
    expect(overBudget.isError).toBe(true);

    // OVER_CAP: a fresh Agent whose very first purchase exceeds its Cap —
    // the Budget is roomy, so the code must say the Cap is what hit.
    const tight = await call(client, 'register_agent', { capPaise: 100000 });
    const tightToken = tight.body['agentToken'] as string;
    const overCapIntent = await declareIntent(400000, tightToken);
    const overCapCart = await createCart(overCapIntent, [{ variantId: TEE, quantity: 1 }], tightToken);
    const overCap = await call(client, 'submit_payment', {
      agentToken: tightToken,
      cartHash: overCapCart,
      idempotencyKey: randomUUID(),
    });
    expect(overCap.isError).toBe(true);

    // IDEMPOTENCY_REUSE: the paid purchase's key against a different cart.
    const reuseIntent = await declareIntent(400000);
    const reuseCart = await createCart(reuseIntent, [{ variantId: CAP_VARIANT, quantity: 1 }]);
    const reuse = await call(client, 'submit_payment', {
      agentToken,
      cartHash: reuseCart,
      idempotencyKey: paidKey,
    });
    expect(reuse.isError).toBe(true);

    // INTENT_CONSUMED: a second cart under the Intent the paid purchase consumed.
    const consumedCart = await createCart(paidIntent, [{ variantId: CAP_VARIANT, quantity: 1 }]);
    const consumed = await call(client, 'submit_payment', {
      agentToken,
      cartHash: consumedCart,
      idempotencyKey: randomUUID(),
    });
    expect(consumed.isError).toBe(true);

    // UNREGISTERED_AGENT: the no-chain refusal — its timeline is one event.
    const unregistered = await call(client, 'get_order_status', {
      agentToken: 'agt_tok_bogus',
      orderId,
    });
    expect(unregistered.isError).toBe(true);

    // PRICE_CHANGED: the merchant edits the tee's price after the Cart was
    // signed — the pinned price hash is now a lie about the live catalog.
    const staleIntent = await declareIntent(400000);
    const staleCart = await createCart(staleIntent, [{ variantId: TEE, quantity: 1 }]);
    await deps.db.update(variants).set({ pricePaise: 149900 }).where(eq(variants.id, TEE));
    const stale = await call(client, 'submit_payment', {
      agentToken,
      cartHash: staleCart,
      idempotencyKey: randomUUID(),
    });
    expect(stale.isError).toBe(true);

    // OUT_OF_STOCK: the cap sells out between carting and paying — carting
    // reserves nothing, so payment is where stock is enforced.
    const soldOutIntent = await declareIntent(400000);
    const soldOutCart = await createCart(soldOutIntent, [
      { variantId: CAP_VARIANT, quantity: 1 },
    ]);
    await deps.db.update(variants).set({ stock: 0 }).where(eq(variants.id, CAP_VARIANT));
    const soldOut = await call(client, 'submit_payment', {
      agentToken,
      cartHash: soldOutCart,
      idempotencyKey: randomUUID(),
    });
    expect(soldOut.isError).toBe(true);

    // INVALID_MANDATE: a client-custody Agent's Intent signed by the WRONG key —
    // well-formed Ed25519 bytes over the right payload, so verification fails
    // on substance, not shape. Refused before any mandate is stored.
    const signer = new LocalSigner();
    const imposter = new LocalSigner();
    const clientCustody = await call(client, 'register_agent', {
      capPaise: 500000,
      publicKey: signer.publicKey,
    });
    const forged = imposter.composeIntent({
      agentId: clientCustody.body['agentId'] as string,
      merchantId: clientCustody.body['merchantId'] as string,
      want: 'a tee',
      budgetPaise: 200000,
    });
    const forgedIntent = await call(client, 'declare_intent', {
      agentToken: clientCustody.body['agentToken'] as string,
      want: 'a tee',
      budgetPaise: 200000,
      createdAt: forged.payload.createdAt,
      signature: forged.signature,
    });
    expect(forgedIntent.isError).toBe(true);

    // --- GET /audit: the directory -----------------------------------------
    const directory = await getJson('/audit');
    expect(directory.status).toBe(200);
    expect(directory.body.merchant).toBe(MERCHANT_NAME);

    expect(directory.body.orders).toHaveLength(1);
    expect(directory.body.orders[0]).toMatchObject({
      orderId,
      status: 'paid',
      total: { amountPaise: TEE_PRICE, currency: 'INR' },
    });
    expect(new Date(directory.body.orders[0].createdAt).getTime()).not.toBeNaN();

    const refusals = directory.body.refusals as WireAuditEvent[];
    const codes = refusals.map((r) => r.payload['code']);
    expect(codes).toContain('OVER_BUDGET');
    expect(codes).toContain('OVER_CAP');
    expect(codes).toContain('IDEMPOTENCY_REUSE');
    expect(codes).toContain('INTENT_CONSUMED');
    expect(codes).toContain('UNREGISTERED_AGENT');
    expect(codes).toContain('PRICE_CHANGED');
    expect(codes).toContain('OUT_OF_STOCK');
    expect(codes).toContain('INVALID_MANDATE');
    // Newest first, by seq — the append-only log's ordering, never timestamps.
    const seqs = refusals.map((r) => r.seq);
    expect([...seqs].sort((a, b) => b - a)).toEqual(seqs);
    for (const refusal of refusals) {
      expect(typeof refusal.payload['reason']).toBe('string');
      expect(typeof refusal.summary).toBe('string');
    }

    // --- GET /audit/refusals/:seq: full purchase-attempt context -----------
    // Every payment.refused carries its chain hashes, so each timeline must
    // include exactly its own attempt's Intent and Cart mandates.
    const hashedCases = [
      { code: 'OVER_BUDGET', cartHash: overBudgetCart, intentHash: overBudgetIntent },
      { code: 'PRICE_CHANGED', cartHash: staleCart, intentHash: staleIntent },
      { code: 'OUT_OF_STOCK', cartHash: soldOutCart, intentHash: soldOutIntent },
    ];
    for (const { code, cartHash, intentHash } of hashedCases) {
      const seq = refusals.find((r) => r.payload['code'] === code)!.seq;
      const timeline = await getJson(`/audit/refusals/${seq}`);
      expect(timeline.status).toBe(200);
      expect(timeline.body.seq).toBe(seq);
      expect(timeline.body.refusal.type).toBe('payment.refused');
      expect(timeline.body.refusal.payload).toMatchObject({ code, cartHash, intentHash });

      const events = timeline.body.events as WireAuditEvent[];
      const types = events.map((e) => e.type);
      expect(types).toContain('mandate.intent_declared');
      expect(types).toContain('mandate.cart_created');
      expect(types).toContain('payment.refused');
      // Only THIS attempt's mandates — never another purchase's.
      for (const event of events) {
        if (event.type === 'mandate.intent_declared') {
          expect(event.payload['intentHash']).toBe(intentHash);
        }
        if (event.type === 'mandate.cart_created') {
          expect(event.payload['cartHash']).toBe(cartHash);
        }
      }
      expect(events.some((e) => e.seq === seq)).toBe(true);
      const eventSeqs = events.map((e) => e.seq);
      expect([...eventSeqs].sort((a, b) => a - b)).toEqual(eventSeqs);
    }

    // Hashless refusals (agent.refused, mandate.refused) are refused before
    // any mandate is stored: each is its own complete one-event story.
    const loneCases = [
      { code: 'UNREGISTERED_AGENT', type: 'agent.refused' },
      { code: 'INVALID_MANDATE', type: 'mandate.refused' },
    ];
    for (const { code, type } of loneCases) {
      const seq = refusals.find((r) => r.payload['code'] === code)!.seq;
      const lone = await getJson(`/audit/refusals/${seq}`);
      expect(lone.status).toBe(200);
      expect(lone.body.refusal.type).toBe(type);
      expect(lone.body.events).toHaveLength(1);
      expect(lone.body.events[0].seq).toBe(seq);
    }

    // Unknown seq, a non-refusal seq, and a non-numeric seq all 404 alike.
    expect((await getJson('/audit/refusals/999999')).body).toMatchObject({
      error: 'refusal_not_found',
    });
    expect((await getJson('/audit/refusals/999999')).status).toBe(404);
    const [orderCreated] = await deps.db
      .select({ seq: auditEvents.seq })
      .from(auditEvents)
      .where(eq(auditEvents.type, 'order.created'))
      .orderBy(asc(auditEvents.seq))
      .limit(1);
    expect((await getJson(`/audit/refusals/${orderCreated!.seq}`)).status).toBe(404);
    expect((await getJson('/audit/refusals/not-a-seq')).status).toBe(404);

    // --- GET /audit/:orderId still answers, complete -----------------------
    const orderAudit = await getJson(`/audit/${orderId}`);
    expect(orderAudit.status).toBe(200);
    expect(orderAudit.body.complete).toBe(true);
    expect(orderAudit.body.missingSteps).toEqual([]);
  });

  it('serves the SPA under /viewer with a history fallback, and degrades to a JSON 404 without a build', async () => {
    // No build present: /viewer 404s with the hint, the rest of the app works.
    const absent = await getJson('/viewer');
    expect(absent.status).toBe(404);
    expect(absent.body).toEqual({ error: 'viewer_not_built' });
    expect((await getJson('/viewer/orders/whatever')).body).toEqual({
      error: 'viewer_not_built',
    });
    expect((await getJson('/healthz')).status).toBe(200);

    // A build appears (checked per request, so no restart is needed).
    mkdirSync(path.join(viewerDistDir, 'assets'), { recursive: true });
    const marker = '<!doctype html><title>t7-viewer-stub</title>';
    writeFileSync(path.join(viewerDistDir, 'index.html'), marker);
    writeFileSync(path.join(viewerDistDir, 'assets', 'app.js'), 'console.log("stub")');

    const index = await fetch(`${baseUrl}/viewer`);
    expect(index.status).toBe(200);
    expect(await index.text()).toBe(marker);

    // History fallback: client-side routes serve the same index.
    for (const route of ['/viewer/orders/ord_missing_anything', '/viewer/refusals/42']) {
      const response = await fetch(`${baseUrl}${route}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(marker);
    }

    // Real files are still real files, not the fallback.
    const asset = await fetch(`${baseUrl}/viewer/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe('console.log("stub")');
  });
});

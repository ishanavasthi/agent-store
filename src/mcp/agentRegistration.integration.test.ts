import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agents, auditEvents, merchants, orders, products, variants } from '../db/schema.js';
import type { StorefrontDeps } from '../deps.js';
import { signMessage, verifyMessage } from '../domain/keys.js';
import { StubGateway } from '../gateway/stubGateway.js';
import { createTestDatabase, type TestDatabaseHandle } from '../testSupport/pgliteDatabase.js';
import { createMcpServer } from './server.js';

/**
 * T3's acceptance proof (issue #4), driven through the same door a real buyer
 * uses — the MCP tools, over an in-memory client/server pair:
 *
 *   1. `register_agent` returns a token; the Agent row carries keypair + Cap.
 *   2. Re-registration mints a NEW Agent with a fresh Cap (ADR-0001).
 *   3. Tool calls without a valid token refuse with `{code, reason,
 *      recoverable}` AND write an audit entry.
 *   4. A Cap is rejected to integer paise — no float reaches storage.
 *
 * Assertions read the wire payloads and the audit/agents tables back — never
 * the server's internals.
 */

const MERCHANT_ID = 'mrc_test_merchant';

async function seedCatalog(db: StorefrontDeps['db'], stock: number): Promise<void> {
  await db.insert(merchants).values({ id: MERCHANT_ID, name: 'Test Merchant' });
  await db.insert(products).values({
    id: 'prd_test_tee',
    merchantId: MERCHANT_ID,
    title: 'Oversized Tee',
    status: 'published',
  });
  await db.insert(variants).values({
    id: 'var_test_tee_default',
    productId: 'prd_test_tee',
    label: null,
    isDefault: true,
    pricePaise: 129900,
    currency: 'INR',
    stock,
  });
}

/** One tool call as a buyer would make it, with the JSON body parsed back out. */
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; body: Record<string, unknown> }> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return {
    isError: result.isError === true,
    body: JSON.parse(content[0]!.text) as Record<string, unknown>,
  };
}

async function auditChain(db: StorefrontDeps['db']) {
  return db
    .select({
      type: auditEvents.type,
      orderId: auditEvents.orderId,
      payload: auditEvents.payload,
    })
    .from(auditEvents)
    .orderBy(asc(auditEvents.seq));
}

describe('agent registration and the token gate, through the MCP tools', () => {
  let handle: TestDatabaseHandle;
  let deps: StorefrontDeps;
  let client: Client;

  beforeEach(async () => {
    handle = await createTestDatabase();
    deps = {
      db: handle.db,
      gateway: new StubGateway(),
      merchantId: MERCHANT_ID,
      publicBaseUrl: 'https://merchant.example',
    };
    await seedCatalog(deps.db, 3);
    const server = createMcpServer(deps);
    client = new Client({ name: 'test-buyer', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await handle.close();
  });

  it('register_agent returns a token, and the Agent row carries keypair + Cap', async () => {
    const { isError, body } = await call(client, 'register_agent', { capPaise: 500000 });
    expect(isError).toBe(false);
    expect(body['agentId']).toMatch(/^agt_[0-9a-f]{32}$/);
    expect(body['agentToken']).toMatch(/^agt_tok_/);
    expect(body['cap']).toEqual({
      amountPaise: 500000,
      amountDisplay: '₹5,000.00',
      currency: 'INR',
    });

    const [row] = await deps.db
      .select()
      .from(agents)
      .where(eq(agents.id, body['agentId'] as string));
    expect(row).toBeDefined();
    expect(row!.merchantId).toBe(MERCHANT_ID);
    expect(row!.token).toBe(body['agentToken']);
    expect(row!.capPaise).toBe(500000);
    // The custodial keypair is real: the stored private key signs, the public
    // key the buyer was shown verifies.
    expect(row!.publicKey).toBe(body['publicKey']);
    const signature = signMessage(row!.privateKey, 'proof');
    expect(verifyMessage(row!.publicKey, 'proof', signature)).toBe(true);

    // Registration is audited (ADR-0003, same transaction as the row) — and
    // the audit payload holds no secrets, because /audit is public.
    const chain = await auditChain(deps.db);
    expect(chain.map((e) => e.type)).toEqual(['agent.registered']);
    expect(chain[0]!.orderId).toBeNull();
    const payload = chain[0]!.payload as Record<string, unknown>;
    expect(payload['agentId']).toBe(body['agentId']);
    expect(payload['capPaise']).toBe(500000);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(body['agentToken'] as string);
    expect(serialized).not.toContain(row!.privateKey);
  });

  it('re-registration mints a NEW Agent with a fresh Cap; the old one is untouched', async () => {
    const first = await call(client, 'register_agent', { capPaise: 500000 });
    const second = await call(client, 'register_agent', { capPaise: 250000 });

    // ADR-0001: no stable buyer identity — a new registration is a new Agent.
    expect(second.body['agentId']).not.toBe(first.body['agentId']);
    expect(second.body['agentToken']).not.toBe(first.body['agentToken']);

    const rows = await deps.db.select().from(agents).orderBy(asc(agents.createdAt));
    expect(rows).toHaveLength(2);
    const firstRow = rows.find((r) => r.id === first.body['agentId']);
    const secondRow = rows.find((r) => r.id === second.body['agentId']);
    // Caps are immutable per registration: the new declaration did not touch
    // the old row, and each token still resolves to its own Agent.
    expect(firstRow!.capPaise).toBe(500000);
    expect(secondRow!.capPaise).toBe(250000);
    expect(firstRow!.publicKey).not.toBe(secondRow!.publicKey);
  });

  it('checkout without a token refuses with {code, reason, recoverable} and writes an audit entry', async () => {
    const { isError, body } = await call(client, 'checkout', { quantity: 1 });

    expect(isError).toBe(true);
    const refusal = body['refusal'] as Record<string, unknown>;
    expect(refusal).toMatchObject({
      code: 'UNREGISTERED_AGENT',
      recoverable: true,
    });
    expect(typeof refusal['reason']).toBe('string');
    // A Refusal, not a validation error — the categories must stay distinct on
    // the wire (CONTEXT.md → Failure vocabulary).
    expect('validationError' in body).toBe(false);

    // The refusal is on the audit log, unattributable to any Order (none was
    // created), and the gateway was never approached: no order.created, no
    // gateway.payment_link_attempted.
    const chain = await auditChain(deps.db);
    expect(chain.map((e) => e.type)).toEqual(['agent.refused']);
    expect(chain[0]!.orderId).toBeNull();
    expect(chain[0]!.payload).toMatchObject({
      code: 'UNREGISTERED_AGENT',
      recoverable: true,
      tool: 'checkout',
      tokenPresented: false,
    });
    expect(await deps.db.select().from(orders)).toHaveLength(0);
  });

  it('a forged token refuses identically — but without echoing the token into the log', async () => {
    const forged = 'agt_tok_forged-but-secret-shaped';
    const { isError, body } = await call(client, 'checkout', {
      agentToken: forged,
      quantity: 1,
    });
    expect(isError).toBe(true);
    expect((body['refusal'] as Record<string, unknown>)['code']).toBe('UNREGISTERED_AGENT');

    const chain = await auditChain(deps.db);
    expect(chain[0]!.payload).toMatchObject({ tool: 'checkout', tokenPresented: true });
    // An almost-valid token is still a secret-shaped string; the log records
    // that one was presented, never which one.
    expect(JSON.stringify(chain[0]!.payload)).not.toContain(forged);
  });

  it('get_order_status is gated by the same refusal', async () => {
    const { isError, body } = await call(client, 'get_order_status', { orderId: 'ord_whatever' });
    expect(isError).toBe(true);
    expect((body['refusal'] as Record<string, unknown>)['code']).toBe('UNREGISTERED_AGENT');

    const chain = await auditChain(deps.db);
    expect(chain.map((e) => e.type)).toEqual(['agent.refused']);
    expect(chain[0]!.payload).toMatchObject({ tool: 'get_order_status' });
  });

  it('a registered Agent passes the gate: checkout and get_order_status work with its token', async () => {
    const registration = await call(client, 'register_agent', { capPaise: 500000 });
    const agentToken = registration.body['agentToken'] as string;

    const checkoutResult = await call(client, 'checkout', { agentToken, quantity: 1 });
    expect(checkoutResult.isError).toBe(false);
    expect(checkoutResult.body['status']).toBe('awaiting_payment');
    expect(checkoutResult.body['paymentLinkUrl']).toBe('https://stub.invalid/pay/plink_stub_1');

    const status = await call(client, 'get_order_status', {
      agentToken,
      orderId: checkoutResult.body['orderId'] as string,
    });
    expect(status.isError).toBe(false);
    expect(status.body['status']).toBe('awaiting_payment');

    // The chain shows registration, then the ordinary T1 purchase events — and
    // no agent.refused anywhere.
    const chain = await auditChain(deps.db);
    expect(chain.map((e) => e.type)).toEqual([
      'agent.registered',
      'order.created',
      'gateway.payment_link_attempted',
      'gateway.payment_link_issued',
    ]);
  });

  it('a non-integer Cap is rejected as INVALID_CAP; no float ever reaches storage', async () => {
    for (const capPaise of [4999.5, -100, 0]) {
      const { isError, body } = await call(client, 'register_agent', { capPaise });
      expect(isError).toBe(true);
      const validationError = body['validationError'] as Record<string, unknown>;
      expect(validationError['code']).toBe('INVALID_CAP');
      // Validation-error shape, not Refusal shape: no `recoverable` key.
      expect('recoverable' in validationError).toBe(false);
      expect('refusal' in body).toBe(false);
    }
    // Nothing was minted for any of them.
    expect(await deps.db.select().from(agents)).toHaveLength(0);
    expect((await auditChain(deps.db)).map((e) => e.type)).toEqual([]);
  });

  it('get_product stays open — browsing needs no registration', async () => {
    // The shop window is public; registration gates transacting, not looking
    // (DECISIONS.md, T3 ruling).
    const { isError, body } = await call(client, 'get_product', {});
    expect(isError).toBe(false);
    expect(body['variants']).toHaveLength(1);
  });
});

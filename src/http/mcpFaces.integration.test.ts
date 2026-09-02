import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { merchants } from '../db/schema.js';
import type { StorefrontDeps } from '../deps.js';
import { StubGateway } from '../gateway/stubGateway.js';
import { createTestDatabase, type TestDatabaseHandle } from '../testSupport/pgliteDatabase.js';
import { createApp } from './app.js';

/**
 * S1.2 (issue #39): the two MCP faces as a real client meets them — over HTTP,
 * through Streamable HTTP, against the app's actual route table.
 *
 * What only this level can prove: that `/merchant/mcp` is registered BEFORE the
 * `/merchant` confirmation router (otherwise that router answers first and the
 * merchant connector never handshakes), and that the tool sets are disjoint —
 * a buyer must not so much as see a tool that edits the catalog.
 */

const MERCHANT_ID = 'mrc_test_merchant';

const BUYER_TOOLS = [
  'create_cart',
  'declare_intent',
  'get_order_status',
  'get_product',
  'register_agent',
  'submit_payment',
];
const MERCHANT_TOOLS = [
  'confirm_product',
  'get_held_product',
  'get_order',
  'list_held_products',
  'list_my_products',
  'list_recent_orders',
  'store_summary',
  'submit_catalog_item',
];

describe('S1.2 the two MCP faces over real HTTP', () => {
  let handle: TestDatabaseHandle;
  let server: Server;
  let baseUrl: string;

  async function toolNames(path: string): Promise<string[]> {
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}${path}`)));
    try {
      const { tools } = await client.listTools();
      return tools.map((tool) => tool.name).sort();
    } finally {
      await client.close();
    }
  }

  beforeEach(async () => {
    handle = await createTestDatabase();
    await handle.db.insert(merchants).values({ id: MERCHANT_ID, name: 'Kalaakar Streetwear' });
    const deps: StorefrontDeps = {
      db: handle.db,
      gateway: new StubGateway(),
      merchantId: MERCHANT_ID,
      publicBaseUrl: 'https://merchant.example',
    };
    server = createServer(createApp(deps));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.close();
    await handle.close();
  });

  it('exposes disjoint tool sets on the buyer and merchant faces', async () => {
    expect(await toolNames('/mcp')).toEqual(BUYER_TOOLS);
    expect(await toolNames('/merchant/mcp')).toEqual(MERCHANT_TOOLS);
  });

  it('answers 405 to GET /merchant/mcp — stateless mode has no session to stream', async () => {
    const response = await fetch(`${baseUrl}/merchant/mcp`, { method: 'GET' });
    expect(response.status).toBe(405);
    expect(await response.json()).toMatchObject({
      error: { code: -32000, message: expect.stringContaining('stateless') },
    });
  });

  it('lists /merchant/mcp on the root document, beside the buyer face', async () => {
    const body = (await (await fetch(`${baseUrl}/`)).json()) as Record<string, any>;
    expect(body.merchantMcp).toBe('https://merchant.example/merchant/mcp');
    expect(body.endpoints).toContain('/merchant/mcp');
  });

  it('keeps the /merchant confirmation router reachable behind the MCP route', async () => {
    // Route order proof from the other side: mounting `/merchant/mcp` first
    // must not shadow the `/merchant` router's own paths.
    const response = await fetch(`${baseUrl}/merchant/confirmations`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ products: [] });
  });
});

import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { merchants } from '../db/schema.js';
import type { StorefrontDeps } from '../deps.js';
import { StubGateway } from '../gateway/stubGateway.js';
import { createTestDatabase, type TestDatabaseHandle } from '../testSupport/pgliteDatabase.js';
import { createApp } from './app.js';

/**
 * S1.4 (issue #43): the deployment serves the demo photos itself.
 *
 * The GitHub repository is private, so `fixtures/demo-dataset/images/*.jpg`
 * has no public raw URL — and Take B of the video hands the merchant face an
 * `imageUrl` a claude.ai connector must be able to fetch. This mount is the
 * only thing that can produce such a URL, which is why it is tested at the
 * app's real route table rather than assumed.
 */

const MERCHANT_ID = 'mrc_test_merchant';
const A_DEMO_PHOTO = '01-raat-oversized-tee.jpg';

describe('S1.4 /demo/images', () => {
  let handle: TestDatabaseHandle;
  let server: Server;
  let baseUrl: string;

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

  it('serves a demo photo as a cacheable JPEG', async () => {
    const response = await fetch(`${baseUrl}/demo/images/${A_DEMO_PHOTO}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('image/jpeg');
    expect(response.headers.get('cache-control')).toContain('max-age=3600');
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  });

  it('answers 404 — not the viewer SPA and not a 500 — for a photo that does not exist', async () => {
    // `fallthrough: false` hands a miss to the error handler rather than to the
    // next route; the handler must keep serve-static's 404 instead of turning
    // every missing photo into `internal_error`.
    const response = await fetch(`${baseUrl}/demo/images/no-such-drop.jpg`);

    expect(response.status).toBe(404);
  });

  it('lists /demo/images on the root document', async () => {
    const body = (await (await fetch(`${baseUrl}/`)).json()) as { endpoints: string[] };

    expect(body.endpoints).toContain('/demo/images');
  });
});

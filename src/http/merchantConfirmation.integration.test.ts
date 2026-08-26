import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { merchants, products, variants } from '../db/schema.js';
import type { StorefrontDeps } from '../deps.js';
import { listPublishedVariants } from '../domain/catalog.js';
import { ensureMerchantSigningKey } from '../domain/merchants.js';
import { paise } from '../domain/money.js';
import { applyGatewayWebhook, type WebhookOutcome } from '../domain/orders.js';
import { StubGateway, type SyntheticWebhook } from '../gateway/stubGateway.js';
import {
  ingestItems,
  productIdForSource,
  variantIdForSource,
  type IngestItem,
} from '../ingestion/ingest.js';
import type {
  ExtractionInput,
  ExtractionModel,
  ExtractionResult,
  ProductExtraction,
} from '../ingestion/types.js';
import { createMcpServer } from '../mcp/server.js';
import { call } from '../testSupport/mcpTestClient.js';
import { createTestDatabase, type TestDatabaseHandle } from '../testSupport/pgliteDatabase.js';
import { createApp } from './app.js';

/**
 * T13 (issue #14): the merchant confirmation API, driven end to end the way
 * the demo runs — raw photo+caption in through T12's ingestion (canned
 * extractor, zero network), held Products reviewed and published over real
 * HTTP, and the published result bought by a buyer Agent through the MCP seam
 * against the stub gateway. The publish gate on trial is the SERVER's: every
 * rejection case below is a raw HTTP request no UI could pre-filter.
 */

const MERCHANT_ID = 'mrc_test_merchant';

// The four demo-shaped source items. Each recreates a real T12/S3 situation:
// TEE   — everything confident but no stated stock (the common case).
// CARGO — per-variant labels with only a stated TOTAL (merchant must split).
// HAT   — under-confident name plus phantom variant labels (the S3 miss).
// AUTO  — fully confident with stated stock (auto-publishes, never listed).
const TEE = '01-raat-tee';
const CARGO = '04-galli-cargo';
const HAT = '19-beige-bucket-hat';
const AUTO = '23-machli-tee';

function confident(overrides: Partial<ProductExtraction> = {}): ProductExtraction {
  return {
    name: { value: 'RAAT Oversized Tee', confidence: 0.97 },
    description: { value: 'Jet black oversized tee.', confidence: 0.95 },
    price: { value: paise(119900), confidence: 0.97 },
    priceText: { value: '₹1,199/-', confidence: 0.97 },
    stock: { value: null, confidence: 0 },
    variantLabels: { value: [], confidence: 0.95 },
    variantStock: { value: {}, confidence: 0.95 },
    ...overrides,
  };
}

const EXTRACTIONS: Record<string, ProductExtraction> = {
  [TEE]: confident(),
  [CARGO]: confident({
    name: { value: 'Galli Cargo Pants', confidence: 0.95 },
    price: { value: paise(189900), confidence: 0.96 },
    priceText: { value: '₹1,899/-', confidence: 0.96 },
    stock: { value: 30, confidence: 0.92 },
    variantLabels: { value: ['S', 'M', 'L'], confidence: 0.95 },
  }),
  [HAT]: confident({
    name: { value: 'Beige Bucket Hat', confidence: 0.7 },
    price: { value: paise(64900), confidence: 0.95 },
    priceText: { value: '₹649/-', confidence: 0.95 },
    variantLabels: { value: ['one size fits all', 'beige'], confidence: 0.95 },
  }),
  [AUTO]: confident({
    name: { value: 'Machli Graphic Tee', confidence: 0.96 },
    stock: { value: 18, confidence: 0.95 },
  }),
};

const cannedModel: ExtractionModel = {
  modelId: 'canned-extractor',
  extract: (input: ExtractionInput): Promise<ExtractionResult> => {
    const extraction = EXTRACTIONS[input.caption];
    if (extraction === undefined) throw new Error(`No canned extraction for: ${input.caption}`);
    return Promise.resolve({ extraction, modelId: 'canned-extractor-2026-08-26', rawResponse: '{}' });
  },
};

function item(sourceId: string, imagePath: string | null): IngestItem {
  // The caption doubles as the canned-model key; a real fixture photo path on
  // the tee exercises the photo endpoint against a file that actually exists.
  return { sourceId, caption: sourceId, imagePath, image: null };
}

const TEE_PRODUCT = productIdForSource(TEE);
const TEE_VARIANT = variantIdForSource(TEE, null);

describe('T13 merchant confirmation', () => {
  let handle: TestDatabaseHandle;
  let gateway: StubGateway;
  let deps: StorefrontDeps;
  let client: Client;
  let agentToken: string;
  let server: Server;
  let baseUrl: string;

  async function deliver(hook: SyntheticWebhook): Promise<WebhookOutcome> {
    expect(deps.gateway.verifyWebhookSignature(hook.rawBody, hook.signature)).toBe(true);
    const event = deps.gateway.parseWebhookEvent(hook.rawBody);
    return applyGatewayWebhook(deps.db, deps.merchantId, event, deps.gateway.name);
  }

  async function getJson(pathname: string): Promise<{ status: number; body: any }> {
    const response = await fetch(`${baseUrl}${pathname}`);
    return { status: response.status, body: await response.json() };
  }

  async function postJson(pathname: string, body: unknown): Promise<{ status: number; body: any }> {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  /** A complete, valid confirmation of the held tee — the tests below vary it. */
  function teeSubmission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      title: 'RAAT Oversized Tee — Jet Black',
      description: 'Jet black oversized tee. 240 GSM.',
      variants: [{ variantId: TEE_VARIANT, label: null, pricePaise: 119900, stock: 12 }],
      ...overrides,
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
    await handle.db.insert(merchants).values({ id: MERCHANT_ID, name: 'Kalaakar Streetwear' });
    await ensureMerchantSigningKey(handle.db, MERCHANT_ID);

    // The demo's front half: raw photo+caption through T12's pipeline.
    await ingestItems(handle.db, MERCHANT_ID, cannedModel, [
      item(TEE, 'fixtures/demo-dataset/images/01-raat-oversized-tee.jpg'),
      item(CARGO, null),
      item(HAT, null),
      item(AUTO, null),
    ]);

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
  });

  it('lists exactly the held Products, with the extraction detail the screen prefills from', async () => {
    const { status, body } = await getJson('/merchant/confirmations');
    expect(status).toBe(200);
    expect(body.merchant).toBe('Kalaakar Streetwear');

    const ids = body.products.map((p: any) => p.productId);
    expect(ids).toContain(TEE_PRODUCT);
    expect(ids).toContain(productIdForSource(CARGO));
    expect(ids).toContain(productIdForSource(HAT));
    // The auto-published Product never appears on the worklist.
    expect(ids).not.toContain(productIdForSource(AUTO));

    const tee = body.products.find((p: any) => p.productId === TEE_PRODUCT);
    expect(tee.status).toBe('needs_confirmation');
    expect(tee.extraction.caption).toBe(TEE);
    expect(tee.extraction.fields.name).toEqual({
      value: 'RAAT Oversized Tee',
      confidence: 0.97,
      belowThreshold: false,
    });
    expect(tee.extraction.holds).toEqual([
      { field: 'stock', reason: 'the caption never states a stock count' },
    ]);
    // The prefill is honest: stock is null, never a defaulted number.
    expect(tee.variants).toEqual([
      {
        variantId: TEE_VARIANT,
        label: null,
        isDefault: true,
        pricePaise: 119900,
        stock: null,
      },
    ]);

    // The unsplit-total case carries the stated total for the screen to split.
    const cargo = body.products.find((p: any) => p.productId === productIdForSource(CARGO));
    expect(cargo.extraction.fields.stock.value).toBe(30);
    expect(cargo.variants.map((v: any) => ({ label: v.label, stock: v.stock }))).toEqual([
      { label: 'L', stock: null },
      { label: 'M', stock: null },
      { label: 'S', stock: null },
    ]);
  });

  it('raw photo+caption → ingestion → confirmation → a buyer Agent purchases the item', async () => {
    // Held means invisible in whole: the buyer cannot see or cart the tee.
    const before = await call(client, 'get_product', {});
    const beforeIds = (before.body['variants'] as Array<{ variantId: string }>).map(
      (v) => v.variantId,
    );
    expect(beforeIds).not.toContain(TEE_VARIANT);

    const intentBefore = await call(client, 'declare_intent', {
      agentToken,
      want: 'the raat tee',
      budgetPaise: 200000,
    });
    const cartBefore = await call(client, 'create_cart', {
      agentToken,
      intentHash: intentBefore.body['intentHash'],
      items: [{ variantId: TEE_VARIANT, quantity: 1 }],
    });
    expect(cartBefore.isError).toBe(true);
    expect((cartBefore.body['validationError'] as any).code).toBe('VARIANT_NOT_FOUND');

    // The merchant confirms: corrected title, and the stock only they know.
    const confirmed = await postJson(`/merchant/confirmations/${TEE_PRODUCT}`, teeSubmission());
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe('published');
    expect(confirmed.body.product.variants).toEqual([
      {
        variantId: TEE_VARIANT,
        label: null,
        isDefault: true,
        pricePaise: 119900,
        stock: 12,
      },
    ]);

    // Off the worklist, and the merchant's answer is stamped on the record.
    const list = await getJson('/merchant/confirmations');
    expect(list.body.products.map((p: any) => p.productId)).not.toContain(TEE_PRODUCT);
    const [row] = await handle.db.select().from(products).where(eq(products.id, TEE_PRODUCT));
    expect(row?.status).toBe('published');
    expect(row?.extraction?.confirmation?.submitted.title).toBe('RAAT Oversized Tee — Jet Black');
    expect(row?.title).toBe('RAAT Oversized Tee — Jet Black');

    // Immediately buyable: the full mandate-chain purchase, end to end.
    const catalog = await call(client, 'get_product', {});
    const listed = (catalog.body['variants'] as Array<Record<string, unknown>>).find(
      (v) => v['variantId'] === TEE_VARIANT,
    );
    expect(listed).toMatchObject({ productTitle: 'RAAT Oversized Tee — Jet Black', stock: 12 });

    const intent = await call(client, 'declare_intent', {
      agentToken,
      want: 'the raat tee',
      budgetPaise: 200000,
    });
    expect(intent.isError).toBe(false);
    const cart = await call(client, 'create_cart', {
      agentToken,
      intentHash: intent.body['intentHash'],
      items: [{ variantId: TEE_VARIANT, quantity: 1 }],
    });
    expect(cart.isError).toBe(false);
    const payment = await call(client, 'submit_payment', {
      agentToken,
      cartHash: cart.body['cartHash'],
      idempotencyKey: randomUUID(),
    });
    expect(payment.isError).toBe(false);
    const orderId = payment.body['orderId'] as string;

    const hooks = gateway.completePayment(payment.body['gatewayPaymentLinkId'] as string);
    expect(await deliver(hooks[0]!)).toEqual({ result: 'order_paid', orderId });

    const status = await call(client, 'get_order_status', { agentToken, orderId });
    expect(status.body['status']).toBe('paid');
    expect(status.body['receipt']).toBeDefined();

    // Fulfilment decremented the very stock the merchant just stated.
    const [variantRow] = await handle.db
      .select()
      .from(variants)
      .where(eq(variants.id, TEE_VARIANT));
    expect(variantRow?.stock).toBe(11);

    const audit = await getJson(`/audit/${orderId}`);
    expect(audit.status).toBe(200);
    expect(audit.body.complete).toBe(true);
  });

  it('publishes a stated total only as the merchant splits it — per-variant counts land per variant', async () => {
    const cargoId = productIdForSource(CARGO);
    const confirmed = await postJson(`/merchant/confirmations/${cargoId}`, {
      title: 'Galli Cargo Pants',
      description: 'Utility cargos.',
      variants: [
        { variantId: variantIdForSource(CARGO, 'S'), label: 'S', pricePaise: 189900, stock: 10 },
        { variantId: variantIdForSource(CARGO, 'M'), label: 'M', pricePaise: 189900, stock: 12 },
        { variantId: variantIdForSource(CARGO, 'L'), label: 'L', pricePaise: 189900, stock: 8 },
      ],
    });
    expect(confirmed.status).toBe(200);

    const published = await listPublishedVariants(handle.db, MERCHANT_ID);
    const cargoVariants = published.filter((v) => v.productId === cargoId);
    expect(cargoVariants.map((v) => ({ label: v.label, stock: v.stock }))).toEqual([
      { label: 'L', stock: 8 },
      { label: 'M', stock: 12 },
      { label: 'S', stock: 10 },
    ]);
  });

  it('lets the merchant correct phantom variant labels down to the single default Variant', async () => {
    // The S3 miss: "one size fits all, beige" became two variants where the
    // right answer is none. The merchant's submission IS the final variant
    // set, so omitting both rows and stating one default corrects the fiction.
    const hatId = productIdForSource(HAT);
    const confirmed = await postJson(`/merchant/confirmations/${hatId}`, {
      title: 'Beige Bucket Hat',
      description: null,
      variants: [{ label: null, pricePaise: 64900, stock: 6 }],
    });
    expect(confirmed.status).toBe(200);

    const rows = await handle.db.select().from(variants).where(eq(variants.productId, hatId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: null, isDefault: true, pricePaise: 64900, stock: 6 });
  });

  it('refuses — server-side — every submission that would publish something unconfirmed', async () => {
    // Missing stock entirely: rejected at the body schema, before the domain.
    const missingStock = await postJson(
      `/merchant/confirmations/${TEE_PRODUCT}`,
      teeSubmission({ variants: [{ variantId: TEE_VARIANT, label: null, pricePaise: 119900 }] }),
    );
    expect(missingStock.status).toBe(400);
    expect(missingStock.body.error).toBe('invalid_request');

    const cases: Array<Record<string, unknown>> = [
      // Negative and fractional stock: not a stated count.
      { variants: [{ variantId: TEE_VARIANT, label: null, pricePaise: 119900, stock: -1 }] },
      { variants: [{ variantId: TEE_VARIANT, label: null, pricePaise: 119900, stock: 2.5 }] },
      // A price of zero or fractional paise: not a number checkout can trust.
      { variants: [{ variantId: TEE_VARIANT, label: null, pricePaise: 0, stock: 5 }] },
      { variants: [{ variantId: TEE_VARIANT, label: null, pricePaise: 1299.5, stock: 5 }] },
      // A blank title.
      { title: '   ' },
      // A variantId belonging to some other Product.
      {
        variants: [
          { variantId: variantIdForSource(HAT, 'beige'), label: null, pricePaise: 119900, stock: 5 },
        ],
      },
      // A null label among several variants.
      {
        variants: [
          { label: null, pricePaise: 119900, stock: 5 },
          { label: 'M', pricePaise: 119900, stock: 5 },
        ],
      },
      // Duplicate labels under the pipeline's own normalisation.
      {
        variants: [
          { label: 'UK 10', pricePaise: 119900, stock: 5 },
          { label: 'uk10', pricePaise: 119900, stock: 5 },
        ],
      },
    ];
    for (const overrides of cases) {
      const response = await postJson(
        `/merchant/confirmations/${TEE_PRODUCT}`,
        teeSubmission(overrides),
      );
      expect(response.status).toBe(400);
      expect(response.body.validationError.code).toBe('INVALID_CONFIRMATION');
    }

    // Nothing above published anything or half-applied a correction.
    const list = await getJson('/merchant/confirmations');
    const tee = list.body.products.find((p: any) => p.productId === TEE_PRODUCT);
    expect(tee.status).toBe('needs_confirmation');
    expect(tee.variants).toEqual([
      { variantId: TEE_VARIANT, label: null, isDefault: true, pricePaise: 119900, stock: null },
    ]);
    const buyable = await listPublishedVariants(handle.db, MERCHANT_ID);
    expect(buyable.map((v) => v.variantId)).not.toContain(TEE_VARIANT);
  });

  it('404s an unknown Product and 409s one that is not awaiting confirmation', async () => {
    const unknown = await postJson('/merchant/confirmations/prd_demo_nope', teeSubmission());
    expect(unknown.status).toBe(404);
    expect(unknown.body.validationError.code).toBe('PRODUCT_NOT_FOUND');

    // The auto-published Product has nothing to confirm.
    const auto = await postJson(`/merchant/confirmations/${productIdForSource(AUTO)}`, {
      title: 'Machli Graphic Tee',
      description: null,
      variants: [{ label: null, pricePaise: 119900, stock: 18 }],
    });
    expect(auto.status).toBe(409);
    expect(auto.body.validationError.code).toBe('PRODUCT_NOT_CONFIRMABLE');

    // Confirming twice: the second answer meets the same wall.
    expect((await postJson(`/merchant/confirmations/${TEE_PRODUCT}`, teeSubmission())).status).toBe(
      200,
    );
    const again = await postJson(`/merchant/confirmations/${TEE_PRODUCT}`, teeSubmission());
    expect(again.status).toBe(409);
    expect(again.body.validationError.code).toBe('PRODUCT_NOT_CONFIRMABLE');
  });

  it('serves one Product in any status, and its source photo where one exists', async () => {
    const detail = await getJson(`/merchant/confirmations/${TEE_PRODUCT}`);
    expect(detail.status).toBe(200);
    expect(detail.body.product.extraction.fields.price.value).toBe(119900);

    expect((await getJson('/merchant/confirmations/prd_demo_nope')).status).toBe(404);

    // The tee's imagePath names a committed fixture; the response is the image.
    const photo = await fetch(`${baseUrl}/merchant/confirmations/${TEE_PRODUCT}/photo`);
    expect(photo.status).toBe(200);
    expect(photo.headers.get('content-type')).toContain('image/jpeg');

    // Caption-only Products have no photo to serve.
    const none = await getJson(`/merchant/confirmations/${productIdForSource(HAT)}/photo`);
    expect(none.status).toBe(404);

    // A hostile imagePath cannot escape the repo root (express contains it).
    const [row] = await handle.db.select().from(products).where(eq(products.id, TEE_PRODUCT));
    await handle.db
      .update(products)
      .set({ extraction: { ...row!.extraction!, imagePath: '../../../etc/passwd' } })
      .where(eq(products.id, TEE_PRODUCT));
    const escape = await fetch(`${baseUrl}/merchant/confirmations/${TEE_PRODUCT}/photo`);
    expect(escape.status).not.toBe(200);
  });
});

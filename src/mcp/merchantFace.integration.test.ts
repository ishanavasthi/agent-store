import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { merchants, variants } from '../db/schema.js';
import type { StorefrontDeps } from '../deps.js';
import { ensureMerchantToken } from '../domain/merchants.js';
import { paise } from '../domain/money.js';
import { StubGateway } from '../gateway/stubGateway.js';
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
import { auditChain, call } from '../testSupport/mcpTestClient.js';
import { createTestDatabase, type TestDatabaseHandle } from '../testSupport/pgliteDatabase.js';
import { createMerchantMcpServer } from './merchantServer.js';
import { createMcpServer } from './server.js';

/**
 * S1.2 (issue #39): the merchant face, driven through the same door a real
 * merchant's chat client uses — the MCP tools over an in-memory client/server
 * pair, against an embedded Postgres holding Products that came out of the T12
 * ingestion pipeline with genuinely unknown fields.
 *
 * The proofs on trial:
 *   1. The `merchantToken` gate on EVERY tool, writing no audit event (D1).
 *   2. The held queue is honest — null stock stays null, holds are named.
 *   3. `confirm_product` is ADDITIVE (D2): stock-only publishes, an omitted
 *      Variant survives, and the buyer face sees the result immediately.
 */

const MERCHANT_ID = 'mrc_test_merchant';

// TEE   — everything confident, no stated stock: the common hold.
// CARGO — labelled Variants with only a stated total: several rows to omit.
// AUTO  — fully confident with stated stock: auto-publishes, never held.
const TEE = '01-raat-tee';
const CARGO = '04-galli-cargo';
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
    return Promise.resolve({ extraction, modelId: 'canned-extractor-2026-09-03', rawResponse: '{}' });
  },
};

function item(sourceId: string): IngestItem {
  return { sourceId, caption: sourceId, imagePath: null, image: null };
}

const TEE_PRODUCT = productIdForSource(TEE);
const TEE_VARIANT = variantIdForSource(TEE, null);
const CARGO_PRODUCT = productIdForSource(CARGO);
const CARGO_S = variantIdForSource(CARGO, 'S');
const CARGO_M = variantIdForSource(CARGO, 'M');
const CARGO_L = variantIdForSource(CARGO, 'L');

/** Every tool on this face, with the arguments each needs beyond the token. */
const EVERY_TOOL: ReadonlyArray<[string, Record<string, unknown>]> = [
  ['list_held_products', {}],
  ['get_held_product', { productId: TEE_PRODUCT }],
  ['confirm_product', { productId: TEE_PRODUCT, variants: [{ variantId: TEE_VARIANT, stock: 12 }] }],
  ['list_my_products', {}],
];

describe('S1.2 the merchant MCP face', () => {
  let handle: TestDatabaseHandle;
  let deps: StorefrontDeps;
  let merchant: Client;
  let buyer: Client;
  let merchantToken: string;

  beforeEach(async () => {
    handle = await createTestDatabase();
    deps = {
      db: handle.db,
      gateway: new StubGateway(),
      merchantId: MERCHANT_ID,
      publicBaseUrl: 'https://merchant.example',
    };
    await handle.db.insert(merchants).values({ id: MERCHANT_ID, name: 'Kalaakar Streetwear' });
    merchantToken = (await ensureMerchantToken(handle.db, MERCHANT_ID)).token;

    await ingestItems(handle.db, MERCHANT_ID, cannedModel, [item(TEE), item(CARGO), item(AUTO)]);

    merchant = new Client({ name: 'test-merchant', version: '0.0.0' });
    const merchantPair = InMemoryTransport.createLinkedPair();
    await Promise.all([
      createMerchantMcpServer(deps).connect(merchantPair[1]),
      merchant.connect(merchantPair[0]),
    ]);

    buyer = new Client({ name: 'test-buyer', version: '0.0.0' });
    const buyerPair = InMemoryTransport.createLinkedPair();
    await Promise.all([createMcpServer(deps).connect(buyerPair[1]), buyer.connect(buyerPair[0])]);
  });

  afterEach(async () => {
    await merchant.close();
    await buyer.close();
    await handle.close();
  });

  // --- The gate (D1) -------------------------------------------------------

  it('refuses UNKNOWN_MERCHANT_TOKEN on every tool, and writes no audit event', async () => {
    for (const [name, args] of EVERY_TOOL) {
      const missing = await call(merchant, name, args);
      expect(missing.isError, `${name} without a token`).toBe(true);
      expect(missing.body['refusal']).toMatchObject({
        code: 'UNKNOWN_MERCHANT_TOKEN',
        recoverable: true,
      });

      const wrong = await call(merchant, name, { ...args, merchantToken: 'mrc_tok_nope' });
      expect(wrong.isError, `${name} with a wrong token`).toBe(true);
      expect(wrong.body['refusal']).toMatchObject({ code: 'UNKNOWN_MERCHANT_TOKEN' });
      // The presented secret-shaped string is never echoed back.
      expect(JSON.stringify(wrong.body)).not.toContain('mrc_tok_nope');
    }

    // The audit log is the money ledger (ADR-0003) and the merchant face is
    // not the money path: a refused merchant call leaves it empty.
    expect(await auditChain(deps.db)).toEqual([]);
  });

  // --- Reading the queue ---------------------------------------------------

  it('lists exactly the held Products, with their holds and honest null stock', async () => {
    const { isError, body } = await call(merchant, 'list_held_products', { merchantToken });
    expect(isError).toBe(false);

    const products = body['products'] as Array<Record<string, any>>;
    expect(products.map((p) => p.productId).sort()).toEqual([CARGO_PRODUCT, TEE_PRODUCT].sort());

    const tee = products.find((p) => p.productId === TEE_PRODUCT)!;
    expect(tee.status).toBe('needs_confirmation');
    expect(tee.holds).toEqual([{ field: 'stock', reason: 'the caption never states a stock count' }]);
    expect(tee.variants).toEqual([
      { variantId: TEE_VARIANT, label: null, pricePaise: 119900, stock: null },
    ]);
  });

  it('get_held_product returns the extraction record; an unknown id is a validation error', async () => {
    const found = await call(merchant, 'get_held_product', {
      merchantToken,
      productId: TEE_PRODUCT,
    });
    expect(found.isError).toBe(false);
    const product = found.body['product'] as Record<string, any>;
    expect(product.extraction.caption).toBe(TEE);
    expect(product.extraction.fields.name).toEqual({
      value: 'RAAT Oversized Tee',
      confidence: 0.97,
      belowThreshold: false,
    });

    const missing = await call(merchant, 'get_held_product', {
      merchantToken,
      productId: 'prd_nope',
    });
    expect(missing.isError).toBe(true);
    // A validation error, NOT a Refusal: no buyer is anywhere near this seam.
    expect(missing.body['refusal']).toBeUndefined();
    expect(missing.body['validationError']).toMatchObject({ code: 'PRODUCT_NOT_FOUND' });
  });

  // --- Confirming (D2) -----------------------------------------------------

  it('confirms with an overlay of stock only, and the buyer face immediately sees it', async () => {
    const buyerBefore = await call(buyer, 'get_product', {});
    expect((buyerBefore.body['variants'] as unknown[]).map((v: any) => v.variantId)).not.toContain(
      TEE_VARIANT,
    );

    const confirmed = await call(merchant, 'confirm_product', {
      merchantToken,
      productId: TEE_PRODUCT,
      variants: [{ variantId: TEE_VARIANT, stock: 12 }],
    });
    expect(confirmed.isError).toBe(false);
    expect(confirmed.body['status']).toBe('published');
    // Title, description and price were never mentioned — they carried through.
    expect(confirmed.body['product']).toMatchObject({
      title: 'RAAT Oversized Tee',
      variants: [{ variantId: TEE_VARIANT, label: null, pricePaise: 119900, stock: 12 }],
    });

    const buyerAfter = await call(buyer, 'get_product', {});
    const listed = (buyerAfter.body['variants'] as Array<Record<string, any>>).find(
      (v) => v.variantId === TEE_VARIANT,
    );
    expect(listed).toMatchObject({ stock: 12, price: { amountPaise: 119900 } });
  });

  it('never deletes a Variant the merchant left out of the call', async () => {
    // The merchant already answered L on the web screen; from chat they answer
    // only S and M. On the web face an omitted row means "delete"; here it
    // must mean "leave it alone" (D2).
    await deps.db.update(variants).set({ stock: 7 }).where(eq(variants.id, CARGO_L));

    const confirmed = await call(merchant, 'confirm_product', {
      merchantToken,
      productId: CARGO_PRODUCT,
      variants: [
        { variantId: CARGO_S, stock: 4 },
        { variantId: CARGO_M, stock: 6 },
      ],
    });
    expect(confirmed.isError).toBe(false);

    const rows = await deps.db.select().from(variants).where(eq(variants.productId, CARGO_PRODUCT));
    expect(rows.map((row) => row.id).sort()).toEqual([CARGO_L, CARGO_M, CARGO_S].sort());
    expect(rows.find((row) => row.id === CARGO_L)!.stock).toBe(7);
  });

  it('rejects INVALID_CONFIRMATION when a Variant is left without a stated stock', async () => {
    const result = await call(merchant, 'confirm_product', {
      merchantToken,
      productId: CARGO_PRODUCT,
      variants: [{ variantId: CARGO_S, stock: 4 }],
    });
    expect(result.isError).toBe(true);
    expect(result.body['validationError']).toMatchObject({ code: 'INVALID_CONFIRMATION' });
    // Nothing published: a partial answer leaves the Product on the queue.
    const held = await call(merchant, 'list_held_products', { merchantToken });
    expect((held.body['products'] as Array<Record<string, any>>).map((p) => p.productId)).toContain(
      CARGO_PRODUCT,
    );
  });

  it('rejects PRODUCT_NOT_CONFIRMABLE on a Product that is already published', async () => {
    await call(merchant, 'confirm_product', {
      merchantToken,
      productId: TEE_PRODUCT,
      variants: [{ variantId: TEE_VARIANT, stock: 12 }],
    });

    const again = await call(merchant, 'confirm_product', {
      merchantToken,
      productId: TEE_PRODUCT,
      variants: [{ variantId: TEE_VARIANT, stock: 3 }],
    });
    expect(again.isError).toBe(true);
    expect(again.body['validationError']).toMatchObject({ code: 'PRODUCT_NOT_CONFIRMABLE' });
  });

  // --- Reading the live catalog -------------------------------------------

  it('list_my_products shows published Products only, grouped by Product', async () => {
    const before = await call(merchant, 'list_my_products', { merchantToken });
    const beforeIds = (before.body['products'] as Array<Record<string, any>>).map(
      (p) => p.productId,
    );
    expect(beforeIds).toEqual([productIdForSource(AUTO)]);

    await call(merchant, 'confirm_product', {
      merchantToken,
      productId: TEE_PRODUCT,
      variants: [{ variantId: TEE_VARIANT, stock: 12 }],
    });

    const after = await call(merchant, 'list_my_products', { merchantToken });
    const products = after.body['products'] as Array<Record<string, any>>;
    expect(products.map((p) => p.productId).sort()).toEqual(
      [productIdForSource(AUTO), TEE_PRODUCT].sort(),
    );
    // Held Products are absent in whole, never field-by-field.
    expect(products.map((p) => p.productId)).not.toContain(CARGO_PRODUCT);
    expect(products.find((p) => p.productId === TEE_PRODUCT)!.variants).toEqual([
      {
        variantId: TEE_VARIANT,
        label: null,
        pricePaise: 119900,
        priceDisplay: '₹1,199.00',
        stock: 12,
      },
    ]);
  });
});

import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { merchants, variants } from '../db/schema.js';
import type { StorefrontDeps } from '../deps.js';
import { readPurchaseAuditChain } from '../domain/auditLog.js';
import { hashMandate } from '../domain/mandates.js';
import { ensureMerchantSigningKey, ensureMerchantToken } from '../domain/merchants.js';
import { paise } from '../domain/money.js';
import { applyGatewayWebhook, type WebhookOutcome } from '../domain/orders.js';
import { findOrderReceipt } from '../domain/receipts.js';
import { StubGateway, type SyntheticWebhook } from '../gateway/stubGateway.js';
import {
  ingestItems,
  productIdForSource,
  variantIdForSource,
  type IngestItem,
} from '../ingestion/ingest.js';
import { archiveProduct } from '../ingestion/archiveProduct.js';
import {
  ExtractionError,
  type ExtractionInput,
  type ExtractionModel,
  type ExtractionResult,
  type ProductExtraction,
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

/**
 * S1.5 (issue #42): the merchant's three read tools, driven through the same
 * MCP door and seeded through the real purchase path — a buyer agent buying
 * over the buyer face, a stub gateway settling one capture and one decline,
 * and one refusal the trust layer wrote.
 *
 * The proofs on trial:
 *   1. `store_summary` counts what the database actually holds — catalog by
 *      status, Orders by status, revenue in paise, low stock, sold out, and
 *      the Refusals as unmet demand.
 *   2. `list_recent_orders` is newest-first and honours `limit`.
 *   3. `get_order` replays exactly `readPurchaseAuditChain`, and an unknown id
 *      is an ORDER_NOT_FOUND validation error shaped like PRODUCT_NOT_FOUND.
 *   4. The `merchantToken` gate covers all three, writing no audit event.
 */

// A fourth caption that stays on the queue, so "held" is a non-zero count.
const HELD = '11-noor-shirt';

const READ_EXTRACTIONS: Record<string, ProductExtraction> = {
  ...EXTRACTIONS,
  [HELD]: confident({
    name: { value: 'Noor Camp Shirt', confidence: 0.96 },
    price: { value: paise(159900), confidence: 0.95 },
    priceText: { value: '₹1,599/-', confidence: 0.95 },
  }),
};

const readsModel: ExtractionModel = {
  modelId: 'canned-extractor',
  extract: (input: ExtractionInput): Promise<ExtractionResult> => {
    const extraction = READ_EXTRACTIONS[input.caption];
    if (extraction === undefined) throw new Error(`No canned extraction for: ${input.caption}`);
    return Promise.resolve({ extraction, modelId: 'canned-extractor-2026-09-03', rawResponse: '{}' });
  },
};

const HELD_PRODUCT = productIdForSource(HELD);

/** The three read tools, with the arguments each needs beyond the token. */
const EVERY_READ_TOOL: ReadonlyArray<[string, Record<string, unknown>]> = [
  ['store_summary', {}],
  ['list_recent_orders', {}],
  ['get_order', { orderId: 'ord_nope' }],
];

describe('S1.5 the merchant read tools', () => {
  let handle: TestDatabaseHandle;
  let gateway: StubGateway;
  let deps: StorefrontDeps;
  let merchant: Client;
  let buyer: Client;
  let merchantToken: string;
  let paidOrderId: string;
  let cancelledOrderId: string;

  /** The same three steps the webhook route performs, minus the socket. */
  async function deliver(hook: SyntheticWebhook): Promise<WebhookOutcome> {
    expect(deps.gateway.verifyWebhookSignature(hook.rawBody, hook.signature)).toBe(true);
    const event = deps.gateway.parseWebhookEvent(hook.rawBody);
    return applyGatewayWebhook(deps.db, deps.merchantId, event, deps.gateway.name);
  }

  /** Register → declare → cart → submit, as a buyer agent actually does it. */
  async function purchase(
    agentToken: string,
    variantId: string,
  ): Promise<{ orderId: string; gatewayPaymentLinkId: string }> {
    const intent = await call(buyer, 'declare_intent', {
      agentToken,
      want: 'something from this store',
      budgetPaise: 400000,
    });
    expect(intent.isError).toBe(false);
    const cart = await call(buyer, 'create_cart', {
      agentToken,
      intentHash: intent.body['intentHash'],
      items: [{ variantId, quantity: 1 }],
    });
    expect(cart.isError).toBe(false);
    const submitted = await call(buyer, 'submit_payment', {
      agentToken,
      cartHash: cart.body['cartHash'],
      idempotencyKey: randomUUID(),
    });
    expect(submitted.isError, JSON.stringify(submitted.body)).toBe(false);
    return {
      orderId: submitted.body['orderId'] as string,
      gatewayPaymentLinkId: submitted.body['gatewayPaymentLinkId'] as string,
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
    // A Receipt is merchant-signed, so the key has to exist before any capture.
    await ensureMerchantSigningKey(handle.db, MERCHANT_ID);
    merchantToken = (await ensureMerchantToken(handle.db, MERCHANT_ID)).token;

    await ingestItems(handle.db, MERCHANT_ID, readsModel, [
      item(TEE),
      item(CARGO),
      item(AUTO),
      item(HELD),
    ]);

    merchant = new Client({ name: 'test-merchant', version: '0.0.0' });
    const merchantPair = InMemoryTransport.createLinkedPair();
    await Promise.all([
      createMerchantMcpServer(deps).connect(merchantPair[1]),
      merchant.connect(merchantPair[0]),
    ]);

    buyer = new Client({ name: 'test-buyer', version: '0.0.0' });
    const buyerPair = InMemoryTransport.createLinkedPair();
    await Promise.all([createMcpServer(deps).connect(buyerPair[1]), buyer.connect(buyerPair[0])]);

    // Publish the two held Products, leaving HELD on the queue. CARGO's S is
    // confirmed at zero — a stated sell-out, which is a fact, not a hold.
    await call(merchant, 'confirm_product', {
      merchantToken,
      productId: TEE_PRODUCT,
      variants: [{ variantId: TEE_VARIANT, stock: 3 }],
    });
    await call(merchant, 'confirm_product', {
      merchantToken,
      productId: CARGO_PRODUCT,
      variants: [
        { variantId: CARGO_S, stock: 0 },
        { variantId: CARGO_M, stock: 6 },
        { variantId: CARGO_L, stock: 5 },
      ],
    });

    const registration = await call(buyer, 'register_agent', { capPaise: 500000 });
    const agentToken = registration.body['agentToken'] as string;

    // One Order that pays: TEE, 119900 paise, stock 3 → 2 (low stock).
    const paid = await purchase(agentToken, TEE_VARIANT);
    paidOrderId = paid.orderId;
    const captures = gateway.completePayment(paid.gatewayPaymentLinkId);
    expect(await deliver(captures[0]!)).toEqual({ result: 'order_paid', orderId: paidOrderId });
    await deliver(captures[1]!);

    // One Order that fails closed: CARGO M, declined twice (PAYMENT_ATTEMPT_LIMIT).
    const doomed = await purchase(agentToken, CARGO_M);
    cancelledOrderId = doomed.orderId;
    await deliver(gateway.failPayment(doomed.gatewayPaymentLinkId)[0]!);
    const cancelled = await deliver(gateway.failPayment(doomed.gatewayPaymentLinkId)[0]!);
    expect(cancelled.result).toBe('order_cancelled');

    // One Refusal: a second agent whose Cap cannot cover the cheapest thing.
    const tight = await call(buyer, 'register_agent', { capPaise: 1000 });
    const tightToken = tight.body['agentToken'] as string;
    const intent = await call(buyer, 'declare_intent', {
      agentToken: tightToken,
      want: 'a tee',
      budgetPaise: 400000,
    });
    const cart = await call(buyer, 'create_cart', {
      agentToken: tightToken,
      intentHash: intent.body['intentHash'],
      items: [{ variantId: TEE_VARIANT, quantity: 1 }],
    });
    const refused = await call(buyer, 'submit_payment', {
      agentToken: tightToken,
      cartHash: cart.body['cartHash'],
      idempotencyKey: randomUUID(),
    });
    expect(refused.isError).toBe(true);
    expect((refused.body['refusal'] as Record<string, unknown>)['code']).toBe('OVER_CAP');
  });

  afterEach(async () => {
    await merchant.close();
    await buyer.close();
    await handle.close();
  });

  // --- The gate (D1) -------------------------------------------------------

  it('refuses UNKNOWN_MERCHANT_TOKEN on every read tool, and writes no audit event', async () => {
    const before = await auditChain(deps.db);

    for (const [name, args] of EVERY_READ_TOOL) {
      const missing = await call(merchant, name, args);
      expect(missing.isError, `${name} without a token`).toBe(true);
      expect(missing.body['refusal']).toMatchObject({
        code: 'UNKNOWN_MERCHANT_TOKEN',
        recoverable: true,
      });

      const wrong = await call(merchant, name, { ...args, merchantToken: 'mrc_tok_nope' });
      expect(wrong.isError, `${name} with a wrong token`).toBe(true);
      expect(wrong.body['refusal']).toMatchObject({ code: 'UNKNOWN_MERCHANT_TOKEN' });
      expect(JSON.stringify(wrong.body)).not.toContain('mrc_tok_nope');
    }

    // Reads are reads: neither the refusals above nor the successful calls
    // below add anything to the money ledger.
    await call(merchant, 'store_summary', { merchantToken });
    await call(merchant, 'list_recent_orders', { merchantToken });
    await call(merchant, 'get_order', { merchantToken, orderId: paidOrderId });
    expect(await auditChain(deps.db)).toEqual(before);
  });

  // --- store_summary -------------------------------------------------------

  it('store_summary counts the catalog, the Orders and the money in paise', async () => {
    const { isError, body } = await call(merchant, 'store_summary', { merchantToken });
    expect(isError).toBe(false);

    // TEE, CARGO and AUTO published; HELD still waiting on the merchant.
    expect(body['catalog']).toEqual({ published: 3, heldForConfirmation: 1, draft: 0 });
    expect(body['ordersByStatus']).toEqual({ paid: 1, cancelled: 1 });
    // Integer paise, never rupees: the one paid Order is the TEE at ₹1,199.00,
    // and the cancelled CARGO Order contributes nothing.
    expect(body['revenue']).toEqual({ todayPaise: 119900, totalPaise: 119900 });
  });

  it('store_summary names the low-stock and sold-out Variants', async () => {
    const { body } = await call(merchant, 'store_summary', { merchantToken });

    // TEE was confirmed at 3 and one unit sold: 2 is at the threshold.
    expect(body['lowStock']).toEqual([
      {
        productId: TEE_PRODUCT,
        productTitle: 'RAAT Oversized Tee',
        variantId: TEE_VARIANT,
        label: null,
        stock: 2,
      },
    ]);
    // Sold out is its own list, never folded into low stock.
    expect(body['soldOut']).toEqual([
      {
        productId: CARGO_PRODUCT,
        productTitle: 'Galli Cargo Pants',
        variantId: CARGO_S,
        label: 'S',
        stock: 0,
      },
    ]);
    // The held Product is invisible here in whole: it is not buyable yet.
    expect(JSON.stringify(body['lowStock']) + JSON.stringify(body['soldOut'])).not.toContain(
      HELD_PRODUCT,
    );
  });

  it('store_summary reports the Refusals as unmet demand, newest reasons quoted', async () => {
    const { body } = await call(merchant, 'store_summary', { merchantToken });
    const unmet = body['unmetDemand'] as Record<string, unknown>;

    expect(unmet['refusals']).toBe(1);
    const reasons = unmet['recentReasons'] as Array<Record<string, unknown>>;
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatchObject({ type: 'payment.refused', code: 'OVER_CAP' });
    expect(typeof reasons[0]!['reason']).toBe('string');
  });

  // --- list_recent_orders --------------------------------------------------

  it('list_recent_orders is newest first, in paise, with lines and the Receipt hash', async () => {
    const { isError, body } = await call(merchant, 'list_recent_orders', { merchantToken });
    expect(isError).toBe(false);

    const rows = body['orders'] as Array<Record<string, any>>;
    expect(rows.map((row) => row.orderId)).toEqual([cancelledOrderId, paidOrderId]);

    const paid = rows[1]!;
    expect(paid.status).toBe('paid');
    expect(paid.amountPaise).toBe(119900);
    expect(paid.items).toEqual([
      {
        productTitle: 'RAAT Oversized Tee',
        label: null,
        quantity: 1,
        unitPricePaise: 119900,
      },
    ]);
    // The Receipt is identified by its payload hash — the same value the
    // buyer's own Receipt carries.
    const receipt = await findOrderReceipt(deps.db, MERCHANT_ID, paidOrderId);
    expect(paid.receiptHash).toBe(hashMandate(receipt!.payload));
    expect(typeof paid.createdAt).toBe('string');

    // A cancelled Order never had a Receipt to show.
    expect(rows[0]!.status).toBe('cancelled');
    expect(rows[0]!.receiptHash).toBeNull();
  });

  it('list_recent_orders honours limit', async () => {
    const { body } = await call(merchant, 'list_recent_orders', { merchantToken, limit: 1 });
    const rows = body['orders'] as Array<Record<string, any>>;
    expect(rows.map((row) => row.orderId)).toEqual([cancelledOrderId]);
  });

  // --- get_order -----------------------------------------------------------

  it('get_order replays exactly the purchase audit chain the viewer shows', async () => {
    const { isError, body } = await call(merchant, 'get_order', {
      merchantToken,
      orderId: paidOrderId,
    });
    expect(isError).toBe(false);

    const chain = await readPurchaseAuditChain(deps.db, paidOrderId);
    const events = body['events'] as Array<Record<string, unknown>>;
    expect(events.map((event) => event.seq)).toEqual(chain.map((entry) => entry.seq));
    expect(events.map((event) => event.type)).toEqual(chain.map((entry) => entry.type));
    // The mandate events written before the Order existed are in the chain —
    // without them a completed purchase would read as incomplete.
    expect(events.map((event) => event.type)).toContain('mandate.intent_declared');

    expect(body['complete']).toBe(true);
    expect(body['missingSteps']).toEqual([]);
    expect(body['anomalies']).toBe(0);
    expect(body['order']).toMatchObject({
      orderId: paidOrderId,
      status: 'paid',
      total: { amountPaise: 119900 },
    });
  });

  it('get_order shows a cancelled Order as incomplete, with its Decline', async () => {
    const { body } = await call(merchant, 'get_order', {
      merchantToken,
      orderId: cancelledOrderId,
    });
    expect(body['complete']).toBe(false);
    expect(body['missingSteps']).not.toEqual([]);
    expect(body['order']).toMatchObject({
      status: 'cancelled',
      decline: { kind: 'decline' },
    });
  });

  it('get_order on an unknown id is an ORDER_NOT_FOUND validation error', async () => {
    const missing = await call(merchant, 'get_order', { merchantToken, orderId: 'ord_nope' });
    expect(missing.isError).toBe(true);
    // A validation error, NOT a Refusal — exactly as PRODUCT_NOT_FOUND is.
    expect(missing.body['refusal']).toBeUndefined();
    expect(missing.body['validationError']).toMatchObject({ code: 'ORDER_NOT_FOUND' });
  });
});

/**
 * S1.3 (issue #41): the tracer bullet — a Merchant adds a product from chat and
 * a buyer can buy it, without a browser anywhere in the story.
 *
 * Appended as its own block rather than folded into the S1.2 suite above: it
 * needs a different `deps` (one carrying an extraction model), and this file is
 * edited by more than one ticket in flight.
 */
describe('S1.3 submit_catalog_item', () => {
  // Stock deliberately unstated — the 0.90 gate firing on camera IS the demo
  // beat (plan §4), so the tracer exercises exactly that path.
  const SUBMITTED_CAPTION =
    'NEW DROP 🔥 Sarhad Panelled Jacket — heavyweight cotton, ₹2,499/- only. DM to order.';

  const submittedExtraction: ProductExtraction = {
    name: { value: 'Sarhad Panelled Jacket', confidence: 0.96 },
    description: { value: 'Heavyweight cotton panelled jacket.', confidence: 0.94 },
    price: { value: paise(249900), confidence: 0.97 },
    priceText: { value: '₹2,499/-', confidence: 0.97 },
    stock: { value: null, confidence: 0 },
    variantLabels: { value: [], confidence: 0.95 },
    variantStock: { value: {}, confidence: 0.95 },
  };

  let handle: TestDatabaseHandle;
  let merchant: Client;
  let buyer: Client;
  let merchantToken: string;
  let seen: ExtractionInput[];

  async function connect(deps: StorefrontDeps): Promise<void> {
    merchant = new Client({ name: 'test-merchant', version: '0.0.0' });
    const merchantPair = InMemoryTransport.createLinkedPair();
    await Promise.all([
      createMerchantMcpServer(deps).connect(merchantPair[1]),
      merchant.connect(merchantPair[0]),
    ]);
    buyer = new Client({ name: 'test-buyer', version: '0.0.0' });
    const buyerPair = InMemoryTransport.createLinkedPair();
    await Promise.all([createMcpServer(deps).connect(buyerPair[1]), buyer.connect(buyerPair[0])]);
  }

  function baseDeps(): StorefrontDeps {
    return {
      db: handle.db,
      gateway: new StubGateway(),
      merchantId: MERCHANT_ID,
      publicBaseUrl: 'https://merchant.example',
    };
  }

  beforeEach(async () => {
    handle = await createTestDatabase();
    await handle.db.insert(merchants).values({ id: MERCHANT_ID, name: 'Kalaakar Streetwear' });
    merchantToken = (await ensureMerchantToken(handle.db, MERCHANT_ID)).token;
    seen = [];
  });

  afterEach(async () => {
    await merchant.close();
    await buyer.close();
    await handle.close();
  });

  const submittingModel = (): ExtractionModel => ({
    modelId: 'canned-extractor',
    extract: (input: ExtractionInput): Promise<ExtractionResult> => {
      seen.push(input);
      return Promise.resolve({
        extraction: submittedExtraction,
        modelId: 'canned-extractor-2026-09-03',
        rawResponse: '{}',
      });
    },
  });

  it('carries a chat submission all the way to a buyable Variant on the buyer face', async () => {
    await connect({ ...baseDeps(), extractionModel: submittingModel() });

    // 1. The merchant sends the caption verbatim; extraction runs server-side.
    const submitted = await call(merchant, 'submit_catalog_item', {
      merchantToken,
      caption: SUBMITTED_CAPTION,
    });
    expect(submitted.isError).toBe(false);
    expect(seen[0]!.caption).toBe(SUBMITTED_CAPTION);

    const productId = submitted.body['productId'] as string;
    expect(productId).toMatch(/^prd_[0-9a-f]{32}$/);
    expect(productId).not.toContain('prd_demo_');
    expect(submitted.body['sourceId'] as string).toMatch(/^sub_/);
    expect(submitted.body['title']).toBe('Sarhad Panelled Jacket');
    // 2. The caption stated no stock, so the gate holds the whole Product.
    expect(submitted.body['status']).toBe('needs_confirmation');
    expect(submitted.body['holds']).toEqual([
      { field: 'stock', reason: 'the caption never states a stock count' },
    ]);
    expect(submitted.body['nextStep']).toContain('confirm_product');

    // 3. It is on the confirmation queue, with honest nulls.
    const held = await call(merchant, 'list_held_products', { merchantToken });
    const queued = (held.body['products'] as Array<Record<string, any>>).find(
      (p) => p.productId === productId,
    );
    expect(queued).toBeDefined();
    expect(queued!.variants[0].stock).toBeNull();
    expect(queued!.variants[0].pricePaise).toBe(249900);
    const variantId = queued!.variants[0].variantId as string;
    expect(variantId).toMatch(/^var_[0-9a-f]{32}$/);

    // 4. The buyer cannot see it yet — a held Product is invisible in whole.
    const before = await call(buyer, 'get_product', {});
    expect((before.body['variants'] as Array<Record<string, any>>)).toEqual([]);

    // 5. The merchant answers the one held field in chat.
    const confirmed = await call(merchant, 'confirm_product', {
      merchantToken,
      productId,
      variants: [{ variantId, stock: 9 }],
    });
    expect(confirmed.isError).toBe(false);
    expect(confirmed.body['status']).toBe('published');

    // 6. And the buyer face lists the new Variant with the confirmed stock.
    const after = await call(buyer, 'get_product', {});
    const listed = (after.body['variants'] as Array<Record<string, any>>).find(
      (v) => v.variantId === variantId,
    );
    expect(listed).toMatchObject({ stock: 9, price: { amountPaise: 249900 } });
  });

  it('refuses EXTRACTION_NOT_CONFIGURED when the deployment has no model', async () => {
    // The storefront boots without an LLM key; exactly one tool notices.
    await connect(baseDeps());

    const result = await call(merchant, 'submit_catalog_item', {
      merchantToken,
      caption: SUBMITTED_CAPTION,
    });
    expect(result.isError).toBe(true);
    expect(result.body['error']).toMatchObject({ code: 'EXTRACTION_NOT_CONFIGURED' });
    // Neither a Refusal nor a validation error — a distinct third shape.
    expect(result.body['refusal']).toBeUndefined();
    expect(result.body['validationError']).toBeUndefined();

    // The rest of the face still works.
    const live = await call(merchant, 'list_my_products', { merchantToken });
    expect(live.isError).toBe(false);
  });

  it('surfaces a refused photo link as INVALID_IMAGE and writes nothing', async () => {
    const refusesEverything: typeof fetch = () => {
      throw new Error('fetch must not be reached for a blocked address');
    };
    await connect({
      ...baseDeps(),
      extractionModel: submittingModel(),
      fetchImpl: refusesEverything,
    });

    const result = await call(merchant, 'submit_catalog_item', {
      merchantToken,
      caption: SUBMITTED_CAPTION,
      imageUrl: 'http://169.254.169.254/latest/meta-data/',
    });
    expect(result.isError).toBe(true);
    expect(result.body['validationError']).toMatchObject({ code: 'INVALID_IMAGE' });
    // The model was never called, and nothing landed on the queue.
    expect(seen).toEqual([]);
    const held = await call(merchant, 'list_held_products', { merchantToken });
    expect(held.body['products']).toEqual([]);
  });

  it('rejects INVALID_SUBMISSION for a blank caption or both image forms at once', async () => {
    await connect({ ...baseDeps(), extractionModel: submittingModel() });

    const blank = await call(merchant, 'submit_catalog_item', { merchantToken, caption: '   ' });
    expect(blank.body['validationError']).toMatchObject({ code: 'INVALID_SUBMISSION' });

    const both = await call(merchant, 'submit_catalog_item', {
      merchantToken,
      caption: SUBMITTED_CAPTION,
      imageUrl: 'https://cdn.example.com/a.jpg',
      imageBase64: 'AAAA',
      imageMediaType: 'image/jpeg',
    });
    expect(both.body['validationError']).toMatchObject({ code: 'INVALID_SUBMISSION' });
  });

  it('refuses the submit tool without a valid merchantToken, before any extraction', async () => {
    await connect({ ...baseDeps(), extractionModel: submittingModel() });

    const result = await call(merchant, 'submit_catalog_item', { caption: SUBMITTED_CAPTION });
    expect(result.isError).toBe(true);
    expect(result.body['refusal']).toMatchObject({ code: 'UNKNOWN_MERCHANT_TOKEN' });
    expect(seen).toEqual([]);
    expect(await auditChain(handle.db)).toEqual([]);
  });

  it('reports EXTRACTION_FAILED, with the retry hint when the provider gave one', async () => {
    const failing: ExtractionModel = {
      modelId: 'canned-extractor',
      extract: () =>
        Promise.reject(
          Object.assign(new ExtractionError('openrouter said 429: rate limited'), {
            retryAfterSeconds: 12,
          }),
        ),
    };
    await connect({ ...baseDeps(), extractionModel: failing });

    const result = await call(merchant, 'submit_catalog_item', {
      merchantToken,
      caption: SUBMITTED_CAPTION,
    });
    expect(result.isError).toBe(true);
    expect(result.body['error']).toMatchObject({ code: 'EXTRACTION_FAILED' });
    const message = (result.body['error'] as Record<string, string>)['message'] ?? '';
    expect(message).toContain('rate limited');
    expect(message).toContain('12 seconds');
  });

  it('creates a second Product from the same caption — submissions are never merged', async () => {
    await connect({ ...baseDeps(), extractionModel: submittingModel() });

    const first = await call(merchant, 'submit_catalog_item', {
      merchantToken,
      caption: SUBMITTED_CAPTION,
    });
    const second = await call(merchant, 'submit_catalog_item', {
      merchantToken,
      caption: SUBMITTED_CAPTION,
    });
    expect(second.body['productId']).not.toBe(first.body['productId']);
    const held = await call(merchant, 'list_held_products', { merchantToken });
    expect(held.body['products']).toHaveLength(2);
  });

  it('archive takes a mis-submitted Product back off the buyer face (plan D3)', async () => {
    await connect({ ...baseDeps(), extractionModel: submittingModel() });

    const submitted = await call(merchant, 'submit_catalog_item', {
      merchantToken,
      caption: SUBMITTED_CAPTION,
    });
    const productId = submitted.body['productId'] as string;
    const held = await call(merchant, 'list_held_products', { merchantToken });
    const variantId = (held.body['products'] as Array<Record<string, any>>)[0]!.variants[0]
      .variantId as string;
    await call(merchant, 'confirm_product', {
      merchantToken,
      productId,
      variants: [{ variantId, stock: 9 }],
    });
    const live = await call(buyer, 'get_product', {});
    expect((live.body['variants'] as Array<Record<string, any>>).map((v) => v.variantId)).toContain(
      variantId,
    );

    expect(await archiveProduct(handle.db, MERCHANT_ID, productId)).toBe(true);

    const gone = await call(buyer, 'get_product', {});
    expect(
      (gone.body['variants'] as Array<Record<string, any>>).map((v) => v.variantId),
    ).not.toContain(variantId);
    // …and it does not reappear on the confirmation queue either.
    const queue = await call(merchant, 'list_held_products', { merchantToken });
    expect(queue.body['products']).toEqual([]);
  });
});

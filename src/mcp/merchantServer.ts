import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MERCHANT_NAME } from '../config.js';
import type { StorefrontDeps } from '../deps.js';
import {
  missingHappyPathSteps,
  type AuditChainEntry,
  type WireAuditEvent,
} from '../domain/auditEvents.js';
import { listRecentRefusals, readPurchaseAuditChain } from '../domain/auditLog.js';
import { listPublishedVariants } from '../domain/catalog.js';
import {
  confirmProduct,
  findConfirmationProduct,
  listProductsNeedingConfirmation,
  type ConfirmationProductView,
  type ConfirmationSubmission,
  type ConfirmationVariantSubmission,
} from '../domain/confirmation.js';
import { hashMandate } from '../domain/mandates.js';
import { requireMerchant } from '../domain/merchants.js';
import {
  findOrderById,
  listOrderItems,
  listRecentOrders,
  toOrderStatusView,
} from '../domain/orders.js';
import { findOrderReceipt } from '../domain/receipts.js';
import { ValidationError } from '../domain/refusal.js';
import { readStoreCounts } from '../domain/storeSummary.js';
import { submitCatalogItem } from '../ingestion/submission.js';
import { ExtractionError } from '../ingestion/types.js';
import { errorResult, textResult, withToolErrors } from './toolResults.js';

/**
 * The merchant face (S1.2) — a second, separate MCP endpoint (`/merchant/mcp`)
 * the Merchant connects from chat, mirroring the buyer face's shape exactly:
 * stateless Streamable HTTP, authless transport, identity presented *in* the
 * protocol as an ordinary tool argument (`merchantToken`, the mirror of
 * `agentToken` — PLAN §3/§5.2, plan D1).
 *
 * Separate rather than merged because a buyer must never even *see* a tool
 * that edits the catalog: tool-set isolation is the boundary, not an
 * authorization check inside a shared tool list.
 *
 * The tools here are the Confirmation queue in conversational form. They own no
 * publish rules of their own: `confirm_product` overlays what the merchant said
 * onto the stored draft and hands the result to the SAME `confirmProduct` the
 * web screen calls, so the "nothing unconfirmed is ever published" gate and the
 * ConfirmationStamp are one implementation with two front doors.
 */

/** Held Products carry null price/stock — the honest "the caption never said". */
function heldView(product: ConfirmationProductView) {
  return {
    productId: product.productId,
    title: product.title,
    description: product.description,
    status: product.status,
    caption: product.extraction?.caption ?? null,
    holds: product.extraction?.holds ?? [],
    variants: product.variants.map((variant) => ({
      variantId: variant.variantId,
      label: variant.label,
      pricePaise: variant.pricePaise,
      stock: variant.stock,
    })),
  };
}

interface VariantOverlay {
  readonly variantId?: string | undefined;
  readonly label?: string | undefined;
  readonly pricePaise?: number | undefined;
  readonly stock?: number | undefined;
}

function invalid(message: string): ValidationError {
  return new ValidationError('INVALID_CONFIRMATION', message);
}

/**
 * The D2 overlay: turn what the merchant *said in chat* into the complete final
 * state `confirmProduct` demands.
 *
 * Additive by decision (plan D2) — an entry with a `variantId` corrects that
 * row's price/stock, an entry with a `label` and no id inserts a new row, and a
 * stored row the merchant did not mention is carried through untouched. Nothing
 * is ever deleted from chat, because "the model omitted it" and "the merchant
 * wants it gone" are indistinguishable in a transcript. The web confirm screen
 * keeps its complete-state semantics: there, an absent row is a deliberate
 * click, and deleting a mis-extracted phantom Variant is the point.
 */
export function overlayConfirmation(
  product: ConfirmationProductView,
  overlay: {
    title?: string | undefined;
    description?: string | undefined;
    variants: readonly VariantOverlay[];
  },
): ConfirmationSubmission {
  const byId = new Map<string, VariantOverlay>();
  for (const entry of overlay.variants) {
    if (entry.variantId === undefined) continue;
    if (!product.variants.some((v) => v.variantId === entry.variantId)) {
      throw invalid(
        `variantId ${entry.variantId} does not belong to product ${product.productId} — ` +
          'omit variantId to add a new Variant',
      );
    }
    if (byId.has(entry.variantId)) throw invalid(`variantId submitted twice: ${entry.variantId}`);
    byId.set(entry.variantId, entry);
  }

  const updated = product.variants.map((stored): ConfirmationVariantSubmission => {
    const edit = byId.get(stored.variantId);
    const pricePaise = edit?.pricePaise ?? stored.pricePaise;
    const stock = edit?.stock ?? stored.stock;
    if (pricePaise === null) {
      throw invalid(
        `variant ${stored.label ?? '(default)'} has no price yet — send pricePaise for ` +
          `variantId ${stored.variantId}`,
      );
    }
    if (stock === null) {
      throw invalid(
        `variant ${stored.label ?? '(default)'} has no stock yet — send stock for ` +
          `variantId ${stored.variantId}`,
      );
    }
    return { variantId: stored.variantId, label: stored.label, pricePaise, stock };
  });

  const inserted = overlay.variants
    .filter((entry) => entry.variantId === undefined)
    .map((entry): ConfirmationVariantSubmission => {
      if (entry.label === undefined) {
        throw invalid('a new Variant needs a label — send variantId to correct an existing one');
      }
      if (entry.pricePaise === undefined || entry.stock === undefined) {
        throw invalid(`a new Variant needs both pricePaise and stock — got label ${entry.label}`);
      }
      return { label: entry.label, pricePaise: entry.pricePaise, stock: entry.stock };
    });

  return {
    title: overlay.title ?? product.title,
    description: overlay.description ?? product.description,
    variants: [...updated, ...inserted],
  };
}

const MERCHANT_TOKEN_ARG = z
  .string()
  .optional()
  .describe(
    "This store's merchantToken (it starts with mrc_tok_). Every tool on this face " +
      'requires it; calls without a valid one refuse UNKNOWN_MERCHANT_TOKEN.',
  );

export function createMerchantMcpServer(deps: StorefrontDeps): McpServer {
  const server = new McpServer(
    { name: 'agent-store-merchant', version: '0.1.0' },
    {
      instructions:
        `Merchant console for ${MERCHANT_NAME} — you are talking to the shopkeeper's ` +
        `side of the store, not a buyer's. All prices are integer paise (INR): ` +
        `129900 means ₹1,299.00 — never send rupees or decimals. Every tool takes ` +
        `merchantToken, the store's own token; without a valid one every call refuses ` +
        `UNKNOWN_MERCHANT_TOKEN. Products enter the catalog through extraction from the ` +
        `merchant's caption, and anything the caption did not state is held rather than ` +
        `invented: (1) list_held_products shows every Product waiting on the merchant, ` +
        `with the exact fields that are missing. (2) get_held_product shows one of them ` +
        `in full, including what the model read and how sure it was. (3) confirm_product ` +
        `supplies the missing values and publishes — ask the merchant for the numbers, ` +
        `never guess them, and send only what changed: a Variant you do not mention keeps ` +
        `its stored values, and nothing is ever deleted from here. (4) list_my_products ` +
        `shows what is currently published and buyable. A published Product is live ` +
        `immediately for buyer agents. (5) submit_catalog_item adds a NEW Product from the ` +
        `merchant's own post: send the caption VERBATIM (never your description of the ` +
        `photo) and optionally a public photo link — the server reads it, and every call ` +
        `creates another Product, so never call it to correct one. The merchant also ` +
        `reads their store from here: store_summary answers "how is the shop doing" in ` +
        `one call (catalog and order counts, revenue in paise today and in total, low ` +
        `stock, sold out, and the demand that was refused), list_recent_orders lists the ` +
        `latest Orders, and get_order replays one Order's whole audit chain.`,
    },
  );

  server.registerTool(
    'list_held_products',
    {
      title: 'List held products',
      description:
        'The confirmation queue: every Product held in needs-confirmation because ' +
        'extraction could not confidently read a field from the caption. Each entry lists ' +
        'its holds (the fields the merchant must answer) and its Variants, whose ' +
        'pricePaise or stock is null exactly where the value is still unknown.',
      inputSchema: { merchantToken: MERCHANT_TOKEN_ARG },
    },
    withToolErrors(async ({ merchantToken }) => {
      await requireMerchant(deps.db, deps.merchantId, merchantToken, 'list_held_products');
      const held = await listProductsNeedingConfirmation(deps.db, deps.merchantId);
      return textResult({
        merchant: MERCHANT_NAME,
        note: 'All prices are integer paise. A null value is honestly unknown, never zero.',
        products: held.map(heldView),
        nextStep:
          held.length === 0
            ? 'Nothing is waiting on the merchant.'
            : 'Ask the merchant for each held field, then call confirm_product.',
      });
    }),
  );

  server.registerTool(
    'get_held_product',
    {
      title: 'Get held product',
      description:
        'One Product in full, by productId — its Variants, its holds, and the extraction ' +
        'record showing what the model read from the caption and how confident it was. ' +
        'Works for any Product of this store, whatever its status.',
      inputSchema: {
        merchantToken: MERCHANT_TOKEN_ARG,
        productId: z.string().describe('A productId from list_held_products.'),
      },
    },
    withToolErrors(async ({ merchantToken, productId }) => {
      await requireMerchant(deps.db, deps.merchantId, merchantToken, 'get_held_product');
      const product = await findConfirmationProduct(deps.db, deps.merchantId, productId);
      if (product === null) {
        throw new ValidationError('PRODUCT_NOT_FOUND', `no product ${productId} for this merchant`);
      }
      return textResult({
        merchant: MERCHANT_NAME,
        product: { ...heldView(product), extraction: product.extraction },
      });
    }),
  );

  server.registerTool(
    'confirm_product',
    {
      title: 'Confirm product',
      description:
        'Answer the held fields and publish the Product. Additive: send only what you are ' +
        'changing. A variants entry WITH variantId corrects that Variant (pricePaise ' +
        'and/or stock); an entry with a label and NO variantId adds a new Variant, which ' +
        'needs both pricePaise and stock. A stored Variant you leave out is kept exactly ' +
        'as it is — nothing is ever deleted from chat. Publishing requires every Variant ' +
        'to end up with a real price and a stated stock (0 means sold out, which is a ' +
        'fact); if one is still unknown the call rejects INVALID_CONFIRMATION naming it. ' +
        'Only a needs-confirmation Product is confirmable.',
      inputSchema: {
        merchantToken: MERCHANT_TOKEN_ARG,
        productId: z.string().describe('The productId to publish.'),
        title: z.string().optional().describe('Corrected title. Omit to keep the stored one.'),
        description: z
          .string()
          .optional()
          .describe('Corrected description. Omit to keep the stored one.'),
        variants: z
          .array(
            z.object({
              variantId: z
                .string()
                .optional()
                .describe('An existing Variant to correct. Omit to add a new Variant.'),
              label: z
                .string()
                .optional()
                .describe('New Variants only: the size/colour label, e.g. "M".'),
              pricePaise: z
                .number()
                .optional()
                .describe('Integer paise, positive: 129900 means ₹1,299.00.'),
              stock: z.number().optional().describe('Units on hand, an integer ≥ 0.'),
            }),
          )
          .describe('Only the Variants you are answering for. Send [] to publish as stored.'),
      },
    },
    withToolErrors(async ({ merchantToken, productId, title, description, variants }) => {
      await requireMerchant(deps.db, deps.merchantId, merchantToken, 'confirm_product');
      const stored = await findConfirmationProduct(deps.db, deps.merchantId, productId);
      if (stored === null) {
        throw new ValidationError('PRODUCT_NOT_FOUND', `no product ${productId} for this merchant`);
      }
      // The status guard is `confirmProduct`'s, not ours: it lives in the
      // UPDATE's WHERE clause so two confirmations cannot both win.
      const submission = overlayConfirmation(stored, { title, description, variants });
      const confirmed = await confirmProduct(deps.db, deps.merchantId, productId, submission);
      return textResult({
        productId: confirmed.productId,
        status: confirmed.status,
        product: heldView(confirmed.product),
        nextStep:
          'Published — buyer agents can see and buy this Product now. ' +
          'Call list_my_products to see the whole live catalog.',
      });
    }),
  );

  server.registerTool(
    'list_my_products',
    {
      title: 'List my products',
      description:
        'What this store currently has live: every published Variant with its price in ' +
        'integer paise and its stock, grouped by Product. Held Products never appear here ' +
        '— use list_held_products for those.',
      inputSchema: { merchantToken: MERCHANT_TOKEN_ARG },
    },
    withToolErrors(async ({ merchantToken }) => {
      await requireMerchant(deps.db, deps.merchantId, merchantToken, 'list_my_products');
      const live = await listPublishedVariants(deps.db, deps.merchantId);
      const byProduct = new Map<string, { productId: string; title: string; variants: unknown[] }>();
      for (const variant of live) {
        const group = byProduct.get(variant.productId) ?? {
          productId: variant.productId,
          title: variant.productTitle,
          variants: [],
        };
        group.variants.push({
          variantId: variant.variantId,
          label: variant.label,
          pricePaise: variant.price.amountPaise,
          priceDisplay: variant.price.amountDisplay,
          stock: variant.stock,
        });
        byProduct.set(variant.productId, group);
      }
      return textResult({
        merchant: MERCHANT_NAME,
        note: 'All prices are integer paise. 49900 paise = ₹499.00.',
        products: [...byProduct.values()],
      });
    }),
  );

  // ---------------------------------------------------------------------------
  // The reads (S1.5). Three tools, deliberately not a web-UI parity set: a
  // merchant in chat asks "how is the shop doing", "what came in", "what
  // happened on that one". Every one of these is a pure read — no audit row, no
  // state change — because looking at your own ledger is not an event in it.
  // ---------------------------------------------------------------------------

  /** How many units on hand still counts as "about to run out". */
  const LOW_STOCK_THRESHOLD = 2;
  /** Recent Refusals quoted back as unmet demand — a taste, not the log. */
  const UNMET_DEMAND_SAMPLE = 5;
  const RECENT_ORDERS_LIMIT = 10;
  const RECENT_ORDERS_MAX = 50;

  server.registerTool(
    'store_summary',
    {
      title: 'Store summary',
      description:
        'One answer to "how is the shop doing": how many Products are published and how ' +
        'many are held waiting on you, Orders by status, revenue in integer paise for ' +
        'today and in total, the published Variants at or below ' +
        `${LOW_STOCK_THRESHOLD} units, the ones already sold out, and how many buyer ` +
        'requests were refused (with the last few reasons — that is demand you did not ' +
        'meet). Revenue counts paid Orders only; a refunded Order shows in the status ' +
        'counts, not in the money.',
      inputSchema: { merchantToken: MERCHANT_TOKEN_ARG },
    },
    withToolErrors(async ({ merchantToken }) => {
      await requireMerchant(deps.db, deps.merchantId, merchantToken, 'store_summary');
      const [counts, live, refusals] = await Promise.all([
        readStoreCounts(deps.db, deps.merchantId),
        listPublishedVariants(deps.db, deps.merchantId),
        listRecentRefusals(deps.db, deps.merchantId, UNMET_DEMAND_SAMPLE),
      ]);

      const stockLine = (variant: (typeof live)[number]) => ({
        productId: variant.productId,
        productTitle: variant.productTitle,
        variantId: variant.variantId,
        label: variant.label,
        stock: variant.stock,
      });

      return textResult({
        merchant: MERCHANT_NAME,
        note: 'All money is integer paise. 49900 paise = ₹499.00.',
        catalog: {
          published: counts.productsByStatus.published ?? 0,
          heldForConfirmation: counts.productsByStatus.needs_confirmation ?? 0,
          draft: counts.productsByStatus.draft ?? 0,
        },
        ordersByStatus: counts.ordersByStatus,
        revenue: {
          todayPaise: counts.revenuePaiseToday,
          totalPaise: counts.revenuePaiseTotal,
        },
        lowStock: live.filter((v) => v.stock > 0 && v.stock <= LOW_STOCK_THRESHOLD).map(stockLine),
        soldOut: live.filter((v) => v.stock === 0).map(stockLine),
        unmetDemand: {
          refusals: refusals.length,
          note:
            `The ${UNMET_DEMAND_SAMPLE} most recent Refusals only — each one is a buyer ` +
            'agent that wanted something and was told no.',
          recentReasons: refusals.map((refusal) => ({
            seq: refusal.seq,
            type: refusal.type,
            summary: refusal.summary,
            code: refusal.payload['code'] ?? null,
            reason: refusal.payload['reason'] ?? null,
            occurredAt: refusal.occurredAt.toISOString(),
          })),
        },
      });
    }),
  );

  server.registerTool(
    'list_recent_orders',
    {
      title: 'List recent orders',
      description:
        'The store\'s most recent Orders, newest first: id, status, total in integer ' +
        'paise, what was bought (product title and Variant label per line), the ' +
        "Receipt's hash once one exists, and when the Order was created. Call get_order " +
        'with an id to see that Order\'s whole audit chain.',
      inputSchema: {
        merchantToken: MERCHANT_TOKEN_ARG,
        limit: z
          .number()
          .int()
          .min(1)
          .max(RECENT_ORDERS_MAX)
          .optional()
          .describe(`How many Orders to return, newest first. Default ${RECENT_ORDERS_LIMIT}.`),
      },
    },
    withToolErrors(async ({ merchantToken, limit }) => {
      await requireMerchant(deps.db, deps.merchantId, merchantToken, 'list_recent_orders');
      const recent = await listRecentOrders(deps.db, deps.merchantId, limit ?? RECENT_ORDERS_LIMIT);
      const rows = await Promise.all(
        recent.map(async (entry) => {
          const [items, receipt] = await Promise.all([
            listOrderItems(deps.db, entry.orderId),
            findOrderReceipt(deps.db, deps.merchantId, entry.orderId),
          ]);
          return {
            orderId: entry.orderId,
            status: entry.status,
            amountPaise: entry.total.amountPaise,
            amountDisplay: entry.total.amountDisplay,
            items: items.map((item) => ({
              productTitle: item.productTitle,
              label: item.label,
              quantity: item.quantity,
              unitPricePaise: item.unitPrice.amountPaise,
            })),
            // The Receipt is identified by the hash of its signed payload —
            // the same value a refund receipt links back to. The database row
            // id is an internal handle and is deliberately not published.
            receiptHash: receipt === null ? null : hashMandate(receipt.payload),
            createdAt: entry.createdAt,
          };
        }),
      );
      return textResult({
        merchant: MERCHANT_NAME,
        note: 'All money is integer paise. Newest first.',
        orders: rows,
      });
    }),
  );

  server.registerTool(
    'get_order',
    {
      title: 'Get order',
      description:
        'One Order in full, exactly as the public ledger viewer shows it: its status and ' +
        'money, and its audit chain replayed step by step — the Intent and Cart mandates ' +
        'that preceded it included. `complete` is false when a required step never ' +
        'happened, and `missingSteps` names which. An unknown id is an ORDER_NOT_FOUND ' +
        'validation error.',
      inputSchema: {
        merchantToken: MERCHANT_TOKEN_ARG,
        orderId: z.string().describe('An orderId from list_recent_orders.'),
      },
    },
    withToolErrors(async ({ merchantToken, orderId }) => {
      await requireMerchant(deps.db, deps.merchantId, merchantToken, 'get_order');
      const order = await findOrderById(deps.db, deps.merchantId, orderId);
      if (order === null) {
        throw new ValidationError('ORDER_NOT_FOUND', `no order ${orderId} for this merchant`);
      }
      // The purchase-scoped chain, not the order-scoped one: without it every
      // mandate-backed Order reads as missing its first two steps.
      const events = await readPurchaseAuditChain(deps.db, orderId);
      const missingSteps = missingHappyPathSteps(events);
      return textResult({
        merchant: MERCHANT_NAME,
        orderId,
        order: toOrderStatusView(order),
        items: (await listOrderItems(deps.db, orderId)).map((item) => ({
          productTitle: item.productTitle,
          label: item.label,
          quantity: item.quantity,
          unitPricePaise: item.unitPrice.amountPaise,
        })),
        complete: missingSteps.length === 0,
        missingSteps,
        anomalies: events.filter((event) => event.type === 'order.anomaly_detected').length,
        events: events.map(toWireEvent),
      });
    }),
  );

  // --- S1.3: the front door ------------------------------------------------
  // Registered last deliberately: this file is edited by more than one ticket,
  // and appending keeps the diffs disjoint.
  server.registerTool(
    'submit_catalog_item',
    {
      title: 'Submit catalog item',
      description:
        'Add a new Product to this store from the merchant\'s own post. Pass `caption` as ' +
        'the merchant\'s caption text VERBATIM — copied character for character, Hinglish, ' +
        'emoji, line breaks and price formatting intact. If the merchant shared a ' +
        'screenshot, pass the visible caption text you can read in it, still verbatim. ' +
        'NEVER pass a description of the photo, a summary, a translation, or fields you ' +
        'extracted yourself: the server does the extraction, and a paraphrase silently ' +
        'changes what it reads. If the merchant has a public link to the photo, pass it as ' +
        '`imageUrl` (http(s), an image, under 4 MiB); alternatively pass the bytes as ' +
        '`imageBase64` with `imageMediaType`, but never both. The server extracts name, ' +
        'description, price and stock from the caption and publishes the Product only if ' +
        'every one of them is confidently stated; anything the caption did not state is ' +
        'HELD rather than invented, and the result names the holds — ask the merchant for ' +
        'those values and call confirm_product. EVERY call creates a NEW Product, so call ' +
        'this once per drop and never to correct one you already submitted.',
      inputSchema: {
        merchantToken: MERCHANT_TOKEN_ARG,
        caption: z
          .string()
          .describe(
            "The merchant's caption, VERBATIM — never your description of the photo.",
          ),
        imageUrl: z
          .string()
          .optional()
          .describe('A public http(s) link to the photo. Omit if there is none.'),
        imageBase64: z
          .string()
          .optional()
          .describe('The photo bytes, base64. Needs imageMediaType. Never together with imageUrl.'),
        imageMediaType: z.string().optional().describe('e.g. image/jpeg. With imageBase64 only.'),
        sourceId: z
          .string()
          .optional()
          .describe("The merchant's own label for this drop, e.g. \"sept-raat-tee\". Optional."),
      },
    },
    withToolErrors(
      async ({ merchantToken, caption, imageUrl, imageBase64, imageMediaType, sourceId }) => {
        await requireMerchant(deps.db, deps.merchantId, merchantToken, 'submit_catalog_item');
        if (deps.extractionModel === undefined) {
          return errorResult(
            'EXTRACTION_NOT_CONFIGURED',
            'This deployment has no extraction model configured, so captions cannot be read. ' +
              'The operator sets the extraction key and redeploys; nothing the merchant can do ' +
              'from chat fixes it. Products already in the catalog are unaffected.',
          );
        }

        let submitted;
        try {
          submitted = await submitCatalogItem(
            deps.db,
            deps.merchantId,
            deps.extractionModel,
            { caption, imageUrl, imageBase64, imageMediaType, sourceId },
            deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl },
          );
        } catch (error) {
          // The model failing is neither policy nor malformed input: it is the
          // server unable to do a thing it was willing to do, so it gets the
          // third wire shape rather than being dressed up as a Refusal.
          if (error instanceof ExtractionError) {
            const { retryAfterSeconds } = error;
            return errorResult(
              'EXTRACTION_FAILED',
              error.message +
                (retryAfterSeconds === undefined
                  ? ''
                  : ` Retry in ${String(retryAfterSeconds)} seconds.`),
            );
          }
          throw error;
        }

        const held = submitted.status === 'needs_confirmation';
        return textResult({
          productId: submitted.productId,
          sourceId: submitted.sourceId,
          status: submitted.status,
          title: submitted.title,
          holds: submitted.holds,
          nextStep: held
            ? 'Held: ask the merchant for each field named in holds — do not guess or default ' +
              'any of them — then call confirm_product with productId ' +
              `${submitted.productId}.`
            : 'Published — buyer agents can see and buy this Product now.',
        });
      },
    ),
  );

  return server;
}

/** One audit event as the merchant face spells it — the `/audit*` wire shape. */
function toWireEvent(event: AuditChainEntry): WireAuditEvent {
  return {
    seq: event.seq,
    type: event.type,
    summary: event.summary,
    occurredAt: event.occurredAt.toISOString(),
    payload: event.payload,
  };
}

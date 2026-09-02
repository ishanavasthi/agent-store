import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MERCHANT_NAME } from '../config.js';
import type { StorefrontDeps } from '../deps.js';
import { listPublishedVariants } from '../domain/catalog.js';
import {
  confirmProduct,
  findConfirmationProduct,
  listProductsNeedingConfirmation,
  type ConfirmationProductView,
  type ConfirmationSubmission,
  type ConfirmationVariantSubmission,
} from '../domain/confirmation.js';
import { requireMerchant } from '../domain/merchants.js';
import { ValidationError } from '../domain/refusal.js';
import { textResult, withToolErrors } from './toolResults.js';

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
        `immediately for buyer agents.`,
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

  return server;
}

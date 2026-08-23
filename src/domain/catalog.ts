import { and, asc, eq } from 'drizzle-orm';
import type { Executor } from '../db/client.js';
import { products, variants } from '../db/schema.js';
import { moneyView, paise, type MoneyView } from './money.js';

/**
 * Catalog reads. T1 has one published Product with one implicit default
 * Variant; M4's ingestion pipeline fills the same tables with the real
 * ~25–30-product demo catalog and nothing here changes.
 */

export interface VariantView {
  readonly variantId: string;
  readonly productId: string;
  readonly productTitle: string;
  readonly description: string | null;
  readonly label: string | null;
  readonly price: MoneyView;
  readonly stock: number;
}

interface VariantRowShape {
  variantId: string;
  productId: string;
  productTitle: string;
  description: string | null;
  label: string | null;
  pricePaise: number;
  stock: number;
}

function toView(row: VariantRowShape): VariantView {
  return {
    variantId: row.variantId,
    productId: row.productId,
    productTitle: row.productTitle,
    description: row.description,
    label: row.label,
    price: moneyView(paise(row.pricePaise)),
    stock: row.stock,
  };
}

const selection = {
  variantId: variants.id,
  productId: products.id,
  productTitle: products.title,
  description: products.description,
  label: variants.label,
  pricePaise: variants.pricePaise,
  stock: variants.stock,
};

/**
 * Every Variant an Agent may buy. Only `published` Products appear: a Product
 * held in `needs-confirmation` is invisible in whole, never field-by-field
 * (CONTEXT.md → Published).
 */
export async function listPublishedVariants(
  executor: Executor,
  merchantId: string,
): Promise<VariantView[]> {
  const rows = await executor
    .select(selection)
    .from(variants)
    .innerJoin(products, eq(variants.productId, products.id))
    .where(and(eq(products.merchantId, merchantId), eq(products.status, 'published')))
    .orderBy(asc(products.title), asc(variants.label), asc(variants.id));
  return rows.map(toView);
}

export async function findPublishedVariant(
  executor: Executor,
  merchantId: string,
  variantId: string,
): Promise<VariantView | null> {
  const rows = await executor
    .select(selection)
    .from(variants)
    .innerJoin(products, eq(variants.productId, products.id))
    .where(
      and(
        eq(variants.id, variantId),
        eq(products.merchantId, merchantId),
        eq(products.status, 'published'),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toView(row);
}

/**
 * The Variant a `checkout` call with no explicit variant means. T1's demo
 * merchant has exactly one, which is what makes the walking skeleton a single
 * tool call. `listPublishedVariants` orders deterministically, so "the first
 * one" is stable rather than whatever the planner happened to return.
 */
export async function defaultPublishedVariant(
  executor: Executor,
  merchantId: string,
): Promise<VariantView | null> {
  const all = await listPublishedVariants(executor, merchantId);
  return all[0] ?? null;
}

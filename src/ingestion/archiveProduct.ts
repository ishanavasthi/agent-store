import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { products } from '../db/schema.js';

/**
 * Take a Product back out of the catalog by setting its status to `draft`
 * (plan D3).
 *
 *   npm run catalog:archive -- prd_…
 *
 * A maintenance script rather than a merchant tool, on purpose. Removal is the
 * one catalog operation that is not recoverable from chat by saying the
 * opposite thing, and a buyer-visible catalog that an LLM can empty on a
 * misread instruction is a worse failure than a fluffed take living one extra
 * minute. `draft` rather than DELETE for the same reason the confirmation path
 * never deletes: the Product, its extraction record and any Order that already
 * references it stay intact and auditable — it simply stops being buyable,
 * because every buyer-facing query filters on `published`.
 */
export async function archiveProduct(
  db: Database,
  merchantId: string,
  productId: string,
): Promise<boolean> {
  const updated = await db
    .update(products)
    .set({ status: 'draft' })
    .where(and(eq(products.id, productId), eq(products.merchantId, merchantId)))
    .returning({ id: products.id });
  return updated.length > 0;
}

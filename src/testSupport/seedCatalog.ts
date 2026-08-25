import type { Database } from '../db/client.js';
import { merchants, products, variants } from '../db/schema.js';

/**
 * The one-merchant, one-product, one-variant catalog the integration suites
 * buy against. Shared so every suite cites the same ids and the same
 * ₹1,299.00 price — a fixture drift between suites would change what their
 * assertions mean, not just where they live.
 */

export const MERCHANT_ID = 'mrc_test_merchant';

export async function seedCatalog(db: Database, stock: number): Promise<void> {
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

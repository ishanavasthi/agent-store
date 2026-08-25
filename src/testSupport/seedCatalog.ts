import type { Database } from '../db/client.js';
import { ensureMerchantSigningKey } from '../domain/merchants.js';
import { merchants, products, variants } from '../db/schema.js';

/**
 * The one-merchant catalog the integration suites buy against. Shared so every
 * suite cites the same ids and the same prices — a fixture drift between
 * suites would change what their assertions mean, not just where they live.
 *
 * Two published products since T4, so multi-item Cart mandates are testable:
 * the ₹1,299.00 tee (the original walking-skeleton item, still the default
 * Variant — "Oversized Tee" sorts before "Trucker Cap") and a ₹499.00 cap.
 * The merchant signing key is minted here too, exactly as the real seed does
 * (`src/db/seed.ts`): T4's Cart mandates and Receipts cannot be signed
 * without it.
 */

export const MERCHANT_ID = 'mrc_test_merchant';

export async function seedCatalog(db: Database, stock: number): Promise<void> {
  await db.insert(merchants).values({ id: MERCHANT_ID, name: 'Test Merchant' });
  await ensureMerchantSigningKey(db, MERCHANT_ID);
  await db.insert(products).values([
    {
      id: 'prd_test_tee',
      merchantId: MERCHANT_ID,
      title: 'Oversized Tee',
      status: 'published',
    },
    {
      id: 'prd_test_cap',
      merchantId: MERCHANT_ID,
      title: 'Trucker Cap',
      status: 'published',
    },
  ]);
  await db.insert(variants).values([
    {
      id: 'var_test_tee_default',
      productId: 'prd_test_tee',
      label: null,
      isDefault: true,
      pricePaise: 129900,
      currency: 'INR',
      stock,
    },
    {
      id: 'var_test_cap_default',
      productId: 'prd_test_cap',
      label: null,
      isDefault: true,
      pricePaise: 49900,
      currency: 'INR',
      stock,
    },
  ]);
}

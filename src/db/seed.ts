import { MERCHANT_ID, MERCHANT_NAME, loadConfig } from '../config.js';
import { ensureMerchantSigningKey } from '../domain/merchants.js';
import { createDatabase } from './client.js';
import { merchants, products, variants } from './schema.js';

/**
 * The T1 walking-skeleton catalog: the demo streetwear merchant, one published
 * Product, one *implicit default* Variant.
 *
 * "Implicit default" is the CONTEXT.md rule made concrete — this tee has no
 * stated size or colour, so it gets one Variant row with a null `label` and
 * `isDefault = true`. Checkout therefore never has to branch on "does this
 * product have variants?", and M4's ingestion pipeline will create the same
 * shape for every caption that never mentioned sizes.
 *
 * Ids are fixed rather than generated so re-running this is a no-op and so the
 * demo script can hardcode a variantId. Money is integer paise: ₹1,299.00.
 */

const PRODUCT_ID = 'prd_t1_oversized_tee';
const VARIANT_ID = 'var_t1_oversized_tee_default';

async function seed(): Promise<void> {
  const config = loadConfig();
  const { db, close } = createDatabase(config.databaseUrl);

  try {
    await db
      .insert(merchants)
      .values({ id: MERCHANT_ID, name: MERCHANT_NAME })
      .onConflictDoNothing();

    // Idempotent like everything above: an existing merchant keeps its key —
    // re-seeding must never rotate it under previously issued signatures.
    const signingKey = await ensureMerchantSigningKey(db, MERCHANT_ID);

    await db
      .insert(products)
      .values({
        id: PRODUCT_ID,
        merchantId: MERCHANT_ID,
        title: 'Oversized Heavyweight Tee — "Sabr" Print',
        description:
          '240 GSM cotton, boxy fit, hand-screened Urdu calligraphy across the back. ' +
          'Pre-shrunk, garment dyed.',
        status: 'published',
      })
      .onConflictDoNothing();

    await db
      .insert(variants)
      .values({
        id: VARIANT_ID,
        productId: PRODUCT_ID,
        label: null,
        isDefault: true,
        pricePaise: 129900,
        currency: 'INR',
        stock: 25,
      })
      .onConflictDoNothing();

    console.log(`[seed] merchant ${MERCHANT_ID}`);
    console.log(`[seed] merchant signing key ${signingKey.publicKey.slice(0, 16)}… (Ed25519)`);
    console.log(`[seed] product  ${PRODUCT_ID} (published)`);
    console.log(`[seed] variant  ${VARIANT_ID} — 129900 paise, stock 25`);
  } finally {
    await close();
  }
}

seed().catch((error: unknown) => {
  console.error('[seed] failed', error);
  process.exit(1);
});

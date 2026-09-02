import { MERCHANT_ID } from '../config.js';
import { createDatabase } from '../db/client.js';
import { archiveProduct } from './archiveProduct.js';

/**
 * Take a mis-submitted Product out of the catalog (plan D3):
 *
 *   npm run catalog:archive -- prd_9f3c…
 *
 * Reads `DATABASE_URL` directly, like `runIngestDemo.ts`: catalog maintenance
 * has no business demanding Razorpay credentials.
 */
async function run(): Promise<void> {
  const productId = process.argv[2]?.trim() ?? '';
  if (productId === '') {
    throw new Error('Usage: npm run catalog:archive -- <productId>');
  }
  const databaseUrl = process.env['DATABASE_URL']?.trim() ?? '';
  if (databaseUrl === '') throw new Error('Missing DATABASE_URL. See .env.example.');

  const { db, close } = createDatabase(databaseUrl);
  try {
    const archived = await archiveProduct(db, MERCHANT_ID, productId);
    if (!archived) throw new Error(`no product ${productId} for merchant ${MERCHANT_ID}`);
    console.log(`[catalog:archive] ${productId} → draft; buyers no longer see it.`);
  } finally {
    await close();
  }
}

run().catch((error: unknown) => {
  console.error('[catalog:archive] failed', error);
  process.exit(1);
});

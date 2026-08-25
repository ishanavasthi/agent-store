import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { merchants } from '../db/schema.js';
import { generateSigningKeypair } from './keys.js';

/**
 * The Merchant's signing key (CONTEXT.md → Merchant: "a first-class entity
 * owning a catalog and a signing key"). T4 signs Cart mandates and Receipts
 * with it; T3 only makes sure it exists.
 *
 * Minted idempotently at seed time, which is provisioning like the seed's own
 * catalog inserts — not an audited domain transition (the seed precedent:
 * `src/db/seed.ts` writes no audit events either). The merchant's identity
 * stays config (`MERCHANT_ID`), never routing.
 */

/**
 * Mint the merchant's Ed25519 keypair if it has none, and return the public
 * key either way. Idempotent and race-safe the house way: the "only if still
 * missing" guard lives in the SQL `WHERE`, not in an app-level read-then-write,
 * so re-running seed — or two deploys seeding concurrently — can never rotate
 * an existing key out from under previously issued signatures.
 */
export async function ensureMerchantSigningKey(
  db: Database,
  merchantId: string,
): Promise<{ publicKey: string }> {
  const candidate = generateSigningKeypair();
  await db
    .update(merchants)
    .set({
      signingPublicKey: candidate.publicKey,
      signingPrivateKey: candidate.privateKey,
    })
    .where(and(eq(merchants.id, merchantId), isNull(merchants.signingPrivateKey)));

  const [row] = await db
    .select({ signingPublicKey: merchants.signingPublicKey })
    .from(merchants)
    .where(eq(merchants.id, merchantId));
  if (row === undefined || row.signingPublicKey === null) {
    throw new Error(`No merchant row with id ${merchantId} to hold a signing key`);
  }
  return { publicKey: row.signingPublicKey };
}

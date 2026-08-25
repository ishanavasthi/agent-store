import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { merchants } from '../db/schema.js';
import { createTestDatabase, type TestDatabaseHandle } from '../testSupport/pgliteDatabase.js';
import { signMessage, verifyMessage } from './keys.js';
import { ensureMerchantSigningKey } from './merchants.js';

/**
 * The Merchant's signing key is minted exactly once (issue #4: "Merchant gets
 * its own signing key as a first-class entity"). Re-seeding must never rotate
 * it — a rotated key would orphan every signature already issued with the old
 * one.
 */

const MERCHANT_ID = 'mrc_test_merchant';

describe('ensureMerchantSigningKey', () => {
  let handle: TestDatabaseHandle;

  beforeEach(async () => {
    handle = await createTestDatabase();
    await handle.db.insert(merchants).values({ id: MERCHANT_ID, name: 'Test Merchant' });
  });

  afterEach(async () => {
    await handle.close();
  });

  it('mints a working Ed25519 keypair onto a merchant that has none', async () => {
    const { publicKey } = await ensureMerchantSigningKey(handle.db, MERCHANT_ID);

    const [row] = await handle.db
      .select()
      .from(merchants)
      .where(eq(merchants.id, MERCHANT_ID));
    expect(row!.signingPublicKey).toBe(publicKey);
    expect(row!.signingPrivateKey).not.toBeNull();

    const signature = signMessage(row!.signingPrivateKey!, 'receipt-to-be');
    expect(verifyMessage(publicKey, 'receipt-to-be', signature)).toBe(true);
  });

  it('is idempotent: a second run keeps the existing key', async () => {
    const first = await ensureMerchantSigningKey(handle.db, MERCHANT_ID);
    const second = await ensureMerchantSigningKey(handle.db, MERCHANT_ID);
    expect(second.publicKey).toBe(first.publicKey);
  });

  it('throws when the merchant row does not exist, rather than minting into the void', async () => {
    await expect(ensureMerchantSigningKey(handle.db, 'mrc_nobody')).rejects.toThrow(
      /No merchant row/,
    );
  });
});

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditEvents, merchants } from '../db/schema.js';
import { createTestDatabase, type TestDatabaseHandle } from '../testSupport/pgliteDatabase.js';
import { signMessage, verifyMessage } from './keys.js';
import { ensureMerchantSigningKey, ensureMerchantToken, requireMerchant } from './merchants.js';
import { Refusal } from './refusal.js';

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

/**
 * The Merchant token (S1.1, issue #37) is the mirror of the Agent token: minted
 * once, never rotated, and the only thing that identifies a Merchant on the
 * merchant MCP face. The `MERCHANT_TOKEN` env value exists so a redeploy keeps
 * a token a connector was already configured with.
 */

describe('ensureMerchantToken', () => {
  let handle: TestDatabaseHandle;

  beforeEach(async () => {
    handle = await createTestDatabase();
    await handle.db.insert(merchants).values({ id: MERCHANT_ID, name: 'Test Merchant' });
  });

  afterEach(async () => {
    await handle.close();
  });

  it('mints a prefixed token when the merchant has none, and reports it as newly minted', async () => {
    const first = await ensureMerchantToken(handle.db, MERCHANT_ID);

    expect(first.token).toMatch(/^mrc_tok_[A-Za-z0-9_-]+$/);
    expect(first.minted).toBe(true);

    const [row] = await handle.db.select().from(merchants).where(eq(merchants.id, MERCHANT_ID));
    expect(row!.token).toBe(first.token);
  });

  it('never rotates: a second seed keeps the first token and reports nothing minted', async () => {
    const first = await ensureMerchantToken(handle.db, MERCHANT_ID);
    const second = await ensureMerchantToken(handle.db, MERCHANT_ID);

    expect(second.token).toBe(first.token);
    expect(second.minted).toBe(false);
  });

  it('adopts an env-provided token idempotently', async () => {
    const preferred = 'mrc_tok_from_the_environment';

    const first = await ensureMerchantToken(handle.db, MERCHANT_ID, preferred);
    const second = await ensureMerchantToken(handle.db, MERCHANT_ID, preferred);

    expect(first).toEqual({ token: preferred, minted: true });
    expect(second).toEqual({ token: preferred, minted: false });
  });

  it('does not rotate an already-minted token when the environment later names a different one', async () => {
    const minted = await ensureMerchantToken(handle.db, MERCHANT_ID);
    const later = await ensureMerchantToken(handle.db, MERCHANT_ID, 'mrc_tok_a_different_one');

    expect(later.token).toBe(minted.token);
    expect(later.minted).toBe(false);
  });

  it('throws when the merchant row does not exist, rather than minting into the void', async () => {
    await expect(ensureMerchantToken(handle.db, 'mrc_nobody')).rejects.toThrow(/No merchant row/);
  });
});

describe('requireMerchant', () => {
  let handle: TestDatabaseHandle;
  let token: string;

  beforeEach(async () => {
    handle = await createTestDatabase();
    await handle.db.insert(merchants).values({ id: MERCHANT_ID, name: 'Test Merchant' });
    token = (await ensureMerchantToken(handle.db, MERCHANT_ID)).token;
  });

  afterEach(async () => {
    await handle.close();
  });

  async function auditEventCount(): Promise<number> {
    const rows = await handle.db.select({ seq: auditEvents.seq }).from(auditEvents);
    return rows.length;
  }

  it('returns the Merchant row for the right token', async () => {
    const merchant = await requireMerchant(handle.db, MERCHANT_ID, token, 'list_held_products');

    expect(merchant.id).toBe(MERCHANT_ID);
    expect(merchant.token).toBe(token);
  });

  it('refuses UNKNOWN_MERCHANT_TOKEN for a forged token', async () => {
    const refusal = await requireMerchant(
      handle.db,
      MERCHANT_ID,
      'mrc_tok_forged',
      'list_held_products',
    ).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(Refusal);
    expect((refusal as Refusal).toPayload()).toEqual({
      code: 'UNKNOWN_MERCHANT_TOKEN',
      reason: expect.stringContaining('merchantToken'),
      recoverable: true,
    });
  });

  it('refuses UNKNOWN_MERCHANT_TOKEN when no token is presented at all', async () => {
    const refusal = await requireMerchant(
      handle.db,
      MERCHANT_ID,
      undefined,
      'list_held_products',
    ).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(Refusal);
    expect((refusal as Refusal).code).toBe('UNKNOWN_MERCHANT_TOKEN');
    expect((refusal as Refusal).recoverable).toBe(true);
  });

  it('refuses a token belonging to a different merchant', async () => {
    await handle.db.insert(merchants).values({ id: 'mrc_other', name: 'Other Merchant' });
    const other = await ensureMerchantToken(handle.db, 'mrc_other');

    await expect(
      requireMerchant(handle.db, MERCHANT_ID, other.token, 'list_held_products'),
    ).rejects.toBeInstanceOf(Refusal);
  });

  it('writes no audit event — the audit log is the money ledger (ADR-0003)', async () => {
    await requireMerchant(handle.db, MERCHANT_ID, token, 'list_held_products');
    await requireMerchant(handle.db, MERCHANT_ID, 'mrc_tok_forged', 'list_held_products').catch(
      () => undefined,
    );
    await requireMerchant(handle.db, MERCHANT_ID, undefined, 'list_held_products').catch(
      () => undefined,
    );

    expect(await auditEventCount()).toBe(0);
  });
});

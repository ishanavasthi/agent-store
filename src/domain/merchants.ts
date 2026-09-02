import { randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { merchants, type MerchantRow } from '../db/schema.js';
import { generateSigningKeypair } from './keys.js';
import { Refusal } from './refusal.js';

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

// ---------------------------------------------------------------------------
// The Merchant token (S1.1) — how a Merchant identifies itself on its own MCP
// face, the mirror of the Agent token on the buyer face.
// ---------------------------------------------------------------------------

const MERCHANT_TOKEN_PREFIX = 'mrc_tok_';

/**
 * 256-bit bearer token, shaped exactly like `newAgentToken`: prefixed
 * (`mrc_tok_` vs the Merchant id's `mrc_`) so a token pasted into a log or a
 * prompt is visually recognizable, and never mistaken for a merchant id — or
 * for an Agent's `agt_tok_`.
 */
export function newMerchantToken(): string {
  return `${MERCHANT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/**
 * Give the Merchant a token if it has none, and return it either way.
 *
 * Idempotent and race-safe the same way `ensureMerchantSigningKey` is: the
 * "only if still missing" guard lives in the SQL `WHERE`, not in an app-level
 * read-then-write, so re-seeding — or two deploys seeding concurrently — can
 * never rotate a token a connector is already configured with.
 *
 * `preferred` is the deployment's `MERCHANT_TOKEN`: it wins over *minting a
 * random one*, which is what keeps a token stable across redeploys of a fresh
 * database. It does not rotate an existing token — an env value set after a
 * token was already minted is ignored, because "never rotates" is the stronger
 * rule (DECISIONS 2026-09-03).
 *
 * `minted` says whether THIS call was the one that wrote the token, which is
 * how the seed knows to print it exactly once.
 */
export async function ensureMerchantToken(
  db: Database,
  merchantId: string,
  preferred?: string,
): Promise<{ token: string; minted: boolean }> {
  const fromEnv = preferred?.trim() ?? '';
  const candidate = fromEnv === '' ? newMerchantToken() : fromEnv;

  const written = await db
    .update(merchants)
    .set({ token: candidate })
    .where(and(eq(merchants.id, merchantId), isNull(merchants.token)))
    .returning({ token: merchants.token });

  const [row] = await db
    .select({ token: merchants.token })
    .from(merchants)
    .where(eq(merchants.id, merchantId));
  if (row === undefined || row.token === null) {
    throw new Error(`No merchant row with id ${merchantId} to hold a token`);
  }
  return { token: row.token, minted: written.length > 0 };
}

/**
 * The merchant token gate. Resolves a presented token to this deployment's
 * Merchant row, or refuses with `UNKNOWN_MERCHANT_TOKEN`.
 *
 * No audit event is written — deliberately, and unlike `requireRegisteredAgent`
 * on the buyer face. The audit log is the money ledger the rule-auditor reads
 * (ADR-0003), and the merchant face never moves money; catalog-side seams write
 * none either (the `confirmation.ts` precedent). Recoverable: the operator can
 * read the right token off the deployment and present it.
 *
 * The presented token is never echoed back in the reason — an *almost*-valid
 * token is still a secret-shaped string.
 */
export async function requireMerchant(
  db: Database,
  merchantId: string,
  merchantToken: string | undefined,
  tool: string,
): Promise<MerchantRow> {
  const presented = merchantToken?.trim() ?? '';
  if (presented !== '') {
    // Plain equality via the unique index, not timingSafeEqual: recovering a
    // 256-bit random token through a timing oracle is not a practical attack
    // (the `requireRegisteredAgent` note applies verbatim).
    const [row] = await db
      .select()
      .from(merchants)
      .where(and(eq(merchants.token, presented), eq(merchants.id, merchantId)))
      .limit(1);
    if (row !== undefined) return row;
  }

  throw new Refusal({
    code: 'UNKNOWN_MERCHANT_TOKEN',
    reason:
      presented === ''
        ? `${tool} requires a merchantToken. Present the store's token (MERCHANT_TOKEN) and retry.`
        : `merchantToken matches no Merchant of this store. Present the right one and retry.`,
    recoverable: true,
  });
}

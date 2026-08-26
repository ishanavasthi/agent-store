import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  cartMandates,
  intentMandates,
  merchants,
  type AgentRow,
  type CartMandateRow,
  type IntentMandateRow,
} from '../db/schema.js';
import { appendAuditEvent } from './auditLog.js';
import { findPublishedVariant } from './catalog.js';
import { newId } from './ids.js';
import type { SigningKeypair } from './keys.js';
import {
  computeCartTotal,
  computePriceHash,
  hashMandate,
  signMandate,
  verifyMandateSignature,
  type CartItem,
  type CartMandatePayload,
  type IntentMandatePayload,
} from './mandates.js';
import { moneyView, paise, type MoneyView, type Paise } from './money.js';
import { Refusal, ValidationError } from './refusal.js';

/**
 * The first two steps of the mandate chain — `declare_intent` and `create_cart`
 * (CONTEXT.md → Intent mandate / Cart mandate; DECISIONS.md 2026-08-26 "the
 * mandate chain is the only purchase path").
 *
 * Signing follows the split custody model (DECISIONS 2026-08-22 "Split key
 * custody"; ADR-0004). For a custodial Agent the server holds the private key
 * and signs on its behalf; for a client-custody Agent (`privateKey` NULL) the
 * Agent composes `createdAt` and signs the exact canonical payload itself, and
 * the server verifies that signature against the registered public key before
 * storing anything — it never signs on such an Agent's behalf. The merchant
 * key signs the merchant's side of the Cart either way. Every payload and
 * signature is returned to the buyer, so an external verifier holding only
 * the public keys can check everything — custody hides nothing.
 *
 * ADR-0002: `create_cart` is one-shot. It stores the immutable signed Cart
 * mandate and touches nothing else — no draft state, no invalidation of
 * earlier carts, no TTL. ADR-0003: each mandate row commits in the same
 * transaction as its audit event.
 */

/** A Budget that is not a positive integer paise amount is malformed input. */
export function budgetPaiseFromInput(value: number): Paise {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError(
      'INVALID_BUDGET',
      `Budget must be a positive integer number of paise (e.g. 500000 = ₹5,000.00), got: ${String(value)}`,
    );
  }
  return paise(value);
}

/**
 * A client-minted mandate timestamp must at least parse as a date: it is part
 * of the signed bytes, and a garbage string stored as `createdAt` would be a
 * landmine in every later reading of the mandate. Malformed input, so a
 * validation error — the signature over it is judged separately.
 */
export function createdAtFromInput(value: string): string {
  if (Number.isNaN(Date.parse(value))) {
    throw new ValidationError(
      'INVALID_CREATED_AT',
      `createdAt must be an ISO-8601 timestamp (e.g. ${new Date().toISOString()}), got: ${value}`,
    );
  }
  return value;
}

/**
 * One signing step, resolved against the Agent's custody (ADR-0004): either
 * the server signs with the custodial private key, or the client already did —
 * with its minted `createdAt` and detached signature validated present and
 * well-formed. Arguments that contradict the custody are malformed requests —
 * `CUSTODY_MISMATCH`, a validation error — in *both* directions: a custodial
 * Agent supplying a signature is a confused client that must not be silently
 * "corrected" by server signing.
 */
export type SigningMode =
  | { readonly custody: 'custodial'; readonly privateKey: string }
  | { readonly custody: 'client'; readonly createdAt: string; readonly signature: string };

export function resolveSigningMode(
  agent: AgentRow,
  tool: string,
  supplied: { readonly createdAt?: string | undefined; readonly signature?: string | undefined },
): SigningMode {
  if (agent.privateKey !== null) {
    if (supplied.createdAt !== undefined || supplied.signature !== undefined) {
      throw new ValidationError(
        'CUSTODY_MISMATCH',
        `${tool}: this Agent is custodial — the server composes and signs its mandates; ` +
          'omit the signature arguments. To sign locally, register a new Agent with your own publicKey.',
      );
    }
    return { custody: 'custodial', privateKey: agent.privateKey };
  }
  if (supplied.createdAt === undefined || supplied.signature === undefined) {
    throw new ValidationError(
      'CUSTODY_MISMATCH',
      `${tool}: this Agent holds its key client-side, so the server cannot sign for it — ` +
        'mint createdAt yourself and supply your signature over the canonical payload.',
    );
  }
  return {
    custody: 'client',
    createdAt: createdAtFromInput(supplied.createdAt),
    signature: supplied.signature,
  };
}

/**
 * A locally signed mandate whose signature does not verify is the trust layer's
 * no — policy, before money moves, so a Refusal (`INVALID_MANDATE`), audited
 * first as `mandate.refused` in its own transaction (the `agent.refused`
 * precedent: orderId null — no Order exists), then thrown. Nothing is stored.
 */
async function refuseUnverifiedMandate(
  db: Database,
  agent: AgentRow,
  tool: string,
  reason: string,
): Promise<never> {
  const refusal = new Refusal({ code: 'INVALID_MANDATE', reason, recoverable: false });
  await db.transaction(async (tx) => {
    await appendAuditEvent(tx, {
      type: 'mandate.refused',
      merchantId: agent.merchantId,
      orderId: null,
      payload: {
        code: refusal.code,
        reason: refusal.reason,
        recoverable: refusal.recoverable,
        tool,
        agentId: agent.id,
      },
    });
  });
  throw refusal;
}

export interface DeclareIntentInput {
  /** Free-text description of what the buyer wants. */
  readonly want: string;
  /** Per-Intent spend ceiling, integer paise (Budget — never "limit"/"quota"). */
  readonly budgetPaise: number;
  /** Client custody only (ADR-0004): the `createdAt` the Agent put in the payload it signed. */
  readonly createdAt?: string | undefined;
  /** Client custody only: the Agent's detached signature over the canonical payload. */
  readonly signature?: string | undefined;
}

export interface DeclareIntentResult {
  readonly intentHash: string;
  readonly payload: IntentMandatePayload;
  /** The Agent's detached signature over `canonicalJson(payload)`. */
  readonly signature: string;
  readonly budget: MoneyView;
}

export async function declareIntent(
  db: Database,
  agent: AgentRow,
  input: DeclareIntentInput,
): Promise<DeclareIntentResult> {
  const budget = budgetPaiseFromInput(input.budgetPaise);
  const want = input.want.trim();
  if (want === '') {
    throw new ValidationError(
      'INVALID_WANT',
      'want must be a non-empty description of what the buyer intends to purchase',
    );
  }

  const signing = resolveSigningMode(agent, 'declare_intent', {
    createdAt: input.createdAt,
    signature: input.signature,
  });

  const payload: IntentMandatePayload = {
    agentId: agent.id,
    merchantId: agent.merchantId,
    want,
    budgetPaise: budget,
    // Part of the signed bytes: two identical wants are two distinct Intents.
    // Client custody: the client minted it, and the server recomposes the
    // payload from the same fields — so what is verified and stored is
    // byte-for-byte what the client claims to have signed.
    createdAt: signing.custody === 'client' ? signing.createdAt : new Date().toISOString(),
  };
  const intentHash = hashMandate(payload);
  const signature =
    signing.custody === 'custodial' ? signMandate(signing.privateKey, payload) : signing.signature;
  if (signing.custody === 'client' && !verifyMandateSignature(agent.publicKey, payload, signature)) {
    await refuseUnverifiedMandate(
      db,
      agent,
      'declare_intent',
      'Intent mandate signature does not verify against this Agent’s registered public key. ' +
        'Sign exactly canonicalJson({agentId, merchantId, want, budgetPaise, createdAt}) with the ' +
        'key you registered, then declare a fresh Intent.',
    );
  }

  // Row + audit event in one transaction (ADR-0003). `consumedByOrderId` stays
  // NULL in T4 — T5's INTENT_CONSUMED writes it under a SQL guard.
  await db.transaction(async (tx) => {
    await tx.insert(intentMandates).values({
      id: newId('intentMandate'),
      agentId: agent.id,
      merchantId: agent.merchantId,
      payload,
      hash: intentHash,
      budgetPaise: budget,
      agentSignature: signature,
    });
    await appendAuditEvent(tx, {
      type: 'mandate.intent_declared',
      merchantId: agent.merchantId,
      orderId: null,
      payload: { agentId: agent.id, intentHash, want, budgetPaise: budget },
    });
  });

  return { intentHash, payload, signature, budget: moneyView(budget) };
}

export interface CreateCartInput {
  /** The `intentHash` returned by declare_intent — the chain's root link. */
  readonly intentHash: string;
  readonly items: ReadonlyArray<{ readonly variantId: string; readonly quantity: number }>;
}

/** One priced line as it will appear in the signed Cart mandate. */
export interface CartLineView {
  readonly variantId: string;
  readonly productTitle: string;
  readonly label: string | null;
  readonly quantity: number;
  readonly unitPrice: MoneyView;
}

export interface CreateCartResult {
  readonly cartHash: string;
  readonly payload: CartMandatePayload;
  /**
   * Null for a client-custody Agent (ADR-0004): the server never signs on its
   * behalf, so the Agent signs `canonicalJson(payload)` locally and supplies
   * that signature to submit_payment as `cartSignature`.
   */
  readonly agentSignature: string | null;
  readonly merchantSignature: string;
  readonly total: MoneyView;
  readonly items: readonly CartLineView[];
}

/**
 * Resolve a mandate row by hash, scoped to this Agent. One shape for both
 * mandate kinds: another Agent's mandate is as unusable as a nonexistent one,
 * and the two answer identically so a hash probe cannot map other buyers'
 * mandates. A bad reference is a validation error, never a Refusal.
 */
function requireOwnMandate<Row extends { readonly agentId: string }>(
  agent: AgentRow,
  row: Row | undefined,
  code: 'INTENT_NOT_FOUND' | 'CART_NOT_FOUND',
  message: string,
): Row {
  if (row === undefined || row.agentId !== agent.id) {
    throw new ValidationError(code, message);
  }
  return row;
}

/** Resolve a stored Intent mandate for this Agent, or reject the reference. */
export async function requireIntentMandate(
  db: Database,
  agent: AgentRow,
  intentHash: string,
): Promise<IntentMandateRow> {
  const [row] = await db
    .select()
    .from(intentMandates)
    .where(and(eq(intentMandates.hash, intentHash), eq(intentMandates.merchantId, agent.merchantId)))
    .limit(1);
  return requireOwnMandate(
    agent,
    row,
    'INTENT_NOT_FOUND',
    `No Intent mandate of yours with hash ${intentHash}. Call declare_intent first and pass back the intentHash it returns.`,
  );
}

/** Resolve a stored Cart mandate for this Agent, or reject the reference. */
export async function requireCartMandate(
  db: Database,
  agent: AgentRow,
  cartHash: string,
): Promise<CartMandateRow> {
  const [row] = await db
    .select()
    .from(cartMandates)
    .where(and(eq(cartMandates.hash, cartHash), eq(cartMandates.merchantId, agent.merchantId)))
    .limit(1);
  return requireOwnMandate(
    agent,
    row,
    'CART_NOT_FOUND',
    `No Cart mandate of yours with hash ${cartHash}. Call create_cart first and pass back the cartHash it returns.`,
  );
}

/**
 * The merchant's signing keypair, or a loud failure. The key is provisioned at
 * seed time (`ensureMerchantSigningKey`); a merchant without one cannot sign
 * Cart mandates or Receipts, and limping past that would ship an unverifiable
 * chain — so this throws a plain server error, never a Refusal.
 */
export async function requireMerchantSigningKey(
  db: Database,
  merchantId: string,
): Promise<SigningKeypair> {
  const [row] = await db
    .select({
      publicKey: merchants.signingPublicKey,
      privateKey: merchants.signingPrivateKey,
    })
    .from(merchants)
    .where(eq(merchants.id, merchantId))
    .limit(1);
  if (row === undefined || row.publicKey === null || row.privateKey === null) {
    throw new Error(
      `Merchant ${merchantId} has no signing key; run the seed (ensureMerchantSigningKey) before selling`,
    );
  }
  return { publicKey: row.publicKey, privateKey: row.privateKey };
}

export async function createCart(
  db: Database,
  agent: AgentRow,
  input: CreateCartInput,
): Promise<CreateCartResult> {
  const intent = await requireIntentMandate(db, agent, input.intentHash);

  if (input.items.length === 0) {
    throw new ValidationError('INVALID_CART_ITEMS', 'A cart needs at least one item');
  }
  const seen = new Set<string>();
  for (const item of input.items) {
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) {
      throw new ValidationError(
        'INVALID_QUANTITY',
        `Quantity for ${item.variantId} must be a positive integer, got: ${String(item.quantity)}`,
      );
    }
    if (seen.has(item.variantId)) {
      throw new ValidationError(
        'INVALID_CART_ITEMS',
        `Variant ${item.variantId} appears twice; combine the quantities into one line`,
      );
    }
    seen.add(item.variantId);
  }

  // Pin each Variant's *current* published price into the mandate. Stock is
  // deliberately not checked here — carting reserves nothing (DECISIONS
  // 2026-08-23 "No stock reservations"); submit_payment checks it.
  const items: CartItem[] = [];
  const lines: CartLineView[] = [];
  for (const item of input.items) {
    const variant = await findPublishedVariant(db, agent.merchantId, item.variantId);
    if (variant === null) {
      throw new ValidationError(
        'VARIANT_NOT_FOUND',
        `No published Variant with id ${item.variantId}`,
      );
    }
    items.push({
      variantId: variant.variantId,
      quantity: item.quantity,
      unitPricePaise: variant.price.amountPaise,
    });
    lines.push({
      variantId: variant.variantId,
      productTitle: variant.productTitle,
      label: variant.label,
      quantity: item.quantity,
      unitPrice: variant.price,
    });
  }

  const totalPaise = computeCartTotal(items);
  const merchantKey = await requireMerchantSigningKey(db, agent.merchantId);

  const payload: CartMandatePayload = {
    agentId: agent.id,
    merchantId: agent.merchantId,
    intentHash: intent.hash,
    items,
    totalPaise,
    priceHash: computePriceHash(items),
    createdAt: new Date().toISOString(),
  };
  const cartHash = hashMandate(payload);
  // Both-sides-signed for a custodial Agent: its custodial key authorizes the
  // purchase shape here. A client-custody Agent cannot sign a payload it has
  // not yet seen — the server pins prices and mints createdAt — so its
  // signature is deferred: `create_cart` stays one-shot, the row stores NULL,
  // and the Agent's signature over this exact payload arrives with
  // submit_payment, where the trust gate verifies it before money can move
  // (ADR-0004). The merchant key commits the merchant to these prices now,
  // in both models.
  const agentSignature = agent.privateKey === null ? null : signMandate(agent.privateKey, payload);
  const merchantSignature = signMandate(merchantKey.privateKey, payload);

  await db.transaction(async (tx) => {
    await tx.insert(cartMandates).values({
      id: newId('cartMandate'),
      agentId: agent.id,
      merchantId: agent.merchantId,
      intentHash: intent.hash,
      payload,
      hash: cartHash,
      totalAmountPaise: totalPaise,
      priceHash: payload.priceHash,
      agentSignature,
      merchantSignature,
    });
    await appendAuditEvent(tx, {
      type: 'mandate.cart_created',
      merchantId: agent.merchantId,
      orderId: null,
      payload: {
        agentId: agent.id,
        cartHash,
        intentHash: intent.hash,
        items: items.map((item) => ({ ...item })),
        totalAmountPaise: totalPaise,
        priceHash: payload.priceHash,
      },
    });
  });

  return {
    cartHash,
    payload,
    agentSignature,
    merchantSignature,
    total: moneyView(totalPaise),
    items: lines,
  };
}

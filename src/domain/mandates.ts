import { canonicalJson, sha256Hex } from './canonicalJson.js';
import { signMessage, verifyMessage } from './keys.js';
import { multiplyPaise, paise, type Paise } from './money.js';

/**
 * Mandate payloads and the hash chain that binds them (CONTEXT.md → Intent
 * mandate / Cart mandate / Payment mandate / Receipt; DECISIONS.md 2026-08-23
 * "Mandate chain").
 *
 * Everything here is pure: composition, hashing, signing, and verification of
 * in-memory payloads. Persistence, catalog lookups, and policy (which Refusal
 * a failed check becomes) belong to the checkout/payment flow, not here.
 *
 * Signatures are detached: they travel and are stored ALONGSIDE a payload,
 * never inside it — a payload containing its own signature could not be
 * signed. What is signed is exactly `canonicalJson(payload)`, with the wire
 * encoding fixed in `keys.ts` (base64 DER keys, base64 signatures).
 *
 * `createdAt`/`issuedAt` are ISO-8601 strings and part of the signed bytes:
 * two otherwise identical Intents hash differently, so a mandate hash names
 * one act of intent, not a template (t4-design-inputs §9).
 */

/** Root of the chain: the Agent's signed want plus its Budget. */
export interface IntentMandatePayload {
  readonly agentId: string;
  readonly merchantId: string;
  /** Free-text description of what the buyer wants. */
  readonly want: string;
  /** Budget for this Intent — `OVER_BUDGET` is enforced against this (T5). */
  readonly budgetPaise: Paise;
  readonly createdAt: string;
}

/** One line of a Cart mandate: a Variant at its pinned unit price. */
export interface CartItem {
  readonly variantId: string;
  readonly quantity: number;
  readonly unitPricePaise: Paise;
}

/** Immutable both-sides-signed snapshot of items + total, bound to its Intent. */
export interface CartMandatePayload {
  readonly agentId: string;
  readonly merchantId: string;
  /** `hashMandate` of the Intent this Cart consumes when paid. */
  readonly intentHash: string;
  readonly items: readonly CartItem[];
  readonly totalPaise: Paise;
  /** `computePriceHash` of the items — repinned against the live catalog at payment time. */
  readonly priceHash: string;
  readonly createdAt: string;
}

/** Agent-signed authorization to pay one Cart mandate, named by hash. */
export interface PaymentMandatePayload {
  readonly agentId: string;
  readonly merchantId: string;
  /** `hashMandate` of the Cart mandate being paid. */
  readonly cartHash: string;
  /** Buyer-minted, scoped Agent×Merchant (`IDEMPOTENCY_REUSE` is T5). */
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

/** Merchant-signed proof that one verified chain became one paid Order. */
export interface ReceiptPayload {
  readonly orderId: string;
  readonly intentHash: string;
  readonly cartHash: string;
  readonly paymentHash: string;
  readonly amountPaise: Paise;
  readonly gatewayPaymentId: string;
  readonly issuedAt: string;
}

export type MandatePayload = IntentMandatePayload | CartMandatePayload | PaymentMandatePayload;

/**
 * Parse a payload read back from a mandate/receipt row's jsonb column. These
 * rows are written only by this codebase, so a shape mismatch means the store
 * was mutated out-of-band — fail loudly rather than limp. Parsing is also
 * where `Paise` fields regain their brand: a bare `as`-cast would smuggle
 * unchecked numbers into money arithmetic (engineering-log "Green tests,
 * broken type check" is the trap that rule guards against).
 */
function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Stored ${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function asString(record: Record<string, unknown>, key: string, what: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new Error(`Stored ${what} has a non-string ${key}`);
  }
  return value;
}

function asPaise(record: Record<string, unknown>, key: string, what: string): Paise {
  const value = record[key];
  if (typeof value !== 'number') {
    throw new Error(`Stored ${what} has a non-number ${key}`);
  }
  return paise(value);
}

function asQuantity(record: Record<string, unknown>, key: string, what: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Stored ${what} has an unsound ${key}`);
  }
  return value;
}

export function parseIntentMandatePayload(value: unknown): IntentMandatePayload {
  const what = 'Intent mandate payload';
  const record = asRecord(value, what);
  return {
    agentId: asString(record, 'agentId', what),
    merchantId: asString(record, 'merchantId', what),
    want: asString(record, 'want', what),
    budgetPaise: asPaise(record, 'budgetPaise', what),
    createdAt: asString(record, 'createdAt', what),
  };
}

export function parseCartMandatePayload(value: unknown): CartMandatePayload {
  const what = 'Cart mandate payload';
  const record = asRecord(value, what);
  const rawItems = record['items'];
  if (!Array.isArray(rawItems)) {
    throw new Error(`Stored ${what} has no items array`);
  }
  const items: CartItem[] = rawItems.map((rawItem) => {
    const item = asRecord(rawItem, `${what} item`);
    return {
      variantId: asString(item, 'variantId', what),
      quantity: asQuantity(item, 'quantity', what),
      unitPricePaise: asPaise(item, 'unitPricePaise', what),
    };
  });
  return {
    agentId: asString(record, 'agentId', what),
    merchantId: asString(record, 'merchantId', what),
    intentHash: asString(record, 'intentHash', what),
    items,
    totalPaise: asPaise(record, 'totalPaise', what),
    priceHash: asString(record, 'priceHash', what),
    createdAt: asString(record, 'createdAt', what),
  };
}

export function parsePaymentMandatePayload(value: unknown): PaymentMandatePayload {
  const what = 'Payment mandate payload';
  const record = asRecord(value, what);
  return {
    agentId: asString(record, 'agentId', what),
    merchantId: asString(record, 'merchantId', what),
    cartHash: asString(record, 'cartHash', what),
    idempotencyKey: asString(record, 'idempotencyKey', what),
    createdAt: asString(record, 'createdAt', what),
  };
}

export function parseReceiptPayload(value: unknown): ReceiptPayload {
  const what = 'Receipt payload';
  const record = asRecord(value, what);
  return {
    orderId: asString(record, 'orderId', what),
    intentHash: asString(record, 'intentHash', what),
    cartHash: asString(record, 'cartHash', what),
    paymentHash: asString(record, 'paymentHash', what),
    amountPaise: asPaise(record, 'amountPaise', what),
    gatewayPaymentId: asString(record, 'gatewayPaymentId', what),
    issuedAt: asString(record, 'issuedAt', what),
  };
}

/** The hash that names a mandate (or Receipt) everywhere else in the chain. */
export function hashMandate(payload: MandatePayload | ReceiptPayload): string {
  return sha256Hex(canonicalJson(payload));
}

/**
 * Pin of the prices (not quantities, not amounts) a Cart was built against:
 * hash of `[{variantId, unitPricePaise}, ...]` sorted by `variantId` (UTF-16
 * code unit order), canonicalized. Payment-time verification recomputes this
 * from the live catalog; a mismatch is the `PRICE_CHANGED` refusal (ticket C).
 */
export function computePriceHash(
  items: ReadonlyArray<Pick<CartItem, 'variantId' | 'unitPricePaise'>>,
): string {
  const pinned = [...items]
    .sort((a, b) => (a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0))
    .map((item) => ({ variantId: item.variantId, unitPricePaise: item.unitPricePaise }));
  return sha256Hex(canonicalJson(pinned));
}

/** Sum of `quantity × unitPricePaise` in integer paise — throws on anything unsound. */
export function computeCartTotal(items: readonly CartItem[]): Paise {
  return items.reduce<Paise>(
    (total, item) => paise(total + multiplyPaise(item.unitPricePaise, item.quantity)),
    paise(0),
  );
}

/** Sign a payload's canonical JSON. Returns the detached base64 signature. */
export function signMandate(privateKey: string, payload: MandatePayload | ReceiptPayload): string {
  return signMessage(privateKey, canonicalJson(payload));
}

/** Verify a detached signature against a payload's canonical JSON. */
export function verifyMandateSignature(
  publicKey: string,
  payload: MandatePayload | ReceiptPayload,
  signature: string,
): boolean {
  return verifyMessage(publicKey, canonicalJson(payload), signature);
}

export type ChainFailure =
  | 'intent_hash_mismatch'
  | 'cart_hash_mismatch'
  | 'price_hash_mismatch'
  | 'total_mismatch';

export interface ChainVerification {
  readonly ok: boolean;
  readonly failures: readonly ChainFailure[];
}

/**
 * Check the Intent → Cart → Payment bindings and the Cart's own arithmetic:
 * `cart.intentHash` names the Intent, `payment.cartHash` names the Cart, the
 * Cart's `priceHash` matches its items, and `totalPaise` is the items' sum.
 *
 * Deliberately NOT checked here: signatures (call `verifyMandateSignature`
 * per party) and the live catalog price (recompute `computePriceHash` from
 * current prices — `PRICE_CHANGED` is the caller's refusal to make).
 */
export function verifyMandateChain(
  intent: IntentMandatePayload,
  cart: CartMandatePayload,
  payment: PaymentMandatePayload,
): ChainVerification {
  const failures: ChainFailure[] = [];
  if (cart.intentHash !== hashMandate(intent)) {
    failures.push('intent_hash_mismatch');
  }
  if (payment.cartHash !== hashMandate(cart)) {
    failures.push('cart_hash_mismatch');
  }
  if (cart.priceHash !== computePriceHash(cart.items)) {
    failures.push('price_hash_mismatch');
  }
  // Items that cannot produce a sound integer total (MoneyError) certainly do
  // not match the stated total, so that folds into the same failure.
  let computedTotal: Paise | null = null;
  try {
    computedTotal = computeCartTotal(cart.items);
  } catch {
    computedTotal = null;
  }
  if (computedTotal === null || computedTotal !== cart.totalPaise) {
    failures.push('total_mismatch');
  }
  return { ok: failures.length === 0, failures };
}

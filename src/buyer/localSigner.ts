import { generateSigningKeypair, type SigningKeypair } from '../domain/keys.js';
import {
  hashMandate,
  signMandate,
  type CartMandatePayload,
  type IntentMandatePayload,
  type PaymentMandatePayload,
} from '../domain/mandates.js';
import { paise } from '../domain/money.js';

/**
 * The client-side half of split custody (ADR-0004): an Ed25519 private key
 * held in memory, never exported, never sent anywhere. The server sees only
 * `publicKey` — registration stores it with `private_key` NULL, and every
 * mandate this buyer submits is signed here.
 *
 * Everything cryptographic is *imported* from the domain — `canonicalJson`
 * (via `signMandate`/`hashMandate`) and the wire encoding fixed in
 * `src/domain/keys.ts` — because the whole point of local signing is that both
 * sides agree byte-for-byte on what was signed. Reimplementing the encoding
 * here would create a second copy that could drift.
 */

/** A payload plus the two derived artifacts the protocol names it by. */
export interface SignedMandate<Payload> {
  readonly payload: Payload;
  /** `hashMandate(payload)` — the name every chain link and tool argument uses. */
  readonly hash: string;
  /** Detached base64 Ed25519 signature over `canonicalJson(payload)`. */
  readonly signature: string;
}

export interface ComposeIntentInput {
  readonly agentId: string;
  readonly merchantId: string;
  readonly want: string;
  /** Integer paise — validated and branded via `paise()`. */
  readonly budgetPaise: number;
  /** Defaults to now. Part of the signed bytes. */
  readonly createdAt?: string;
}

export interface ComposePaymentInput {
  readonly agentId: string;
  readonly merchantId: string;
  /** The `cartHash` of the Cart mandate being paid. */
  readonly cartHash: string;
  readonly idempotencyKey: string;
  /** Defaults to now. Part of the signed bytes. */
  readonly createdAt?: string;
}

export class LocalSigner {
  /** Private class field: unreachable from outside, absent from JSON.stringify. */
  readonly #privateKey: string;
  /** Base64 SPKI DER — what `register_agent` is given. */
  readonly publicKey: string;

  constructor(keypair: SigningKeypair = generateSigningKeypair()) {
    this.#privateKey = keypair.privateKey;
    this.publicKey = keypair.publicKey;
  }

  /** Compose and sign the Intent mandate — the buyer mints `createdAt` itself. */
  composeIntent(input: ComposeIntentInput): SignedMandate<IntentMandatePayload> {
    const payload: IntentMandatePayload = {
      agentId: input.agentId,
      merchantId: input.merchantId,
      want: input.want,
      budgetPaise: paise(input.budgetPaise),
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    return this.#sign(payload);
  }

  /**
   * Sign a Cart mandate payload the server composed and returned — the
   * deferred agent-side Cart signature `submit_payment` requires. The caller
   * passes the *parsed* payload (`parseCartMandatePayload` over the wire
   * body), so what is signed is exactly what the server will verify.
   */
  signCart(payload: CartMandatePayload): SignedMandate<CartMandatePayload> {
    return this.#sign(payload);
  }

  /** Compose and sign the Payment mandate over a known `cartHash`. */
  composePayment(input: ComposePaymentInput): SignedMandate<PaymentMandatePayload> {
    const payload: PaymentMandatePayload = {
      agentId: input.agentId,
      merchantId: input.merchantId,
      cartHash: input.cartHash,
      idempotencyKey: input.idempotencyKey,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    return this.#sign(payload);
  }

  #sign<Payload extends IntentMandatePayload | CartMandatePayload | PaymentMandatePayload>(
    payload: Payload,
  ): SignedMandate<Payload> {
    return {
      payload,
      hash: hashMandate(payload),
      signature: signMandate(this.#privateKey, payload),
    };
  }
}

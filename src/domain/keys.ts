import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';

/**
 * Ed25519 signing keys, via `node:crypto` only (DECISIONS.md 2026-08-26 —
 * PLAN §5 named `@noble/ed25519`, but Node ships Ed25519 natively and a new
 * dependency would prove nothing extra).
 *
 * **Wire encoding — fixed here for everything that signs or verifies.** Keys
 * are base64-encoded DER: SPKI for public keys, PKCS8 for private keys.
 * Signatures are base64. Agent keys, the Merchant signing key, and the T4
 * mandate chain / Receipt verification (including the eval buyer's client-side
 * signer, per DECISIONS "Split key custody") all use exactly this encoding, so
 * a key read from a database row round-trips with no format negotiation.
 */

export interface SigningKeypair {
  /** SPKI DER, base64. */
  readonly publicKey: string;
  /** PKCS8 DER, base64. */
  readonly privateKey: string;
}

export function generateSigningKeypair(): SigningKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

/** Sign a UTF-8 message with a stored private key. Returns the base64 signature. */
export function signMessage(privateKey: string, message: string): string {
  const key = createPrivateKey({
    key: Buffer.from(privateKey, 'base64'),
    type: 'pkcs8',
    format: 'der',
  });
  // Algorithm is `null` on purpose: Ed25519 hashes internally, and node:crypto
  // throws if a digest name is passed.
  return sign(null, Buffer.from(message, 'utf8'), key).toString('base64');
}

/** Verify a base64 signature over a UTF-8 message against a stored public key. */
export function verifyMessage(publicKey: string, message: string, signature: string): boolean {
  const key = createPublicKey({
    key: Buffer.from(publicKey, 'base64'),
    type: 'spki',
    format: 'der',
  });
  return verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signature, 'base64'));
}

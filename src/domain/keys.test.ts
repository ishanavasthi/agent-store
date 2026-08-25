import { describe, expect, it } from 'vitest';
import { generateSigningKeypair, signMessage, verifyMessage } from './keys.js';

describe('Ed25519 signing keys', () => {
  it('round-trips: a message signed with the private key verifies with the public key', () => {
    const keypair = generateSigningKeypair();
    const message = 'ord_abc: 129900 paise';
    const signature = signMessage(keypair.privateKey, message);
    expect(verifyMessage(keypair.publicKey, message, signature)).toBe(true);
  });

  it('rejects a tampered message', () => {
    // This is the property T4's mandate chain leans on: one changed paisa in
    // the signed text must break verification.
    const keypair = generateSigningKeypair();
    const signature = signMessage(keypair.privateKey, 'amountPaise:129900');
    expect(verifyMessage(keypair.publicKey, 'amountPaise:129901', signature)).toBe(false);
  });

  it("rejects a signature from a different Agent's key", () => {
    const signer = generateSigningKeypair();
    const other = generateSigningKeypair();
    const signature = signMessage(signer.privateKey, 'hello');
    expect(verifyMessage(other.publicKey, 'hello', signature)).toBe(false);
  });

  it('exports keys as base64 text that survives a database round-trip', () => {
    // Keys are stored in text columns; signing must work from the stored
    // string, not from a live KeyObject held in memory.
    const keypair = generateSigningKeypair();
    const stored = JSON.parse(JSON.stringify(keypair)) as typeof keypair;
    expect(stored.publicKey).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(stored.privateKey).toMatch(/^[A-Za-z0-9+/]+=*$/);
    const signature = signMessage(stored.privateKey, 'stored');
    expect(verifyMessage(stored.publicKey, 'stored', signature)).toBe(true);
  });

  it('mints a distinct keypair every time', () => {
    expect(generateSigningKeypair().publicKey).not.toBe(generateSigningKeypair().publicKey);
  });
});

import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '../domain/canonicalJson.js';
import { generateSigningKeypair, verifyMessage } from '../domain/keys.js';
import {
  hashMandate,
  parseCartMandatePayload,
  verifyMandateSignature,
} from '../domain/mandates.js';
import { LocalSigner } from './localSigner.js';

describe('LocalSigner', () => {
  it('composes and signs an Intent that verifies against its own public key', () => {
    const signer = new LocalSigner();
    const intent = signer.composeIntent({
      agentId: 'agt_local',
      merchantId: 'mrc_test',
      want: 'a tee',
      budgetPaise: 300000,
      createdAt: '2026-08-26T10:00:00.000Z',
    });

    expect(intent.payload).toEqual({
      agentId: 'agt_local',
      merchantId: 'mrc_test',
      want: 'a tee',
      budgetPaise: 300000,
      createdAt: '2026-08-26T10:00:00.000Z',
    });
    // The hash is the domain's hash over the domain's canonical bytes — the
    // signer imports both, so both sides name the mandate identically.
    expect(intent.hash).toBe(hashMandate(intent.payload));
    expect(intent.hash).toBe(sha256Hex(canonicalJson(intent.payload)));
    expect(verifyMandateSignature(signer.publicKey, intent.payload, intent.signature)).toBe(true);
    // And it is a real detached signature over exactly the canonical JSON.
    expect(verifyMessage(signer.publicKey, canonicalJson(intent.payload), intent.signature)).toBe(
      true,
    );
  });

  it('signs a server-composed Cart payload as parsed off the wire', () => {
    const signer = new LocalSigner();
    // What create_cart returns, as plain JSON — the signer's caller re-parses
    // it through the domain parser, so unsound payloads fail before signing.
    const wirePayload: unknown = JSON.parse(
      JSON.stringify({
        agentId: 'agt_local',
        merchantId: 'mrc_test',
        intentHash: 'a'.repeat(64),
        items: [{ variantId: 'var_x', quantity: 2, unitPricePaise: 129900 }],
        totalPaise: 259800,
        priceHash: 'b'.repeat(64),
        createdAt: '2026-08-26T10:00:01.000Z',
      }),
    );
    const cart = signer.signCart(parseCartMandatePayload(wirePayload));
    expect(cart.hash).toBe(hashMandate(cart.payload));
    expect(verifyMandateSignature(signer.publicKey, cart.payload, cart.signature)).toBe(true);
  });

  it('composes and signs a Payment mandate over a cartHash', () => {
    const signer = new LocalSigner();
    const payment = signer.composePayment({
      agentId: 'agt_local',
      merchantId: 'mrc_test',
      cartHash: 'c'.repeat(64),
      idempotencyKey: 'key-1',
    });
    expect(payment.payload.cartHash).toBe('c'.repeat(64));
    expect(Number.isNaN(Date.parse(payment.payload.createdAt))).toBe(false);
    expect(verifyMandateSignature(signer.publicKey, payment.payload, payment.signature)).toBe(true);
  });

  it('never exposes the private key — not as a property, not via JSON', () => {
    const keypair = generateSigningKeypair();
    const signer = new LocalSigner(keypair);
    expect(JSON.stringify(signer)).not.toContain(keypair.privateKey);
    expect(Object.values({ ...signer })).not.toContain(keypair.privateKey);
  });

  it("a different signer's signature does not verify — keys are not interchangeable", () => {
    const signer = new LocalSigner();
    const other = new LocalSigner();
    const intent = signer.composeIntent({
      agentId: 'agt_local',
      merchantId: 'mrc_test',
      want: 'a tee',
      budgetPaise: 300000,
    });
    expect(verifyMandateSignature(other.publicKey, intent.payload, intent.signature)).toBe(false);
  });
});

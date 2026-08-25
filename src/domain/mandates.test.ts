import { describe, expect, it } from 'vitest';
import { generateSigningKeypair } from './keys.js';
import { paise } from './money.js';
import {
  computeCartTotal,
  computePriceHash,
  hashMandate,
  signMandate,
  verifyMandateChain,
  verifyMandateSignature,
  type CartMandatePayload,
  type IntentMandatePayload,
  type MandatePayload,
  type PaymentMandatePayload,
  type ReceiptPayload,
} from './mandates.js';

// Timestamps are fixed so each chain is self-consistent, but no test asserts a
// hardcoded hash: production payloads carry real clocks, so what must hold are
// properties — equality, mismatch, round-trip — never exact hex.
function buildChain() {
  const items = [
    { variantId: 'var_test_tee_default', quantity: 2, unitPricePaise: paise(129900) },
    { variantId: 'var_test_mug', quantity: 1, unitPricePaise: paise(49900) },
  ] as const;
  const intent: IntentMandatePayload = {
    agentId: 'agt_test_agent',
    merchantId: 'mrc_test_merchant',
    want: 'two oversized tees and a mug',
    budgetPaise: paise(500000),
    createdAt: '2026-08-26T10:00:00.000Z',
  };
  const cart: CartMandatePayload = {
    agentId: 'agt_test_agent',
    merchantId: 'mrc_test_merchant',
    intentHash: hashMandate(intent),
    items,
    totalPaise: computeCartTotal(items),
    priceHash: computePriceHash(items),
    createdAt: '2026-08-26T10:00:01.000Z',
  };
  const payment: PaymentMandatePayload = {
    agentId: 'agt_test_agent',
    merchantId: 'mrc_test_merchant',
    cartHash: hashMandate(cart),
    idempotencyKey: 'b3b0c442-98fc-4c14-9afb-f4c8996fb924',
    createdAt: '2026-08-26T10:00:02.000Z',
  };
  return { items, intent, cart, payment };
}

function buildReceipt(): ReceiptPayload {
  const { intent, cart, payment } = buildChain();
  return {
    orderId: 'ord_test_1',
    intentHash: hashMandate(intent),
    cartHash: hashMandate(cart),
    paymentHash: hashMandate(payment),
    amountPaise: cart.totalPaise,
    gatewayPaymentId: 'pay_stub_1',
    issuedAt: '2026-08-26T10:05:00.000Z',
  };
}

/** Change one value just enough to be different, preserving its shape. */
function tweak(value: unknown): unknown {
  if (typeof value === 'string') {
    return `${value}x`;
  }
  if (typeof value === 'number') {
    return value + 1;
  }
  if (Array.isArray(value)) {
    const first = value[0] as { quantity: number };
    return [{ ...first, quantity: first.quantity + 1 }, ...value.slice(1)];
  }
  throw new Error(`No tweak for value of type ${typeof value}`);
}

describe('hashMandate', () => {
  it('is independent of property insertion order', () => {
    const { intent } = buildChain();
    const reordered: IntentMandatePayload = {
      createdAt: intent.createdAt,
      want: intent.want,
      budgetPaise: intent.budgetPaise,
      merchantId: intent.merchantId,
      agentId: intent.agentId,
    };
    expect(hashMandate(reordered)).toBe(hashMandate(intent));
  });

  it('changes when any single field of any mandate changes', () => {
    const { intent, cart, payment } = buildChain();
    for (const payload of [intent, cart, payment]) {
      const record = payload as unknown as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        const mutated = { ...record, [key]: tweak(record[key]) } as unknown as MandatePayload;
        expect(hashMandate(mutated), `field ${key} should be hash-bound`).not.toBe(
          hashMandate(payload),
        );
      }
    }
  });
});

describe('computePriceHash', () => {
  it('is independent of item order', () => {
    const { items } = buildChain();
    expect(computePriceHash([...items].reverse())).toBe(computePriceHash(items));
  });

  it('pins prices, not quantities', () => {
    const { items } = buildChain();
    const moreOfTheSame = items.map((item) => ({ ...item, quantity: item.quantity + 5 }));
    expect(computePriceHash(moreOfTheSame)).toBe(computePriceHash(items));
  });

  it('changes when any unit price changes by one paisa', () => {
    const { items } = buildChain();
    const [first, ...rest] = items;
    const repriced = [{ ...first, unitPricePaise: paise(first.unitPricePaise + 1) }, ...rest];
    expect(computePriceHash(repriced)).not.toBe(computePriceHash(items));
  });
});

describe('computeCartTotal', () => {
  it('sums quantity × unit price in integer paise', () => {
    const { items } = buildChain();
    // 2 × 129900 + 1 × 49900
    expect(computeCartTotal(items)).toBe(309700);
  });

  it('is zero for no items', () => {
    expect(computeCartTotal([])).toBe(0);
  });
});

describe('mandate signatures', () => {
  it('round-trips sign → verify for every payload shape', () => {
    const keypair = generateSigningKeypair();
    const { intent, cart, payment } = buildChain();
    const receipt = buildReceipt();
    for (const payload of [intent, cart, payment, receipt]) {
      const signature = signMandate(keypair.privateKey, payload);
      expect(verifyMandateSignature(keypair.publicKey, payload, signature)).toBe(true);
    }
  });

  it('verifies a reordered copy of the payload — signatures bind content, not key order', () => {
    const keypair = generateSigningKeypair();
    const { intent } = buildChain();
    const signature = signMandate(keypair.privateKey, intent);
    const reordered: IntentMandatePayload = {
      want: intent.want,
      merchantId: intent.merchantId,
      createdAt: intent.createdAt,
      budgetPaise: intent.budgetPaise,
      agentId: intent.agentId,
    };
    expect(verifyMandateSignature(keypair.publicKey, reordered, signature)).toBe(true);
  });

  it('rejects a payload tampered after signing', () => {
    const keypair = generateSigningKeypair();
    const { intent } = buildChain();
    const signature = signMandate(keypair.privateKey, intent);
    const tampered: IntentMandatePayload = {
      ...intent,
      budgetPaise: paise(intent.budgetPaise + 100),
    };
    expect(verifyMandateSignature(keypair.publicKey, tampered, signature)).toBe(false);
  });

  it("rejects another key's signature", () => {
    const signer = generateSigningKeypair();
    const other = generateSigningKeypair();
    const { payment } = buildChain();
    const signature = signMandate(signer.privateKey, payment);
    expect(verifyMandateSignature(other.publicKey, payment, signature)).toBe(false);
  });
});

describe('verifyMandateChain', () => {
  it('accepts an intact chain', () => {
    const { intent, cart, payment } = buildChain();
    expect(verifyMandateChain(intent, cart, payment)).toEqual({ ok: true, failures: [] });
  });

  it("detects a mutated Intent via the Cart's embedded hash", () => {
    const { intent, cart, payment } = buildChain();
    const inflated: IntentMandatePayload = { ...intent, budgetPaise: paise(9900000) };
    const result = verifyMandateChain(inflated, cart, payment);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['intent_hash_mismatch']);
  });

  it("detects a mutated Cart via the Payment's embedded hash", () => {
    const { intent, cart, payment } = buildChain();
    const redated: CartMandatePayload = { ...cart, createdAt: '2026-08-26T11:00:00.000Z' };
    const result = verifyMandateChain(intent, redated, payment);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['cart_hash_mismatch']);
  });

  it('detects a stated total that is not the sum of the items', () => {
    const { intent, cart } = buildChain();
    const padded: CartMandatePayload = { ...cart, totalPaise: paise(cart.totalPaise + 100) };
    // Rebind the Payment to the padded Cart so only the arithmetic is at fault.
    const payment: PaymentMandatePayload = {
      agentId: cart.agentId,
      merchantId: cart.merchantId,
      cartHash: hashMandate(padded),
      idempotencyKey: 'b3b0c442-98fc-4c14-9afb-f4c8996fb924',
      createdAt: '2026-08-26T10:00:02.000Z',
    };
    const result = verifyMandateChain(intent, padded, payment);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['total_mismatch']);
  });

  it('detects a priceHash that does not match the items', () => {
    const { intent, cart, items } = buildChain();
    const [first, ...rest] = items;
    const stale: CartMandatePayload = {
      ...cart,
      priceHash: computePriceHash([
        { ...first, unitPricePaise: paise(first.unitPricePaise + 1) },
        ...rest,
      ]),
    };
    const payment: PaymentMandatePayload = {
      agentId: cart.agentId,
      merchantId: cart.merchantId,
      cartHash: hashMandate(stale),
      idempotencyKey: 'b3b0c442-98fc-4c14-9afb-f4c8996fb924',
      createdAt: '2026-08-26T10:00:02.000Z',
    };
    const result = verifyMandateChain(intent, stale, payment);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['price_hash_mismatch']);
  });
});

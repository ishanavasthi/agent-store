import { describe, expect, it } from 'vitest';
import { GATEWAY_REFERENCE_MAX_LENGTH, newId, toGatewayReference } from './ids.js';

describe('newId', () => {
  it('prefixes by kind so a domain id is never mistaken for a gateway one', () => {
    // Razorpay's ids read `order_…` / `plink_…`; ours read `ord_…`.
    expect(newId('order')).toMatch(/^ord_[0-9a-f]{32}$/);
    expect(newId('product')).toMatch(/^prd_[0-9a-f]{32}$/);
    expect(newId('variant')).toMatch(/^var_[0-9a-f]{32}$/);
  });

  it('is unique across calls', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId('order')));
    expect(ids.size).toBe(500);
  });
});

describe('toGatewayReference', () => {
  it('passes an Order id through unchanged so a webhook can find it again', () => {
    const orderId = newId('order');
    expect(toGatewayReference(orderId)).toBe(orderId);
  });

  it('keeps generated Order ids inside Razorpay reference_id limits', () => {
    expect(newId('order').length).toBeLessThanOrEqual(GATEWAY_REFERENCE_MAX_LENGTH);
  });

  it('throws rather than silently truncating an over-long id', () => {
    expect(() => toGatewayReference('ord_'.padEnd(41, 'x'))).toThrow(/reference_id/);
  });
});

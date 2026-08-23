import { describe, expect, it } from 'vitest';
import {
  AUDIT_EVENT_SUMMARIES,
  AUDIT_EVENT_TYPES,
  missingHappyPathSteps,
  toAuditChain,
  type AuditEventRecord,
  type AuditEventType,
} from './auditEvents.js';

const AT = new Date('2026-08-24T10:00:00.000Z');

function event(seq: number, type: AuditEventType): AuditEventRecord {
  return { seq, type, orderId: 'ord_1', merchantId: 'mrc_1', occurredAt: AT, payload: {} };
}

describe('toAuditChain', () => {
  it('orders by seq, not by insertion order', () => {
    const chain = toAuditChain([
      event(3, 'gateway.payment_link_issued'),
      event(1, 'order.created'),
      event(2, 'gateway.order_created'),
    ]);
    expect(chain.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('orders by seq even when timestamps are identical', () => {
    // Two events written in one transaction (ADR-0003) share a commit time, so
    // sorting by `occurredAt` would leave their order to chance.
    const chain = toAuditChain([event(2, 'order.paid'), event(1, 'gateway.webhook_received')]);
    expect(chain.map((e) => e.type)).toEqual(['gateway.webhook_received', 'order.paid']);
  });

  it('does not mutate its input', () => {
    const input = [event(2, 'order.paid'), event(1, 'order.created')];
    toAuditChain(input);
    expect(input.map((e) => e.seq)).toEqual([2, 1]);
  });

  it('attaches a human-readable summary to every event', () => {
    const chain = toAuditChain(AUDIT_EVENT_TYPES.map((type, i) => event(i + 1, type)));
    for (const entry of chain) {
      expect(entry.summary).toBe(AUDIT_EVENT_SUMMARIES[entry.type]);
      expect(entry.summary.length).toBeGreaterThan(0);
    }
  });

  it('returns an empty chain for an order with no events', () => {
    expect(toAuditChain([])).toEqual([]);
  });
});

describe('missingHappyPathSteps', () => {
  it('reports every step for an empty chain', () => {
    expect(missingHappyPathSteps([])).toEqual([...AUDIT_EVENT_TYPES]);
  });

  it('reports nothing for a completed purchase', () => {
    const complete = AUDIT_EVENT_TYPES.map((type, i) => event(i + 1, type));
    expect(missingHappyPathSteps(complete)).toEqual([]);
  });

  it('names the steps still outstanding, in happy-path order', () => {
    const upToLink = [
      event(1, 'order.created'),
      event(2, 'gateway.order_created'),
      event(3, 'gateway.payment_link_issued'),
    ];
    expect(missingHappyPathSteps(upToLink)).toEqual([
      'gateway.webhook_received',
      'order.paid',
    ]);
  });

  it('tolerates redelivered webhooks', () => {
    // Razorpay sends both payment_link.paid and payment.captured, and redelivers
    // on any non-2xx, so duplicate `gateway.webhook_received` rows are normal.
    const withDuplicates = [
      event(1, 'order.created'),
      event(2, 'gateway.order_created'),
      event(3, 'gateway.payment_link_issued'),
      event(4, 'gateway.webhook_received'),
      event(5, 'order.paid'),
      event(6, 'gateway.webhook_received'),
    ];
    expect(missingHappyPathSteps(withDuplicates)).toEqual([]);
  });
});

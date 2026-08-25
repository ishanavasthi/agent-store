import { describe, expect, it } from 'vitest';
import {
  AUDIT_EVENT_SUMMARIES,
  AUDIT_EVENT_TYPES,
  REQUIRED_HAPPY_PATH,
  missingHappyPathSteps,
  namespaceGatewayEvent,
  toAuditChain,
  type AuditEventRecord,
  type AuditEventType,
} from './auditEvents.js';

const AT = new Date('2026-08-24T10:00:00.000Z');

function event(seq: number, type: AuditEventType): AuditEventRecord {
  return { seq, type, orderId: 'ord_1', merchantId: 'mrc_1', occurredAt: AT, payload: {} };
}

const COMPLETE = REQUIRED_HAPPY_PATH.map((type, i) => event(i + 1, type));

describe('toAuditChain', () => {
  it('orders by seq, not by insertion order', () => {
    const chain = toAuditChain([
      event(3, 'gateway.payment_link_issued'),
      event(1, 'order.created'),
      event(2, 'gateway.payment_link_attempted'),
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

  it('attaches a human-readable summary to every event type', () => {
    const chain = toAuditChain(AUDIT_EVENT_TYPES.map((type, i) => event(i + 1, type)));
    expect(chain).toHaveLength(AUDIT_EVENT_TYPES.length);
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
    expect(missingHappyPathSteps([])).toEqual([...REQUIRED_HAPPY_PATH]);
  });

  it('reports nothing for a completed purchase', () => {
    expect(missingHappyPathSteps(COMPLETE)).toEqual([]);
  });

  it('names the steps still outstanding, in happy-path order', () => {
    const upToLink = [
      event(1, 'mandate.intent_declared'),
      event(2, 'mandate.cart_created'),
      event(3, 'payment.verified'),
      event(4, 'order.created'),
      event(5, 'gateway.payment_link_attempted'),
      event(6, 'gateway.payment_link_issued'),
    ];
    expect(missingHappyPathSteps(upToLink)).toEqual([
      'gateway.webhook_received',
      'order.paid',
      'receipt.issued',
    ]);
  });

  it('does not require gateway.order_linked', () => {
    // Whether Razorpay's own order id reaches us depends on which webhook event
    // fired; requiring it would make a good purchase look incomplete.
    expect(REQUIRED_HAPPY_PATH).not.toContain('gateway.order_linked');
    expect(missingHappyPathSteps(COMPLETE)).toEqual([]);
  });

  it('tolerates redelivered webhooks', () => {
    // Razorpay sends both payment_link.paid and payment.captured, and redelivers
    // on any non-2xx, so duplicate `gateway.webhook_received` rows are normal.
    expect(
      missingHappyPathSteps([...COMPLETE, event(90, 'gateway.webhook_received')]),
    ).toEqual([]);
  });

  it('does not treat an anomaly as a completed purchase', () => {
    const anomalous = [
      event(1, 'mandate.intent_declared'),
      event(2, 'mandate.cart_created'),
      event(3, 'payment.verified'),
      event(4, 'order.created'),
      event(5, 'gateway.payment_link_attempted'),
      event(6, 'gateway.payment_link_issued'),
      event(7, 'gateway.webhook_received'),
      event(8, 'order.anomaly_detected'),
    ];
    expect(missingHappyPathSteps(anomalous)).toEqual(['order.paid', 'receipt.issued']);
  });
});

describe('namespaceGatewayEvent', () => {
  it('keeps a gateway event name distinct from our identically spelled one', () => {
    // Razorpay has an `order.paid` event; so do we. The rule-auditor must never
    // meet two meanings of one spelling.
    expect(namespaceGatewayEvent('razorpay', 'order.paid')).toBe('razorpay:order.paid');
    expect(AUDIT_EVENT_TYPES).toContain('order.paid');
    expect(AUDIT_EVENT_TYPES).not.toContain(
      namespaceGatewayEvent('razorpay', 'order.paid') as AuditEventType,
    );
  });

  it('namespaces the stub gateway distinctly too', () => {
    expect(namespaceGatewayEvent('stub', 'payment_link.paid')).toBe('stub:payment_link.paid');
  });
});

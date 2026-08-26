import { describe, expect, it } from 'vitest';
import { auditRules, type AuditableEvent, type ViolationCode } from './ruleAuditor.js';

/**
 * The auditor's credibility test (issue #16): an auditor that cannot fail
 * proves nothing, so every guarantee is fed a synthetic BAD log and must
 * catch the planted violation — plus a clean fabricated log it must pass.
 * (The integration suite additionally tampers a real exported log; here the
 * logs are hand-built so each violation is isolated and exact.)
 */

interface ChainOptions {
  readonly agentId?: string;
  readonly capPaise?: number;
  readonly budgetPaise?: number;
  readonly unitPricePaise?: number;
  readonly quantity?: number;
  readonly orderId?: string;
  readonly idempotencyKey?: string;
  readonly suffix?: string;
}

/** One complete, internally consistent purchase as the audit log records it. */
function purchaseChain(startSeq: number, options: ChainOptions = {}): AuditableEvent[] {
  const suffix = options.suffix ?? '1';
  const agentId = options.agentId ?? `agt_${suffix}`;
  const orderId = options.orderId ?? `ord_${suffix}`;
  const idempotencyKey = options.idempotencyKey ?? `key-${suffix}`;
  const unitPricePaise = options.unitPricePaise ?? 129900;
  const quantity = options.quantity ?? 1;
  const amountPaise = unitPricePaise * quantity;
  const intentHash = `intent_${suffix}`;
  const cartHash = `cart_${suffix}`;
  const paymentHash = `payment_${suffix}`;
  let seq = startSeq;
  return [
    {
      seq: seq++,
      type: 'agent.registered',
      orderId: null,
      payload: { agentId, capPaise: options.capPaise ?? 500000, custody: 'custodial' },
    },
    {
      seq: seq++,
      type: 'mandate.intent_declared',
      orderId: null,
      payload: { agentId, intentHash, want: 'a tee', budgetPaise: options.budgetPaise ?? 200000 },
    },
    {
      seq: seq++,
      type: 'mandate.cart_created',
      orderId: null,
      payload: {
        agentId,
        cartHash,
        intentHash,
        items: [{ variantId: 'var_tee', quantity, unitPricePaise }],
        totalAmountPaise: amountPaise,
        priceHash: `price_${suffix}`,
      },
    },
    {
      seq: seq++,
      type: 'payment.verified',
      orderId,
      payload: { agentId, intentHash, cartHash, paymentHash, amountPaise, idempotencyKey },
    },
    {
      seq: seq++,
      type: 'order.paid',
      orderId,
      payload: { gateway: 'stub', gatewayPaymentId: `pay_${suffix}`, amountPaise, currency: 'INR' },
    },
    {
      seq: seq++,
      type: 'receipt.issued',
      orderId,
      payload: {
        receiptHash: `receipt_${suffix}`,
        intentHash,
        cartHash,
        paymentHash,
        amountPaise,
        gatewayPaymentId: `pay_${suffix}`,
      },
    },
  ];
}

function codes(events: readonly AuditableEvent[]): ViolationCode[] {
  return auditRules(events).violations.map((violation) => violation.code);
}

describe('auditRules on a clean log', () => {
  it('passes a complete purchase with zero violations', () => {
    const report = auditRules(purchaseChain(1));
    expect(report.violations).toEqual([]);
    expect(report.chargesAudited).toBe(1);
    expect(report.agentsSeen).toBe(1);
  });

  it('passes a well-formed Refusal and counts it', () => {
    const report = auditRules([
      {
        seq: 1,
        type: 'payment.refused',
        orderId: null,
        payload: { code: 'OVER_BUDGET', reason: 'Cart total exceeds Budget', recoverable: true },
      },
    ]);
    expect(report.violations).toEqual([]);
    expect(report.refusalsAudited).toBe(1);
  });

  it('lets a refund free Cap headroom for a later charge', () => {
    // Two 129900 charges against a 150000 Cap — legal only because the first
    // was refunded in between. The auditor must replay in seq order.
    const first = purchaseChain(1, { suffix: 'a', agentId: 'agt_1', capPaise: 150000 });
    const refund: AuditableEvent = {
      seq: 100,
      type: 'order.refunded',
      orderId: 'ord_a',
      payload: { gateway: 'stub', amountPaise: 129900 },
    };
    const second = purchaseChain(101, {
      suffix: 'b',
      agentId: 'agt_1',
      capPaise: 150000,
    }).filter((event) => event.type !== 'agent.registered'); // same Agent, one registration
    expect(codes([...first, refund, ...second])).toEqual([]);
  });
});

describe('auditRules catches the planted violation', () => {
  it('assert 1: a charge above the registered Cap', () => {
    // Cap 100000, charge 129900 — the log itself convicts.
    expect(codes(purchaseChain(1, { capPaise: 100000 }))).toContain('CHARGE_ABOVE_CAP');
  });

  it('assert 1: cumulative charges breach the Cap even though each fits alone', () => {
    const first = purchaseChain(1, { suffix: 'a', agentId: 'agt_1', capPaise: 200000 });
    const second = purchaseChain(50, { suffix: 'b', agentId: 'agt_1', capPaise: 200000 }).filter(
      (event) => event.type !== 'agent.registered',
    );
    expect(codes([...first, ...second])).toContain('CHARGE_ABOVE_CAP');
  });

  it('assert 2: a charge with no payment.verified on the log', () => {
    const events = purchaseChain(1).filter((event) => event.type !== 'payment.verified');
    expect(codes(events)).toContain('CHARGE_WITHOUT_VERIFIED_CHAIN');
  });

  it('assert 2: a verified chain whose Cart mandate was never declared', () => {
    const events = purchaseChain(1).filter((event) => event.type !== 'mandate.cart_created');
    expect(codes(events)).toContain('CHARGE_WITHOUT_VERIFIED_CHAIN');
  });

  it('assert 2: a Cart total its logged line items do not add up to', () => {
    const events = purchaseChain(1).map((event) =>
      event.type === 'mandate.cart_created'
        ? {
            ...event,
            // The claimed total is 129900 but the items say 129900 × 2.
            payload: {
              ...event.payload,
              items: [{ variantId: 'var_tee', quantity: 2, unitPricePaise: 129900 }],
            },
          }
        : event,
    );
    expect(codes(events)).toContain('CHARGE_AMOUNT_INCONSISTENT');
  });

  it('assert 2: a charge above the Intent’s logged Budget', () => {
    expect(codes(purchaseChain(1, { budgetPaise: 100000 }))).toContain('CHARGE_ABOVE_BUDGET');
  });

  it('assert 2: a charge attributed to an Agent whose registration is not on the log', () => {
    const events = purchaseChain(1).filter((event) => event.type !== 'agent.registered');
    expect(codes(events)).toContain('CHARGE_WITHOUT_VERIFIED_CHAIN');
  });

  it('assert 3: two charges under one idempotency key', () => {
    const first = purchaseChain(1, { suffix: 'a', agentId: 'agt_1', idempotencyKey: 'key-reused' });
    const second = purchaseChain(50, {
      suffix: 'b',
      agentId: 'agt_1',
      idempotencyKey: 'key-reused',
    }).filter((event) => event.type !== 'agent.registered');
    expect(codes([...first, ...second])).toContain('DUPLICATE_CHARGE_FOR_IDEMPOTENCY_KEY');
  });

  it('assert 3: a charge verified with no idempotency key on the log', () => {
    const events = purchaseChain(1).map((event) =>
      event.type === 'payment.verified'
        ? { ...event, payload: { ...event.payload, idempotencyKey: undefined } }
        : event,
    );
    expect(codes(events)).toContain('CHARGE_WITHOUT_VERIFIED_CHAIN');
  });

  it('a second order.paid for one Order is a second charge', () => {
    const chain = purchaseChain(1);
    const paid = chain.find((event) => event.type === 'order.paid')!;
    expect(codes([...chain, { ...paid, seq: 99 }])).toContain('DUPLICATE_CHARGE_FOR_ORDER');
  });

  it('assert 4: a Refusal without a reason code', () => {
    expect(
      codes([
        {
          seq: 1,
          type: 'agent.refused',
          orderId: null,
          payload: { reason: 'no token', recoverable: true }, // code missing
        },
      ]),
    ).toContain('REFUSAL_WITHOUT_REASON_CODE');
    expect(
      codes([
        {
          seq: 1,
          type: 'mandate.refused',
          orderId: null,
          payload: { code: 'INVALID_MANDATE', reason: 'bad signature' }, // recoverable missing
        },
      ]),
    ).toContain('REFUSAL_WITHOUT_REASON_CODE');
  });

  it('a Receipt contradicting the verified chain it attests', () => {
    const events = purchaseChain(1).map((event) =>
      event.type === 'receipt.issued'
        ? { ...event, payload: { ...event.payload, amountPaise: 1 } }
        : event,
    );
    expect(codes(events)).toContain('CHARGE_AMOUNT_INCONSISTENT');
  });
});

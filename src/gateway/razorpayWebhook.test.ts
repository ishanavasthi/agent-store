import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  WebhookParseError,
  classifyRazorpayEvent,
  parseRazorpayWebhook,
  verifyRazorpaySignature,
} from './razorpayWebhook.js';

const SECRET = 'whsec_test_agent_store';

function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

describe('verifyRazorpaySignature', () => {
  const body = JSON.stringify({ event: 'payment_link.paid' });

  it('accepts a signature produced with the shared secret', () => {
    expect(verifyRazorpaySignature(body, sign(body), SECRET)).toBe(true);
  });

  it('rejects a signature made with a different secret', () => {
    expect(verifyRazorpaySignature(body, sign(body, 'wrong'), SECRET)).toBe(false);
  });

  it('rejects when a single byte of the body changed', () => {
    const signature = sign(body);
    expect(verifyRazorpaySignature(`${body} `, signature, SECRET)).toBe(false);
  });

  it('rejects a re-serialised body', () => {
    // Why the webhook route reads the raw text body rather than express.json():
    // reordering keys changes the bytes, and the HMAC with them.
    const raw = '{"event":"payment.captured","account_id":"acc_1"}';
    const reserialised = JSON.stringify(JSON.parse(raw));
    expect(verifyRazorpaySignature(raw, sign(raw), SECRET)).toBe(true);
    expect(verifyRazorpaySignature(reserialised, sign(raw), SECRET)).toBe(
      reserialised === raw,
    );
  });

  it('rejects an empty or short signature without throwing', () => {
    expect(verifyRazorpaySignature(body, '', SECRET)).toBe(false);
    expect(verifyRazorpaySignature(body, 'abc', SECRET)).toBe(false);
  });
});

describe('classifyRazorpayEvent', () => {
  it.each(['payment_link.paid', 'payment.captured', 'order.paid'])(
    'treats %s as success',
    (name) => {
      expect(classifyRazorpayEvent(name)).toBe('payment_succeeded');
    },
  );

  it('treats payment.failed as a failure', () => {
    expect(classifyRazorpayEvent('payment.failed')).toBe('payment_failed');
  });

  it('treats anything else as other', () => {
    expect(classifyRazorpayEvent('refund.processed')).toBe('other');
    expect(classifyRazorpayEvent('payment_link.cancelled')).toBe('other');
  });
});

describe('parseRazorpayWebhook', () => {
  const paymentLinkPaid = JSON.stringify({
    entity: 'event',
    event: 'payment_link.paid',
    payload: {
      payment_link: {
        entity: {
          id: 'plink_ExjpAUN3gVHrPJ',
          reference_id: 'ord_9f2c1e5b7a4d4c1e8f0a2b3c4d5e6f70',
          order_id: 'order_ExjpAUN3gVHrPQ',
          amount: 129900,
          status: 'paid',
          short_url: 'https://rzp.io/i/nxrHnLJ',
        },
      },
      payment: {
        entity: {
          id: 'pay_ExjpAUN3gVHrPR',
          order_id: 'order_ExjpAUN3gVHrPQ',
          amount: 129900,
          status: 'captured',
          notes: { orderId: 'ord_9f2c1e5b7a4d4c1e8f0a2b3c4d5e6f70' },
        },
      },
    },
  });

  it('does not throw MoneyError on a malformed amount', () => {
    // A signed-but-unparseable body must surface as WebhookParseError so the
    // route can answer 200/ignored. A MoneyError would escape as a 500 and
    // Razorpay would redeliver the same broken body forever.
    // NaN is absent on purpose: JSON.stringify turns it into `null`, so it can
    // never actually arrive over the wire — it reads as an absent amount.
    for (const bad of [49900.5, -1, '49900', true]) {
      const body = JSON.stringify({
        event: 'payment.captured',
        payload: { payment: { entity: { id: 'pay_1', amount: bad } } },
      });
      expect(() => parseRazorpayWebhook(body)).toThrow(WebhookParseError);
    }
  });

  it('treats an absent amount as null rather than an error', () => {
    const body = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_1', notes: { orderId: 'ord_a' } } } },
    });
    expect(parseRazorpayWebhook(body).amountPaise).toBeNull();
  });

  it('recovers the domain Order id from reference_id', () => {
    const event = parseRazorpayWebhook(paymentLinkPaid);
    expect(event.reference).toBe('ord_9f2c1e5b7a4d4c1e8f0a2b3c4d5e6f70');
    expect(event.kind).toBe('payment_succeeded');
    expect(event.rawEvent).toBe('payment_link.paid');
  });

  it('keeps gateway identifiers separate from the domain Order id', () => {
    const event = parseRazorpayWebhook(paymentLinkPaid);
    expect(event.gatewayOrderId).toBe('order_ExjpAUN3gVHrPQ');
    expect(event.gatewayPaymentId).toBe('pay_ExjpAUN3gVHrPR');
    expect(event.gatewayPaymentLinkId).toBe('plink_ExjpAUN3gVHrPJ');
    expect(event.amountPaise).toBe(129900);
  });

  it('falls back to notes.orderId when only a payment entity is present', () => {
    const paymentCaptured = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_1',
            order_id: 'order_1',
            amount: 49900,
            notes: { orderId: 'ord_abc', merchantId: 'mrc_x' },
          },
        },
      },
    });
    const event = parseRazorpayWebhook(paymentCaptured);
    expect(event.reference).toBe('ord_abc');
    expect(event.gatewayPaymentLinkId).toBeNull();
    expect(event.amountPaise).toBe(49900);
  });

  it('falls back to the gateway order receipt', () => {
    const orderPaid = JSON.stringify({
      event: 'order.paid',
      payload: { order: { entity: { id: 'order_2', receipt: 'ord_xyz', amount: 100 } } },
    });
    expect(parseRazorpayWebhook(orderPaid).reference).toBe('ord_xyz');
  });

  it('returns a null reference rather than guessing', () => {
    const stray = JSON.stringify({ event: 'refund.processed', payload: {} });
    const event = parseRazorpayWebhook(stray);
    expect(event.reference).toBeNull();
    expect(event.kind).toBe('other');
  });

  it('throws on a non-JSON body', () => {
    expect(() => parseRazorpayWebhook('not json')).toThrow(WebhookParseError);
  });

  it('throws when the body carries no event name', () => {
    expect(() => parseRazorpayWebhook(JSON.stringify({ payload: {} }))).toThrow(
      WebhookParseError,
    );
  });

  it('survives unexpected shapes without throwing', () => {
    const weird = JSON.stringify({ event: 'payment.captured', payload: { payment: 'nope' } });
    const event = parseRazorpayWebhook(weird);
    expect(event.gatewayPaymentId).toBeNull();
    expect(event.amountPaise).toBeNull();
  });

  it('prefers a reference we set over the gateway order receipt', () => {
    // reference_id and notes.orderId are ours; receipt could be anything.
    const body = JSON.stringify({
      event: 'payment_link.paid',
      payload: {
        payment_link: { entity: { id: 'plink_1', reference_id: 'ord_from_link' } },
        order: { entity: { id: 'order_1', receipt: 'ord_from_receipt' } },
      },
    });
    expect(parseRazorpayWebhook(body).reference).toBe('ord_from_link');
  });
});

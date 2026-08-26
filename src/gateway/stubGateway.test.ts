import { describe, expect, it } from 'vitest';
import { paise } from '../domain/money.js';
import { StubGateway, STUB_WEBHOOK_SECRET } from './stubGateway.js';
import { GatewayError, type CreatePaymentLinkParams } from './types.js';

function linkParams(overrides: Partial<CreatePaymentLinkParams> = {}): CreatePaymentLinkParams {
  return {
    reference: 'ord_0000000000000000000000000000000a',
    amountPaise: paise(129900),
    currency: 'INR',
    description: 'Oversized Tee × 1',
    callbackUrl:
      'https://merchant.example/payment-callback?orderId=ord_0000000000000000000000000000000a',
    notes: { orderId: 'ord_0000000000000000000000000000000a', merchantId: 'mrc_test' },
    ...overrides,
  };
}

describe('StubGateway.createPaymentLink', () => {
  it('mints deterministic sequenced ids and echoes the amount', async () => {
    const gateway = new StubGateway();
    const first = await gateway.createPaymentLink(linkParams());
    expect(first).toEqual({
      gatewayPaymentLinkId: 'plink_stub_1',
      url: 'https://stub.invalid/pay/plink_stub_1',
      amountPaise: 129900,
      status: 'created',
      gatewayOrderId: null,
    });
    const second = await gateway.createPaymentLink(
      linkParams({ reference: 'ord_0000000000000000000000000000000b' }),
    );
    expect(second.gatewayPaymentLinkId).toBe('plink_stub_2');
  });

  it('two fresh stubs given the same script produce identical links', async () => {
    const a = await new StubGateway().createPaymentLink(linkParams());
    const b = await new StubGateway().createPaymentLink(linkParams());
    expect(a).toEqual(b);
  });

  it('two fresh stubs given the same script produce byte-identical webhook bodies', async () => {
    // The property the whole eval suite rests on: a scripted run is reproducible
    // down to the signed bytes, so a CI failure is a real regression, not drift.
    async function script(): Promise<readonly string[]> {
      const gateway = new StubGateway();
      const link = await gateway.createPaymentLink(linkParams());
      const declined = gateway.failPayment(link.gatewayPaymentLinkId);
      const paid = gateway.completePayment(link.gatewayPaymentLinkId);
      return [...declined, ...paid].flatMap((hook) => [hook.rawBody, hook.signature]);
    }
    expect(await script()).toEqual(await script());
  });
});

describe('StubGateway.completePayment', () => {
  it('returns payment_link.paid then payment.captured, both verifiable and parseable', async () => {
    const gateway = new StubGateway();
    const link = await gateway.createPaymentLink(linkParams());
    const hooks = gateway.completePayment(link.gatewayPaymentLinkId);

    expect(hooks.map((h) => h.rawEvent)).toEqual(['payment_link.paid', 'payment.captured']);
    for (const hook of hooks) {
      expect(gateway.verifyWebhookSignature(hook.rawBody, hook.signature)).toBe(true);
    }

    const paid = gateway.parseWebhookEvent(hooks[0]!.rawBody);
    expect(paid).toEqual({
      kind: 'payment_succeeded',
      rawEvent: 'payment_link.paid',
      reference: 'ord_0000000000000000000000000000000a',
      gatewayOrderId: 'order_stub_1',
      gatewayPaymentId: 'pay_stub_1',
      gatewayPaymentLinkId: 'plink_stub_1',
      amountPaise: 129900,
      gatewayErrorCode: null,
      gatewayErrorDescription: null,
    });

    const captured = gateway.parseWebhookEvent(hooks[1]!.rawBody);
    expect(captured.kind).toBe('payment_succeeded');
    expect(captured.rawEvent).toBe('payment.captured');
    // payment.captured carries no payment_link entity; the reference comes from notes.
    expect(captured.reference).toBe('ord_0000000000000000000000000000000a');
    expect(captured.gatewayOrderId).toBe('order_stub_1');
    expect(captured.amountPaise).toBe(129900);
  });

  it('redelivers byte-identical bodies on repeat calls', async () => {
    const gateway = new StubGateway();
    const link = await gateway.createPaymentLink(linkParams());
    const first = gateway.completePayment(link.gatewayPaymentLinkId);
    const again = gateway.completePayment(link.gatewayPaymentLinkId);
    expect(again).toEqual(first);
  });

  it('throws GatewayError for an unknown payment link', () => {
    expect(() => new StubGateway().completePayment('plink_stub_404')).toThrow(GatewayError);
  });
});

describe('StubGateway.failPayment', () => {
  it('returns a verifiable payment.failed Decline that still recovers the reference', async () => {
    const gateway = new StubGateway();
    const link = await gateway.createPaymentLink(linkParams());
    const hooks = gateway.failPayment(link.gatewayPaymentLinkId);

    expect(hooks).toHaveLength(1);
    expect(gateway.verifyWebhookSignature(hooks[0]!.rawBody, hooks[0]!.signature)).toBe(true);
    const event = gateway.parseWebhookEvent(hooks[0]!.rawBody);
    expect(event.kind).toBe('payment_failed');
    expect(event.rawEvent).toBe('payment.failed');
    expect(event.reference).toBe('ord_0000000000000000000000000000000a');
    expect(event.gatewayPaymentId).toBe('pay_stub_1_fail1');
    // The gateway's own words survive normalisation — a Decline's structured
    // reason (T8) is built from these, never invented.
    expect(event.gatewayErrorCode).toBe('BAD_REQUEST_ERROR');
    expect(event.gatewayErrorDescription).toBe('Payment failed at the stub gateway');
  });

  it('numbers repeated declines so retry-then-fail is scriptable', async () => {
    const gateway = new StubGateway();
    const link = await gateway.createPaymentLink(linkParams());
    gateway.failPayment(link.gatewayPaymentLinkId);
    const second = gateway.failPayment(link.gatewayPaymentLinkId);
    expect(gateway.parseWebhookEvent(second[0]!.rawBody).gatewayPaymentId).toBe('pay_stub_1_fail2');
  });

  it('allows completePayment after a failure (a retry that succeeded)', async () => {
    const gateway = new StubGateway();
    const link = await gateway.createPaymentLink(linkParams());
    gateway.failPayment(link.gatewayPaymentLinkId);
    const hooks = gateway.completePayment(link.gatewayPaymentLinkId);
    expect(gateway.parseWebhookEvent(hooks[0]!.rawBody).kind).toBe('payment_succeeded');
  });

  it('refuses to fail a link that already paid — a contradictory script is a harness bug', async () => {
    const gateway = new StubGateway();
    const link = await gateway.createPaymentLink(linkParams());
    gateway.completePayment(link.gatewayPaymentLinkId);
    expect(() => gateway.failPayment(link.gatewayPaymentLinkId)).toThrow(GatewayError);
  });
});

describe('StubGateway signature scheme', () => {
  it('rejects a tampered body and accepts only the configured secret', async () => {
    const gateway = new StubGateway();
    const link = await gateway.createPaymentLink(linkParams());
    const [hook] = gateway.completePayment(link.gatewayPaymentLinkId);
    expect(gateway.verifyWebhookSignature(hook!.rawBody + ' ', hook!.signature)).toBe(false);

    const custom = new StubGateway({ webhookSecret: 'other-secret' });
    expect(custom.verifyWebhookSignature(hook!.rawBody, hook!.signature)).toBe(false);
    expect(STUB_WEBHOOK_SECRET).toBe('stub-webhook-secret');
  });
});

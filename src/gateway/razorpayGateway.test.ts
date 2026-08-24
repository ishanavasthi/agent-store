import { describe, expect, it, vi } from 'vitest';

const createSpy = vi.fn();

// The Razorpay constructor is replaced wholesale: this suite is about the shape
// of the payload we hand the SDK, never about reaching Razorpay.
vi.mock('razorpay', () => ({
  default: class {
    paymentLink = { create: createSpy };
  },
}));

const { RazorpayGateway } = await import('./razorpayGateway.js');

function gateway() {
  return new RazorpayGateway({
    keyId: 'rzp_test_fake',
    keySecret: 'secret',
    webhookSecret: 'whsec',
  });
}

const params = {
  amountPaise: 129900,
  currency: 'INR',
  description: 'Oversized Heavyweight Tee',
  reference: 'ord_abc',
  callbackUrl: 'https://example.test/paid',
  notes: { orderId: 'ord_abc' },
} as Parameters<InstanceType<typeof RazorpayGateway>['createPaymentLink']>[0];

describe('createPaymentLink payload', () => {
  it('omits `customer` entirely rather than sending an empty object', async () => {
    createSpy.mockResolvedValueOnce({
      id: 'plink_1',
      short_url: 'https://rzp.io/x',
      amount: 129900,
      status: 'created',
    });

    await gateway().createPaymentLink(params);

    const [sent] = createSpy.mock.calls.at(-1) as [Record<string, unknown>];
    // Razorpay answers `customer: {}` with BAD_REQUEST_ERROR, "incorrect JSON
    // object received - faulty key: customer" — the live failure this pins.
    expect('customer' in sent).toBe(false);
    expect(sent).toMatchObject({
      amount: 129900,
      currency: 'INR',
      reference_id: 'ord_abc',
      callback_method: 'get',
    });
  });

  it('does not trust the order_id echoed back by the link-create response', async () => {
    createSpy.mockResolvedValueOnce({
      id: 'plink_2',
      short_url: 'https://rzp.io/y',
      amount: 129900,
      status: 'created',
    });

    const link = await gateway().createPaymentLink(params);

    // Absent in the response → null, never invented. The authoritative gateway
    // order id is the one the webhook reports.
    expect(link.gatewayOrderId).toBeNull();
    expect(link.gatewayPaymentLinkId).toBe('plink_2');
  });
});

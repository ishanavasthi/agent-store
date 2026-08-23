import Razorpay from 'razorpay';
import { paise } from '../domain/money.js';
import { parseRazorpayWebhook, verifyRazorpaySignature } from './razorpayWebhook.js';
import {
  GatewayError,
  type CreateGatewayOrderParams,
  type CreatePaymentLinkParams,
  type GatewayOrder,
  type GatewayWebhookEvent,
  type PaymentGateway,
  type PaymentLink,
} from './types.js';

export interface RazorpayGatewayOptions {
  readonly keyId: string;
  readonly keySecret: string;
  readonly webhookSecret: string;
}

/**
 * The real Razorpay Node SDK, test mode only.
 *
 * This is the *only* file in the codebase that imports `razorpay`. T2's
 * deterministic stub implements the same `PaymentGateway` interface and is
 * swapped in at composition time — nothing above this seam changes.
 *
 * Amounts cross this boundary unconverted: Razorpay is paise-denominated and so
 * are we, so there is no place for a rounding bug to live.
 */
export class RazorpayGateway implements PaymentGateway {
  readonly name = 'razorpay';

  readonly #client: Razorpay;
  readonly #webhookSecret: string;

  constructor(options: RazorpayGatewayOptions) {
    if (!options.keyId.startsWith('rzp_test_')) {
      // A live key would move real money. The project is test-mode permanently
      // (PLAN §10), so refuse at construction rather than discover it at checkout.
      throw new GatewayError(
        `RAZORPAY_KEY_ID must be a test key (rzp_test_…); refusing to start with ${options.keyId.slice(0, 8)}…`,
      );
    }
    this.#client = new Razorpay({ key_id: options.keyId, key_secret: options.keySecret });
    this.#webhookSecret = options.webhookSecret;
  }

  async createGatewayOrder(params: CreateGatewayOrderParams): Promise<GatewayOrder> {
    try {
      const created = await this.#client.orders.create({
        amount: params.amountPaise,
        currency: params.currency,
        // `receipt` is the field a webhook echoes back as our domain Order id.
        receipt: params.reference,
        notes: { ...params.notes },
      });
      return {
        gatewayOrderId: created.id,
        amountPaise: paise(Number(created.amount)),
        currency: String(created.currency),
        status: created.status,
      };
    } catch (error) {
      throw new GatewayError('Failed to create gateway order at Razorpay', error);
    }
  }

  async createPaymentLink(params: CreatePaymentLinkParams): Promise<PaymentLink> {
    try {
      const created = await this.#client.paymentLink.create({
        amount: params.amountPaise,
        currency: params.currency,
        description: params.description,
        reference_id: params.reference,
        callback_url: params.callbackUrl,
        callback_method: 'get',
        // v1 collects no buyer contact details — the human arrives via the URL
        // their agent handed them, so there is nobody to notify and no PII to hold.
        customer: {},
        notify: { sms: false, email: false },
        notes: { ...params.notes },
      });
      return {
        gatewayPaymentLinkId: created.id,
        url: created.short_url,
        amountPaise: paise(Number(created.amount)),
        status: String(created.status),
      };
    } catch (error) {
      throw new GatewayError('Failed to create Payment Link at Razorpay', error);
    }
  }

  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    return verifyRazorpaySignature(rawBody, signature, this.#webhookSecret);
  }

  parseWebhookEvent(rawBody: string): GatewayWebhookEvent {
    return parseRazorpayWebhook(rawBody);
  }
}

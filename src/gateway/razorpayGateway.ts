import Razorpay from 'razorpay';
import type { PaymentLinks } from 'razorpay/dist/types/paymentLink.js';
import { paise } from '../domain/money.js';
import { parseRazorpayWebhook, verifyRazorpaySignature } from './razorpayWebhook.js';
import {
  GatewayError,
  type CreatePaymentLinkParams,
  type GatewayRefund,
  type GatewayWebhookEvent,
  type PaymentGateway,
  type PaymentLink,
  type RefundPaymentParams,
} from './types.js';

export interface RazorpayGatewayOptions {
  readonly keyId: string;
  readonly keySecret: string;
  readonly webhookSecret: string;
}

/**
 * The real Razorpay Node SDK, test mode only.
 *
 * This is the *only* file in the codebase that imports `razorpay`. The
 * deterministic stub implements the same `PaymentGateway` interface, and tests
 * and the eval harness construct it at their own composition points — the
 * deployed server stays Razorpay-only, and nothing above this seam changes.
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

  /**
   * Creates the *only* checkout-time gateway artifact.
   *
   * Razorpay mints its own gateway order behind this link; we neither create
   * one nor trust the `order_id` echoed here as final. The authoritative
   * gateway order id is the one the webhook reports, because that is the object
   * the payment actually hit.
   */
  async createPaymentLink(params: CreatePaymentLinkParams): Promise<PaymentLink> {
    try {
      // v1 collects no buyer contact details — the human arrives via the URL
      // their agent handed them, so there is nobody to notify and no PII to hold.
      // `customer` must be OMITTED, not sent as `{}`: the live API rejects an
      // empty object with "incorrect JSON object received - faulty key:
      // customer". The SDK's types declare `customer` as required, which is
      // wrong against the real API, so the payload is typed without it and cast
      // once here rather than weakening the whole call site.
      const payload: Omit<PaymentLinks.RazorpayPaymentLinkCreateRequestBody, 'customer'> = {
        amount: params.amountPaise,
        currency: params.currency,
        description: params.description,
        // The field a webhook echoes back as our domain Order id.
        reference_id: params.reference,
        callback_url: params.callbackUrl,
        callback_method: 'get',
        notify: { sms: false, email: false },
        notes: { ...params.notes },
      };

      const created = await this.#client.paymentLink.create(
        payload as PaymentLinks.RazorpayPaymentLinkCreateRequestBody,
      );

      const hintedOrderId = (created as { order_id?: unknown }).order_id;

      return {
        gatewayPaymentLinkId: created.id,
        url: created.short_url,
        amountPaise: paise(Number(created.amount)),
        status: String(created.status),
        gatewayOrderId:
          typeof hintedOrderId === 'string' && hintedOrderId !== '' ? hintedOrderId : null,
      };
    } catch (error) {
      // Razorpay nests the useful part under `error.error.description`; without
      // this line a rejected payload surfaces to the operator as nothing but
      // "Failed to create Payment Link", which is undiagnosable from logs.
      const detail = (error as { error?: { description?: unknown; code?: unknown } }).error;
      console.error('[agent-store] Razorpay rejected the Payment Link', {
        code: detail?.code ?? null,
        description: detail?.description ?? String(error),
      });
      throw new GatewayError('Failed to create Payment Link at Razorpay', error);
    }
  }

  /**
   * The real refund call (T9's Oversell path). Test-mode trap §5.5: the refund
   * API works only against **captured** payments — the caller guarantees that
   * by construction, because an Oversell begins at a capture. The refund is
   * then visible in the Razorpay test dashboard under Payments → Refunds,
   * which is the acceptance check for the real-rails run of failure 2.
   */
  async refundPayment(params: RefundPaymentParams): Promise<GatewayRefund> {
    try {
      const refund = await this.#client.payments.refund(params.gatewayPaymentId, {
        amount: params.amountPaise,
        speed: 'normal',
        notes: { ...params.notes },
      });

      const refundId = (refund as { id?: unknown }).id;
      if (typeof refundId !== 'string' || refundId === '') {
        // A refund object with no id cannot be bound into a refund receipt —
        // treat the response as a failure rather than signing a blank binding.
        throw new GatewayError('Razorpay returned a refund with no id');
      }
      return {
        gatewayRefundId: refundId,
        amountPaise: paise(Number(refund.amount ?? params.amountPaise)),
        status: String((refund as { status?: unknown }).status ?? 'unknown'),
      };
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      // Same surfacing rule as createPaymentLink: Razorpay's useful part nests
      // under `error.error.description` and would otherwise be invisible.
      const detail = (error as { error?: { description?: unknown; code?: unknown } }).error;
      console.error('[agent-store] Razorpay rejected the refund', {
        gatewayPaymentId: params.gatewayPaymentId,
        code: detail?.code ?? null,
        description: detail?.description ?? String(error),
      });
      throw new GatewayError(
        `Failed to refund payment ${params.gatewayPaymentId} at Razorpay`,
        error,
      );
    }
  }

  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    return verifyRazorpaySignature(rawBody, signature, this.#webhookSecret);
  }

  parseWebhookEvent(rawBody: string): GatewayWebhookEvent {
    return parseRazorpayWebhook(rawBody);
  }
}

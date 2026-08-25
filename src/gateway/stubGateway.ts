import { createHmac } from 'node:crypto';
import type { Paise } from '../domain/money.js';
import { parseRazorpayWebhook, verifyRazorpaySignature } from './razorpayWebhook.js';
import {
  GatewayError,
  type CreatePaymentLinkParams,
  type GatewayWebhookEvent,
  type PaymentGateway,
  type PaymentLink,
} from './types.js';

/**
 * The deterministic in-process gateway (T2, PLAN §5.4).
 *
 * Everything the real gateway does over the network, this does as data: it
 * mints Payment Links (each with its own internal gateway order, exactly as a
 * Razorpay link does), and hands back Razorpay-shaped webhook bodies for the
 * harness to deliver itself. It never calls anything, reads no clock, and
 * draws no randomness — the Nth call on a fresh stub always yields the same
 * bytes, which is what makes the eval suite CI-runnable (PLAN §6) and is the
 * only reliable way to trigger a Decline programmatically (§5.5: test mode has
 * no API-driven payment completion).
 *
 * Webhook verification and parsing reuse the pure helpers in
 * `razorpayWebhook.ts`, so synthetic events exercise the identical
 * normalisation path real ones do — no stub-specific branch exists above the
 * seam.
 *
 * Scripting: `completePayment` / `failPayment` are the "on demand" levers.
 * A Decline is one `failPayment`; the bounded-retry-then-fail-closed
 * rehearsal (T8) is two; an Oversell (T9) is two Orders' payments completed
 * against stock that only covers one — the stub completes captures on
 * command, and the shortfall is the domain's to discover at fulfilment.
 */

export const STUB_WEBHOOK_SECRET = 'stub-webhook-secret';

export interface StubGatewayOptions {
  readonly webhookSecret?: string;
}

/** One synthetic delivery: the exact bytes and signature a harness POSTs. */
export interface SyntheticWebhook {
  readonly rawEvent: string;
  readonly rawBody: string;
  readonly signature: string;
}

interface StubLink {
  readonly seq: number;
  readonly gatewayPaymentLinkId: string;
  /** Minted with the link, exactly as Razorpay does — learned via webhook. */
  readonly gatewayOrderId: string;
  readonly reference: string;
  readonly amountPaise: Paise;
  readonly notes: Readonly<Record<string, string>>;
  failedAttempts: number;
  /**
   * Stored on first capture so redelivery is byte-identical — and, being the
   * only record of a capture, it is also what "already paid" means here.
   */
  paidDeliveries: readonly SyntheticWebhook[] | null;
}

export class StubGateway implements PaymentGateway {
  readonly name = 'stub';

  readonly #secret: string;
  readonly #links = new Map<string, StubLink>();
  #seq = 0;

  constructor(options: StubGatewayOptions = {}) {
    this.#secret = options.webhookSecret ?? STUB_WEBHOOK_SECRET;
  }

  async createPaymentLink(params: CreatePaymentLinkParams): Promise<PaymentLink> {
    const seq = ++this.#seq;
    const link: StubLink = {
      seq,
      gatewayPaymentLinkId: `plink_stub_${seq}`,
      gatewayOrderId: `order_stub_${seq}`,
      reference: params.reference,
      amountPaise: params.amountPaise,
      notes: { ...params.notes },
      failedAttempts: 0,
      paidDeliveries: null,
    };
    this.#links.set(link.gatewayPaymentLinkId, link);
    return {
      gatewayPaymentLinkId: link.gatewayPaymentLinkId,
      url: `https://stub.invalid/pay/${link.gatewayPaymentLinkId}`,
      amountPaise: params.amountPaise,
      status: 'created',
      // Deliberately withheld, mirroring a create response that does not expose
      // it: the authoritative gateway order id arrives on the webhook.
      gatewayOrderId: null,
    };
  }

  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    return verifyRazorpaySignature(rawBody, signature, this.#secret);
  }

  parseWebhookEvent(rawBody: string): GatewayWebhookEvent {
    return parseRazorpayWebhook(rawBody);
  }

  /**
   * Settle a link as paid. Returns the deliveries Razorpay would fire —
   * `payment_link.paid` then `payment.captured` — so delivering both
   * exercises the handler's idempotency. Repeat calls are redelivery:
   * the same stored bytes come back.
   */
  completePayment(gatewayPaymentLinkId: string): readonly SyntheticWebhook[] {
    const link = this.#requireLink(gatewayPaymentLinkId);
    if (link.paidDeliveries !== null) return link.paidDeliveries;

    const gatewayPaymentId = `pay_stub_${link.seq}`;
    const paymentEntity = {
      id: gatewayPaymentId,
      amount: link.amountPaise,
      order_id: link.gatewayOrderId,
      notes: link.notes,
    };
    const deliveries: readonly SyntheticWebhook[] = [
      this.#delivery('payment_link.paid', {
        payment_link: {
          entity: {
            id: link.gatewayPaymentLinkId,
            reference_id: link.reference,
            amount: link.amountPaise,
            order_id: link.gatewayOrderId,
            status: 'paid',
            notes: link.notes,
          },
        },
        payment: { entity: paymentEntity },
      }),
      this.#delivery('payment.captured', { payment: { entity: paymentEntity } }),
    ];
    link.paidDeliveries = deliveries;
    return deliveries;
  }

  /**
   * Settle an attempt as a Decline. Each call is a fresh failed attempt with
   * its own payment id, so decline → retry → decline is scriptable (T8).
   *
   * A decline *after* a capture is refused: the link is already paid, so the
   * script contradicts itself, and that is a harness bug worth failing loud on.
   * The reverse order — decline, then complete — is a retry that succeeded, and
   * is allowed.
   */
  failPayment(gatewayPaymentLinkId: string): readonly SyntheticWebhook[] {
    const link = this.#requireLink(gatewayPaymentLinkId);
    if (link.paidDeliveries !== null) {
      throw new GatewayError(
        `Payment link ${gatewayPaymentLinkId} already paid; a decline after capture is a contradictory script`,
      );
    }
    link.failedAttempts += 1;
    return [
      this.#delivery('payment.failed', {
        payment: {
          entity: {
            id: `pay_stub_${link.seq}_fail${link.failedAttempts}`,
            amount: link.amountPaise,
            order_id: link.gatewayOrderId,
            status: 'failed',
            error_code: 'BAD_REQUEST_ERROR',
            error_description: 'Payment failed at the stub gateway',
            // A `payment.failed` carries no `payment_link` entity, so `notes` is
            // the only field left holding our domain Order id.
            notes: link.notes,
          },
        },
      }),
    ];
  }

  #requireLink(gatewayPaymentLinkId: string): StubLink {
    const link = this.#links.get(gatewayPaymentLinkId);
    if (link === undefined) {
      throw new GatewayError(
        `Unknown payment link ${gatewayPaymentLinkId}; create it before settling it`,
      );
    }
    return link;
  }

  #delivery(rawEvent: string, payload: Record<string, unknown>): SyntheticWebhook {
    const rawBody = JSON.stringify({ event: rawEvent, payload });
    const signature = createHmac('sha256', this.#secret).update(rawBody, 'utf8').digest('hex');
    return { rawEvent, rawBody, signature };
  }
}

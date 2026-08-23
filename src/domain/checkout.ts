import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { orders } from '../db/schema.js';
import type { PaymentGateway } from '../gateway/types.js';
import { appendAuditEvent } from './auditLog.js';
import { findPublishedVariant, defaultPublishedVariant, type VariantView } from './catalog.js';
import { newId, toGatewayReference } from './ids.js';
import { formatPaise, multiplyPaise, type Paise } from './money.js';

/**
 * Checkout — the walking-skeleton path (T1).
 *
 * Shape to preserve: this reads as three ordered phases —
 *   1. resolve what is being bought,
 *   2. **the trust gate** (empty in T1),
 *   3. create the domain Order, then the gateway objects.
 *
 * T3/T4 insert mandate-chain verification, Budget/Cap enforcement, idempotency
 * and price-hash pinning at phase 2 — strictly *before* any call reaches the
 * gateway, so a Refusal always means zero money moved. That ordering is the
 * whole reason the gateway calls live at the bottom of this function rather
 * than interleaved with the Order write.
 *
 * ADR-0003: every state change below commits in the same transaction as its
 * audit event. There is no code path here that writes Order state alone.
 */

export interface CheckoutRequest {
  readonly merchantId: string;
  /** Omitted means "the merchant's single published Variant" (T1 convenience). */
  readonly variantId?: string | undefined;
  readonly quantity: number;
}

export interface CheckoutResult {
  readonly orderId: string;
  readonly status: string;
  readonly amountPaise: Paise;
  readonly amountDisplay: string;
  readonly currency: string;
  readonly quantity: number;
  readonly variant: VariantView;
  readonly gatewayOrderId: string;
  readonly gatewayPaymentLinkId: string;
  /** The hosted link the human approves — the consent step. */
  readonly paymentLinkUrl: string;
}

export class CheckoutError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CheckoutError';
    this.code = code;
  }
}

export interface CheckoutDeps {
  readonly db: Database;
  readonly gateway: PaymentGateway;
  readonly publicBaseUrl: string;
}

export async function checkout(
  deps: CheckoutDeps,
  request: CheckoutRequest,
): Promise<CheckoutResult> {
  const { db, gateway, publicBaseUrl } = deps;

  if (!Number.isSafeInteger(request.quantity) || request.quantity < 1) {
    throw new CheckoutError('INVALID_QUANTITY', 'Quantity must be a positive integer');
  }

  // --- 1. Resolve what is being bought -------------------------------------
  const variant =
    request.variantId === undefined
      ? await defaultPublishedVariant(db, request.merchantId)
      : await findPublishedVariant(db, request.merchantId, request.variantId);

  if (variant === null) {
    throw new CheckoutError(
      'VARIANT_NOT_FOUND',
      request.variantId === undefined
        ? 'This merchant has no published Variant to sell'
        : `No published Variant with id ${request.variantId}`,
    );
  }

  if (variant.stock < request.quantity) {
    // Pre-payment shortfall. Not an Oversell — that term is reserved for a
    // shortfall found *after* capture (CONTEXT.md → Oversell).
    throw new CheckoutError(
      'OUT_OF_STOCK',
      `Only ${variant.stock} left of ${variant.productTitle}; ${request.quantity} requested`,
    );
  }

  // --- 2. Trust gate -------------------------------------------------------
  // T3/T4: verify the mandate chain, enforce Budget and Cap, check idempotency
  // and the pinned price hash. A Refusal returns from here, before the gateway
  // is ever touched.

  // --- 3. Create the domain Order ------------------------------------------
  const orderId = newId('order');
  const amountPaise = multiplyPaise(variant.pricePaise, request.quantity);

  await db.transaction(async (tx) => {
    await tx.insert(orders).values({
      id: orderId,
      merchantId: request.merchantId,
      variantId: variant.variantId,
      quantity: request.quantity,
      unitPricePaise: variant.pricePaise,
      amountPaise,
      currency: variant.currency,
      status: 'created',
    });
    await appendAuditEvent(tx, {
      type: 'order.created',
      merchantId: request.merchantId,
      orderId,
      payload: {
        variantId: variant.variantId,
        productTitle: variant.productTitle,
        quantity: request.quantity,
        unitPricePaise: variant.pricePaise,
        amountPaise,
        currency: variant.currency,
      },
    });
  });

  const reference = toGatewayReference(orderId);
  const notes = { orderId, merchantId: request.merchantId };

  // --- 4. Gateway objects, each recorded as it lands -----------------------
  const gatewayOrder = await gateway.createGatewayOrder({
    reference,
    amountPaise,
    currency: 'INR',
    notes,
  });

  await db.transaction(async (tx) => {
    await tx
      .update(orders)
      .set({ gatewayOrderId: gatewayOrder.gatewayOrderId, updatedAt: new Date() })
      .where(eq(orders.id, orderId));
    await appendAuditEvent(tx, {
      type: 'gateway.order_created',
      merchantId: request.merchantId,
      orderId,
      payload: {
        gateway: gateway.name,
        gatewayOrderId: gatewayOrder.gatewayOrderId,
        amountPaise: gatewayOrder.amountPaise,
        currency: gatewayOrder.currency,
        gatewayStatus: gatewayOrder.status,
      },
    });
  });

  const paymentLink = await gateway.createPaymentLink({
    reference,
    amountPaise,
    currency: 'INR',
    description: `${variant.productTitle}${variant.label === null ? '' : ` (${variant.label})`} × ${request.quantity}`,
    callbackUrl: `${publicBaseUrl}/payment-callback?orderId=${encodeURIComponent(orderId)}`,
    notes,
  });

  await db.transaction(async (tx) => {
    await tx
      .update(orders)
      .set({
        gatewayPaymentLinkId: paymentLink.gatewayPaymentLinkId,
        paymentLinkUrl: paymentLink.url,
        status: 'awaiting_payment',
        updatedAt: new Date(),
      })
      .where(eq(orders.id, orderId));
    await appendAuditEvent(tx, {
      type: 'gateway.payment_link_issued',
      merchantId: request.merchantId,
      orderId,
      payload: {
        gateway: gateway.name,
        gatewayPaymentLinkId: paymentLink.gatewayPaymentLinkId,
        paymentLinkUrl: paymentLink.url,
        amountPaise: paymentLink.amountPaise,
        gatewayStatus: paymentLink.status,
      },
    });
  });

  return {
    orderId,
    status: 'awaiting_payment',
    amountPaise,
    amountDisplay: formatPaise(amountPaise),
    currency: variant.currency,
    quantity: request.quantity,
    variant,
    gatewayOrderId: gatewayOrder.gatewayOrderId,
    gatewayPaymentLinkId: paymentLink.gatewayPaymentLinkId,
    paymentLinkUrl: paymentLink.url,
  };
}

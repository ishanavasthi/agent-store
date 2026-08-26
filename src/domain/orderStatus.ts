import type { StorefrontDeps } from '../deps.js';
import { findPublishedVariant } from './catalog.js';
import { findOrderById, listOrderItems, toOrderStatusView, type OrderStatusView } from './orders.js';
import {
  findOrderReceipt,
  findOrderRefundReceipt,
  type OrderReceiptView,
  type OrderRefundReceiptView,
} from './receipts.js';
import type { OrderItemView } from './orders.js';
import { ValidationError } from './refusal.js';

/**
 * The one order-status view both protocol faces serve (T14). The MCP tool
 * `get_order_status` and REST `GET /acp/orders/:orderId` must answer with the
 * *same* body — Receipt included — so the assembly lives here, in the core,
 * rather than being copied per face and drifting.
 */
export interface OrderStatusBody extends OrderStatusView {
  readonly items: readonly OrderItemView[];
  /** Legacy single-variant Orders only; mandate-backed Orders carry `items`. */
  readonly product: string | null;
  /**
   * Present when status is `paid` or `refunded` on a mandate-backed Order — a
   * refunded Order keeps its Receipt: the charge really happened, and the
   * refund receipt references it by hash.
   */
  readonly receipt: OrderReceiptView | null;
  /** Present exactly when status is `refunded` (T9's Oversell path). */
  readonly refundReceipt: OrderRefundReceiptView | null;
  readonly auditUrl: string;
}

/** Throws `ORDER_NOT_FOUND` (a validation error, never a Refusal) for unknown ids. */
export async function readOrderStatus(
  deps: StorefrontDeps,
  orderId: string,
): Promise<OrderStatusBody> {
  const row = await findOrderById(deps.db, deps.merchantId, orderId);
  if (row === null) {
    throw new ValidationError('ORDER_NOT_FOUND', `No order with id ${orderId}`);
  }
  const items = await listOrderItems(deps.db, row.id);
  // Legacy single-variant Orders only; mandate-backed Orders (T4) have a
  // null variantId and carry their product detail in `items` instead.
  const variant =
    row.variantId === null
      ? null
      : await findPublishedVariant(deps.db, deps.merchantId, row.variantId);
  // The Receipt is minted by the paid webhook, so it appears exactly when the
  // status flips to paid — and only for mandate-backed Orders. A refunded
  // Order keeps serving it: the refund receipt references it by hash, and a
  // buyer holding only one of the pair could verify nothing.
  const receipt =
    row.status === 'paid' || row.status === 'refunded'
      ? await findOrderReceipt(deps.db, deps.merchantId, row.id)
      : null;
  const refundReceipt =
    row.status === 'refunded' ? await findOrderRefundReceipt(deps.db, deps.merchantId, row.id) : null;
  return {
    ...toOrderStatusView(row),
    items,
    product: variant?.productTitle ?? null,
    receipt,
    refundReceipt,
    auditUrl: `${deps.publicBaseUrl}/audit/${row.id}`,
  };
}

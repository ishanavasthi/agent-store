import type { StorefrontDeps } from '../deps.js';
import { findPublishedVariant } from './catalog.js';
import { findOrderById, listOrderItems, toOrderStatusView, type OrderStatusView } from './orders.js';
import { findOrderReceipt, type OrderReceiptView } from './receipts.js';
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
  /** Present exactly when status is `paid` on a mandate-backed Order. */
  readonly receipt: OrderReceiptView | null;
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
  // The Receipt is minted by the paid webhook, so it appears exactly when
  // the status flips to paid — and only for mandate-backed Orders.
  const receipt =
    row.status === 'paid' ? await findOrderReceipt(deps.db, deps.merchantId, row.id) : null;
  return {
    ...toOrderStatusView(row),
    items,
    product: variant?.productTitle ?? null,
    receipt,
    auditUrl: `${deps.publicBaseUrl}/audit/${row.id}`,
  };
}

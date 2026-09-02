import { and, eq, gte, sql } from 'drizzle-orm';
import { unionAll } from 'drizzle-orm/pg-core';
import type { Executor } from '../db/client.js';
import { orders, products, type OrderStatus, type ProductStatus } from '../db/schema.js';

/**
 * The one aggregate the merchant's `store_summary` needs (S1.5): how many
 * Products sit in each status, how many Orders sit in each status, and how
 * much money the paid ones represent — total and since midnight.
 *
 * A single `UNION ALL` rather than three round trips, and rather than counting
 * in JavaScript over rows the merchant face has no other use for: the summary
 * is one chat turn's answer and must not scale with the size of the catalog or
 * the ledger. Everything else the tool reports (low stock, sold out, unmet
 * demand) comes from the existing reads, which already have exactly the shape
 * the answer needs.
 *
 * Revenue counts `paid` Orders only. A `refunded` Order was money that arrived
 * and then left again (T9's Oversell path), so reporting it as revenue would
 * overstate the day; it stays visible in `ordersByStatus`, which is where a
 * merchant asking "what happened" should see it.
 */

export interface StoreCounts {
  /** Every `ProductStatus` present, by status. Absent statuses are zero. */
  readonly productsByStatus: Readonly<Partial<Record<ProductStatus, number>>>;
  readonly ordersByStatus: Readonly<Partial<Record<OrderStatus, number>>>;
  /** Integer paise, summed over `paid` Orders. Never rupees, never a float. */
  readonly revenuePaiseTotal: number;
  /** The same sum restricted to Orders paid since midnight (database clock, UTC). */
  readonly revenuePaiseToday: number;
}

interface CountRow {
  bucket: string;
  key: string;
  count: number;
  amountPaise: number;
}

export async function readStoreCounts(
  executor: Executor,
  merchantId: string,
): Promise<StoreCounts> {
  const productRows = executor
    .select({
      bucket: sql<string>`'product'`.as('bucket'),
      key: sql<string>`${products.status}::text`.as('key'),
      count: sql<number>`count(*)::int`.as('count'),
      amountPaise: sql<number>`0::int`.as('amount_paise'),
    })
    .from(products)
    .where(eq(products.merchantId, merchantId))
    .groupBy(products.status);

  const orderRows = executor
    .select({
      bucket: sql<string>`'order'`.as('bucket'),
      key: sql<string>`${orders.status}::text`.as('key'),
      count: sql<number>`count(*)::int`.as('count'),
      amountPaise: sql<number>`coalesce(sum(${orders.amountPaise}), 0)::int`.as('amount_paise'),
    })
    .from(orders)
    .where(eq(orders.merchantId, merchantId))
    .groupBy(orders.status);

  const todayRows = executor
    .select({
      bucket: sql<string>`'revenue_today'`.as('bucket'),
      key: sql<string>`'paid'`.as('key'),
      count: sql<number>`count(*)::int`.as('count'),
      amountPaise: sql<number>`coalesce(sum(${orders.amountPaise}), 0)::int`.as('amount_paise'),
    })
    .from(orders)
    .where(
      and(
        eq(orders.merchantId, merchantId),
        eq(orders.status, 'paid'),
        gte(orders.paidAt, sql`date_trunc('day', now())`),
      ),
    );

  const rows = (await unionAll(productRows, orderRows, todayRows)) as CountRow[];

  const productsByStatus: Partial<Record<ProductStatus, number>> = {};
  const ordersByStatus: Partial<Record<OrderStatus, number>> = {};
  let revenuePaiseTotal = 0;
  let revenuePaiseToday = 0;

  for (const row of rows) {
    if (row.bucket === 'product') {
      productsByStatus[row.key as ProductStatus] = row.count;
    } else if (row.bucket === 'order') {
      ordersByStatus[row.key as OrderStatus] = row.count;
      if (row.key === 'paid') revenuePaiseTotal = row.amountPaise;
    } else {
      revenuePaiseToday = row.amountPaise;
    }
  }

  return { productsByStatus, ordersByStatus, revenuePaiseTotal, revenuePaiseToday };
}

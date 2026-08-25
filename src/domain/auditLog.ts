import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Executor, Transaction } from '../db/client.js';
import { auditEvents, cartMandates, paymentMandates } from '../db/schema.js';
import {
  toAuditChain,
  type AuditChainEntry,
  type AuditEventRecord,
  type AuditEventType,
} from './auditEvents.js';

export interface AuditEventInput {
  readonly type: AuditEventType;
  readonly merchantId: string;
  readonly orderId: string | null;
  readonly payload: Record<string, unknown>;
}

/**
 * Append one audit event.
 *
 * The parameter type is `Transaction`, not `Executor`, on purpose: ADR-0003
 * says a state change and its audit event commit together, and the type system
 * is the cheapest place to enforce it. If you find yourself wanting to call
 * this outside a transaction, the state change it describes is being written
 * unsafely.
 */
export async function appendAuditEvent(tx: Transaction, event: AuditEventInput): Promise<void> {
  await tx.insert(auditEvents).values({
    type: event.type,
    merchantId: event.merchantId,
    orderId: event.orderId,
    payload: event.payload,
  });
}

/** Read one Order's event chain back in `seq` order. Reads need no transaction. */
export async function readAuditChain(
  executor: Executor,
  orderId: string,
): Promise<AuditChainEntry[]> {
  const rows = await executor
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.orderId, orderId))
    .orderBy(asc(auditEvents.seq));

  return toAuditChain(rows.map(toRecord));
}

/**
 * Read one *purchase's* event chain: the Order-attributed events plus the
 * mandate events that preceded the Order.
 *
 * `mandate.intent_declared` and `mandate.cart_created` are necessarily written
 * with `orderId: null` — no Order exists yet when they happen — so an
 * order-scoped read alone would report every mandate-backed purchase as
 * missing its first two REQUIRED_HAPPY_PATH steps. The linkage back is the
 * chain itself: Order → its Payment mandate row → `cartHash` → the Cart's
 * `intentHash`, matched against the hashes those events carry in their
 * payloads. A pre-T4 Order has no Payment mandate and gets exactly the
 * order-scoped chain (honestly incomplete, per `REQUIRED_HAPPY_PATH`'s note).
 */
export async function readPurchaseAuditChain(
  executor: Executor,
  orderId: string,
): Promise<AuditChainEntry[]> {
  const [paymentMandate] = await executor
    .select({ cartHash: paymentMandates.cartHash })
    .from(paymentMandates)
    .where(eq(paymentMandates.orderId, orderId))
    .limit(1);
  if (paymentMandate === undefined) {
    return readAuditChain(executor, orderId);
  }
  const [cart] = await executor
    .select({ intentHash: cartMandates.intentHash })
    .from(cartMandates)
    .where(eq(cartMandates.hash, paymentMandate.cartHash))
    .limit(1);

  const mandateEventConditions = [
    and(
      eq(auditEvents.type, 'mandate.cart_created'),
      sql`${auditEvents.payload}->>'cartHash' = ${paymentMandate.cartHash}`,
    ),
    ...(cart === undefined
      ? []
      : [
          and(
            eq(auditEvents.type, 'mandate.intent_declared'),
            sql`${auditEvents.payload}->>'intentHash' = ${cart.intentHash}`,
          ),
        ]),
  ];

  const rows = await executor
    .select()
    .from(auditEvents)
    .where(
      or(
        eq(auditEvents.orderId, orderId),
        and(isNull(auditEvents.orderId), or(...mandateEventConditions)),
      ),
    )
    .orderBy(asc(auditEvents.seq));

  return toAuditChain(rows.map(toRecord));
}

function toRecord(row: typeof auditEvents.$inferSelect): AuditEventRecord {
  return {
    seq: row.seq,
    type: row.type,
    orderId: row.orderId,
    merchantId: row.merchantId,
    occurredAt: row.occurredAt,
    payload: (row.payload ?? {}) as Record<string, unknown>,
  };
}

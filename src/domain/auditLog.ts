import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Executor, Transaction } from '../db/client.js';
import { auditEvents, cartMandates, paymentMandates } from '../db/schema.js';
import {
  isRefusalEventType,
  REFUSAL_EVENT_TYPES,
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

/**
 * The most recent standalone Refusal events, newest first — the `GET /audit`
 * directory's refusal list. Canonical `seq` order reversed, not a timestamp
 * sort, for the same reason `toAuditChain` orders by `seq`.
 */
export async function listRecentRefusals(
  executor: Executor,
  merchantId: string,
  limit: number,
): Promise<AuditChainEntry[]> {
  const rows = await executor
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.merchantId, merchantId),
        inArray(auditEvents.type, [...REFUSAL_EVENT_TYPES]),
      ),
    )
    .orderBy(desc(auditEvents.seq))
    .limit(limit);

  return toAuditChain(rows.map(toRecord)).reverse();
}

export interface RefusalContext {
  readonly refusal: AuditChainEntry;
  /** The refusal's purchase-attempt context in `seq` order, refusal included. */
  readonly events: AuditChainEntry[];
}

/**
 * Read one standalone Refusal and its purchase-attempt context, addressed by
 * audit `seq` — a Refusal has no Order to be addressed by.
 *
 * Context is recovered through the hashes the refusal payload already carries
 * (the `readPurchaseAuditChain` linkage trick): a `payment.refused` names its
 * `intentHash`/`cartHash`, which find the `mandate.intent_declared` /
 * `mandate.cart_created` events and any sibling refusals of the same attempt.
 * `agent.refused` / `mandate.refused` carry no hashes because the refusal
 * happened before any chain existed — the single event IS the complete story.
 *
 * Null when the seq names nothing, or names an event that is not a Refusal.
 */
export async function readRefusalContext(
  executor: Executor,
  merchantId: string,
  seq: number,
): Promise<RefusalContext | null> {
  const [row] = await executor
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.seq, seq), eq(auditEvents.merchantId, merchantId)))
    .limit(1);
  if (row === undefined || !isRefusalEventType(row.type)) {
    return null;
  }

  const record = toRecord(row);
  const intentHash = asHash(record.payload['intentHash']);
  const cartHash = asHash(record.payload['cartHash']);

  if (intentHash === null && cartHash === null) {
    const events = toAuditChain([record]);
    return { refusal: events[0]!, events };
  }

  const contextConditions = [
    eq(auditEvents.seq, seq),
    ...(cartHash === null
      ? []
      : [
          and(
            eq(auditEvents.type, 'mandate.cart_created'),
            sql`${auditEvents.payload}->>'cartHash' = ${cartHash}`,
          ),
        ]),
    ...(intentHash === null
      ? []
      : [
          and(
            eq(auditEvents.type, 'mandate.intent_declared'),
            sql`${auditEvents.payload}->>'intentHash' = ${intentHash}`,
          ),
          // Sibling refusals of the same attempt: retries under one Intent.
          and(
            inArray(auditEvents.type, [...REFUSAL_EVENT_TYPES]),
            sql`${auditEvents.payload}->>'intentHash' = ${intentHash}`,
          ),
        ]),
  ];

  const rows = await executor
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.merchantId, merchantId), or(...contextConditions)))
    .orderBy(asc(auditEvents.seq));

  const events = toAuditChain(rows.map(toRecord));
  return { refusal: events.find((event) => event.seq === seq)!, events };
}

function asHash(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
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

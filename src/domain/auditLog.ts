import { asc, eq } from 'drizzle-orm';
import type { Executor, Transaction } from '../db/client.js';
import { auditEvents } from '../db/schema.js';
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

  const records: AuditEventRecord[] = rows.map((row) => ({
    seq: row.seq,
    type: row.type,
    orderId: row.orderId,
    merchantId: row.merchantId,
    occurredAt: row.occurredAt,
    payload: (row.payload ?? {}) as Record<string, unknown>,
  }));

  return toAuditChain(records);
}

/**
 * The rule-auditor (T15, PLAN §6): reads ONLY the audit log — the
 * `audit_events` rows, nothing else. Not app state, not scenario results, not
 * what any agent claims. It replays the log in `seq` order and *recomputes*
 * every guarantee from the logged payloads:
 *
 *   1. **No charge above Cap** — every `order.paid` is attributed to its Agent
 *      through the `payment.verified` event for that Order, and the running
 *      captured-minus-refunded total per Agent must never exceed the Cap that
 *      Agent's `agent.registered` event declared.
 *   2. **No charge without a complete verified mandate chain** — every charge
 *      must be preceded by `payment.verified`, whose `intentHash`/`cartHash`
 *      resolve to logged `mandate.intent_declared` / `mandate.cart_created`
 *      events of the *same* Agent, hash-linked Intent → Cart → Payment. The
 *      Cart's total is recomputed from its logged line items — a total the
 *      items do not add up to is a violation, not a rounding note. The charge
 *      must also sit within the Intent's logged Budget.
 *   3. **No duplicate charge per idempotency key** — at most one verified
 *      Payment mandate and at most one charge per (Agent, key). A
 *      `payment.replayed` is the sanctioned outcome for a retried key and must
 *      reference a key the log has seen verify.
 *   4. **Every Refusal has a reason code** — each `agent.refused`,
 *      `mandate.refused` and `payment.refused` event carries the structured
 *      `{code, reason, recoverable}` payload, machine-readable and non-empty.
 *
 * The auditor is deliberately strict: a payload missing a field it needs is a
 * violation, never a shrug — an unauditable charge is exactly what the audit
 * log exists to make impossible (ADR-0003: the log is complete by
 * construction, so incompleteness is evidence of a bug, not noise). It is
 * pure: rows in, report out — callable on the eval batch's exported log, a
 * JSONL file, or rows read straight from a database.
 */

/** The subset of an audit_events row the auditor consumes. */
export interface AuditableEvent {
  readonly seq: number;
  readonly type: string;
  readonly orderId: string | null;
  readonly payload: Record<string, unknown>;
}

export type ViolationCode =
  | 'CHARGE_ABOVE_CAP'
  | 'CHARGE_ABOVE_BUDGET'
  | 'CHARGE_WITHOUT_VERIFIED_CHAIN'
  | 'CHARGE_AMOUNT_INCONSISTENT'
  | 'DUPLICATE_CHARGE_FOR_IDEMPOTENCY_KEY'
  | 'DUPLICATE_CHARGE_FOR_ORDER'
  | 'REFUSAL_WITHOUT_REASON_CODE';

export interface Violation {
  readonly code: ViolationCode;
  /** The event that broke the guarantee. */
  readonly seq: number;
  readonly orderId: string | null;
  readonly detail: string;
}

export interface AuditReport {
  readonly eventsExamined: number;
  /** `order.paid` events audited — the charges. */
  readonly chargesAudited: number;
  /** Refusal events audited for a structured reason code. */
  readonly refusalsAudited: number;
  readonly agentsSeen: number;
  readonly violations: readonly Violation[];
}

const REFUSAL_EVENTS = new Set(['agent.refused', 'mandate.refused', 'payment.refused']);

function integer(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function nonEmptyString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

interface IntentSeen {
  readonly agentId: string | null;
  readonly budgetPaise: number | null;
}

interface CartSeen {
  readonly agentId: string | null;
  readonly intentHash: string | null;
  readonly totalAmountPaise: number | null;
  /** Recomputed from the logged line items; null when the items are unusable. */
  readonly recomputedTotalPaise: number | null;
}

interface VerifiedSeen {
  readonly seq: number;
  readonly agentId: string | null;
  readonly intentHash: string | null;
  readonly cartHash: string | null;
  readonly paymentHash: string | null;
  readonly amountPaise: number | null;
  readonly idempotencyKey: string | null;
}

function recomputeCartTotal(payload: Record<string, unknown>): number | null {
  const items = payload['items'];
  if (!Array.isArray(items) || items.length === 0) return null;
  let total = 0;
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) return null;
    const item = raw as Record<string, unknown>;
    const quantity = integer(item, 'quantity');
    const unitPricePaise = integer(item, 'unitPricePaise');
    if (quantity === null || quantity < 1 || unitPricePaise === null || unitPricePaise < 0) {
      return null;
    }
    total += quantity * unitPricePaise;
  }
  return Number.isSafeInteger(total) ? total : null;
}

export function auditRules(events: readonly AuditableEvent[]): AuditReport {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const violations: Violation[] = [];

  const capByAgent = new Map<string, number>();
  const intentsByHash = new Map<string, IntentSeen>();
  const cartsByHash = new Map<string, CartSeen>();
  const verifiedByOrder = new Map<string, VerifiedSeen>();
  /** (agentId, idempotencyKey) → seqs of payment.verified events. */
  const verifiedByKey = new Map<string, number[]>();
  /** (agentId, idempotencyKey) → orderIds already charged under the key. */
  const chargedByKey = new Map<string, string[]>();
  /** Running captured-minus-refunded paise per Agent. */
  const chargedByAgent = new Map<string, number>();
  const paidAmountByOrder = new Map<string, number>();
  const refundedOrders = new Set<string>();

  let chargesAudited = 0;
  let refusalsAudited = 0;

  const flag = (code: ViolationCode, event: AuditableEvent, detail: string): void => {
    violations.push({ code, seq: event.seq, orderId: event.orderId, detail });
  };

  for (const event of ordered) {
    switch (event.type) {
      case 'agent.registered': {
        const agentId = nonEmptyString(event.payload, 'agentId');
        const capPaise = integer(event.payload, 'capPaise');
        if (agentId !== null && capPaise !== null) capByAgent.set(agentId, capPaise);
        break;
      }

      case 'mandate.intent_declared': {
        const intentHash = nonEmptyString(event.payload, 'intentHash');
        if (intentHash !== null) {
          intentsByHash.set(intentHash, {
            agentId: nonEmptyString(event.payload, 'agentId'),
            budgetPaise: integer(event.payload, 'budgetPaise'),
          });
        }
        break;
      }

      case 'mandate.cart_created': {
        const cartHash = nonEmptyString(event.payload, 'cartHash');
        if (cartHash !== null) {
          cartsByHash.set(cartHash, {
            agentId: nonEmptyString(event.payload, 'agentId'),
            intentHash: nonEmptyString(event.payload, 'intentHash'),
            totalAmountPaise: integer(event.payload, 'totalAmountPaise'),
            recomputedTotalPaise: recomputeCartTotal(event.payload),
          });
        }
        break;
      }

      case 'payment.verified': {
        const seen: VerifiedSeen = {
          seq: event.seq,
          agentId: nonEmptyString(event.payload, 'agentId'),
          intentHash: nonEmptyString(event.payload, 'intentHash'),
          cartHash: nonEmptyString(event.payload, 'cartHash'),
          paymentHash: nonEmptyString(event.payload, 'paymentHash'),
          amountPaise: integer(event.payload, 'amountPaise'),
          idempotencyKey: nonEmptyString(event.payload, 'idempotencyKey'),
        };
        if (event.orderId === null) {
          flag('CHARGE_WITHOUT_VERIFIED_CHAIN', event, 'payment.verified names no Order');
          break;
        }
        verifiedByOrder.set(event.orderId, seen);
        if (seen.agentId !== null && seen.idempotencyKey !== null) {
          const key = `${seen.agentId}::${seen.idempotencyKey}`;
          const seqs = verifiedByKey.get(key) ?? [];
          seqs.push(event.seq);
          verifiedByKey.set(key, seqs);
          if (seqs.length > 1) {
            flag(
              'DUPLICATE_CHARGE_FOR_IDEMPOTENCY_KEY',
              event,
              `idempotency key ${seen.idempotencyKey} verified ${seqs.length} times for agent ` +
                `${seen.agentId} (previous at seq ${seqs[0]}) — one key must authorize at most one charge`,
            );
          }
        }
        break;
      }

      case 'payment.replayed': {
        const agentId = nonEmptyString(event.payload, 'agentId');
        const idempotencyKey = nonEmptyString(event.payload, 'idempotencyKey');
        if (agentId === null || idempotencyKey === null) {
          flag(
            'CHARGE_WITHOUT_VERIFIED_CHAIN',
            event,
            'payment.replayed carries no agentId/idempotencyKey to audit the replay against',
          );
          break;
        }
        if (!verifiedByKey.has(`${agentId}::${idempotencyKey}`)) {
          flag(
            'CHARGE_WITHOUT_VERIFIED_CHAIN',
            event,
            `replay of idempotency key ${idempotencyKey} that the log never saw verify`,
          );
        }
        break;
      }

      case 'order.paid': {
        chargesAudited += 1;
        const orderId = event.orderId;
        const amountPaise = integer(event.payload, 'amountPaise');

        if (orderId === null) {
          flag('CHARGE_WITHOUT_VERIFIED_CHAIN', event, 'a charge with no Order id is unattributable');
          break;
        }
        if (paidAmountByOrder.has(orderId)) {
          flag(
            'DUPLICATE_CHARGE_FOR_ORDER',
            event,
            `Order ${orderId} was already charged — a second order.paid is a second charge`,
          );
          break;
        }
        if (amountPaise === null || amountPaise <= 0) {
          flag(
            'CHARGE_AMOUNT_INCONSISTENT',
            event,
            'order.paid carries no positive integer amountPaise',
          );
          break;
        }
        paidAmountByOrder.set(orderId, amountPaise);

        const verified = verifiedByOrder.get(orderId);
        if (verified === undefined) {
          flag(
            'CHARGE_WITHOUT_VERIFIED_CHAIN',
            event,
            `no payment.verified precedes this charge on Order ${orderId}`,
          );
          break;
        }

        // --- Assert 2: the chain, recomputed from the log ------------------
        const intent = verified.intentHash === null ? undefined : intentsByHash.get(verified.intentHash);
        const cart = verified.cartHash === null ? undefined : cartsByHash.get(verified.cartHash);
        if (
          verified.agentId === null ||
          verified.paymentHash === null ||
          intent === undefined ||
          cart === undefined
        ) {
          flag(
            'CHARGE_WITHOUT_VERIFIED_CHAIN',
            event,
            `the chain behind Order ${orderId} is not fully on the log ` +
              `(intent ${intent === undefined ? 'missing' : 'seen'}, cart ${cart === undefined ? 'missing' : 'seen'})`,
          );
        } else {
          if (cart.intentHash !== verified.intentHash) {
            flag(
              'CHARGE_WITHOUT_VERIFIED_CHAIN',
              event,
              `Cart ${verified.cartHash} chains to Intent ${cart.intentHash}, not the verified Intent ${verified.intentHash}`,
            );
          }
          if (intent.agentId !== verified.agentId || cart.agentId !== verified.agentId) {
            flag(
              'CHARGE_WITHOUT_VERIFIED_CHAIN',
              event,
              `the chain behind Order ${orderId} spans more than one Agent`,
            );
          }
          if (
            cart.totalAmountPaise === null ||
            cart.recomputedTotalPaise === null ||
            cart.recomputedTotalPaise !== cart.totalAmountPaise ||
            verified.amountPaise !== cart.totalAmountPaise ||
            amountPaise !== cart.totalAmountPaise
          ) {
            flag(
              'CHARGE_AMOUNT_INCONSISTENT',
              event,
              `amounts disagree on Order ${orderId}: cart total ${cart.totalAmountPaise ?? '∅'}, ` +
                `recomputed from items ${cart.recomputedTotalPaise ?? '∅'}, ` +
                `verified ${verified.amountPaise ?? '∅'}, charged ${amountPaise}`,
            );
          }
          if (intent.budgetPaise === null || amountPaise > intent.budgetPaise) {
            flag(
              'CHARGE_ABOVE_BUDGET',
              event,
              `charge of ${amountPaise} paise on Order ${orderId} exceeds the Intent's logged Budget ` +
                `${intent.budgetPaise ?? '∅'}`,
            );
          }
        }

        // --- Assert 3: one charge per idempotency key ----------------------
        if (verified.agentId !== null) {
          if (verified.idempotencyKey === null) {
            flag(
              'CHARGE_WITHOUT_VERIFIED_CHAIN',
              event,
              `the charge on Order ${orderId} was verified with no idempotency key on the log`,
            );
          } else {
            const key = `${verified.agentId}::${verified.idempotencyKey}`;
            const charged = chargedByKey.get(key) ?? [];
            charged.push(orderId);
            chargedByKey.set(key, charged);
            if (charged.length > 1) {
              flag(
                'DUPLICATE_CHARGE_FOR_IDEMPOTENCY_KEY',
                event,
                `idempotency key ${verified.idempotencyKey} charged twice: Orders ${charged.join(', ')}`,
              );
            }
          }

          // --- Assert 1: the Cap, as a running total -----------------------
          const capPaise = capByAgent.get(verified.agentId);
          if (capPaise === undefined) {
            flag(
              'CHARGE_WITHOUT_VERIFIED_CHAIN',
              event,
              `the charge on Order ${orderId} is attributed to Agent ${verified.agentId}, ` +
                'whose registration (and Cap) is not on the log',
            );
          } else {
            const charged = (chargedByAgent.get(verified.agentId) ?? 0) + amountPaise;
            chargedByAgent.set(verified.agentId, charged);
            if (charged > capPaise) {
              flag(
                'CHARGE_ABOVE_CAP',
                event,
                `Agent ${verified.agentId} has ${charged} paise captured against a Cap of ` +
                  `${capPaise} paise after Order ${orderId}`,
              );
            }
          }
        }
        break;
      }

      case 'order.refunded': {
        const orderId = event.orderId;
        const refunded = integer(event.payload, 'amountPaise');
        if (orderId === null || refunded === null || refundedOrders.has(orderId)) break;
        const verified = verifiedByOrder.get(orderId);
        if (verified?.agentId !== undefined && verified.agentId !== null) {
          refundedOrders.add(orderId);
          chargedByAgent.set(
            verified.agentId,
            (chargedByAgent.get(verified.agentId) ?? 0) - refunded,
          );
        }
        break;
      }

      case 'receipt.issued': {
        // A Receipt is the merchant's sworn statement about a charge; a
        // Receipt contradicting the verified chain is an inconsistency even
        // though "issue a Receipt" is not itself one of the four asserts.
        const orderId = event.orderId;
        const verified = orderId === null ? undefined : verifiedByOrder.get(orderId);
        if (verified === undefined) {
          flag(
            'CHARGE_WITHOUT_VERIFIED_CHAIN',
            event,
            `a Receipt was issued for Order ${orderId ?? '∅'} with no verified chain on the log`,
          );
          break;
        }
        const matches =
          nonEmptyString(event.payload, 'intentHash') === verified.intentHash &&
          nonEmptyString(event.payload, 'cartHash') === verified.cartHash &&
          nonEmptyString(event.payload, 'paymentHash') === verified.paymentHash &&
          integer(event.payload, 'amountPaise') === verified.amountPaise &&
          nonEmptyString(event.payload, 'gatewayPaymentId') !== null;
        if (!matches) {
          flag(
            'CHARGE_AMOUNT_INCONSISTENT',
            event,
            `the Receipt for Order ${orderId ?? '∅'} does not restate the verified chain it attests`,
          );
        }
        break;
      }

      default: {
        if (REFUSAL_EVENTS.has(event.type)) {
          refusalsAudited += 1;
          const code = nonEmptyString(event.payload, 'code');
          const reason = nonEmptyString(event.payload, 'reason');
          const recoverable = event.payload['recoverable'];
          if (code === null || reason === null || typeof recoverable !== 'boolean') {
            flag(
              'REFUSAL_WITHOUT_REASON_CODE',
              event,
              `${event.type} lacks the structured {code, reason, recoverable} payload`,
            );
          }
        }
        break;
      }
    }
  }

  return {
    eventsExamined: ordered.length,
    chargesAudited,
    refusalsAudited,
    agentsSeen: capByAgent.size,
    violations,
  };
}

/** Render an AuditReport for terminals and CI logs. */
export function formatAuditReport(report: AuditReport): string {
  const lines: string[] = [
    `Rule-auditor: ${report.eventsExamined} audit events examined — ` +
      `${report.chargesAudited} charges, ${report.refusalsAudited} refusals, ` +
      `${report.agentsSeen} agents.`,
    '  Asserts, recomputed from the log alone:',
    '    1. no charge above Cap',
    '    2. no charge without a complete verified mandate chain (totals recomputed from logged items)',
    '    3. no duplicate charge per idempotency key',
    '    4. every Refusal has a structured reason code',
  ];
  if (report.violations.length === 0) {
    lines.push('  VIOLATIONS: 0');
  } else {
    lines.push(`  VIOLATIONS: ${report.violations.length}`);
    for (const violation of report.violations) {
      lines.push(`    ✗ [${violation.code}] seq ${violation.seq}: ${violation.detail}`);
    }
  }
  return lines.join('\n');
}

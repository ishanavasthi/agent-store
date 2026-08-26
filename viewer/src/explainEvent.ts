/**
 * The "why allowed / why refused" line for every audit event type — the story
 * layer the T7 ticket asks for, rendered client-side so the server JSON stays
 * stable for the rule-auditor.
 *
 * Covers every member of AuditEventType (src/domain/auditEvents.ts). Payloads
 * arrive as untrusted JSON, so every field access degrades gracefully; an
 * unknown or future event type gets a neutral explanation, never a crash.
 */

import { displayPaise } from './money';

export type Verdict = 'allowed' | 'refused' | 'anomaly' | 'note';

export interface Explanation {
  readonly verdict: Verdict;
  /** The stamped ruling, e.g. "WHY ALLOWED". Empty for plain notes. */
  readonly label: string;
  readonly line: string;
  /** A second sentence when the ruling needs one (recoverability, retry). */
  readonly detail?: string;
}

const str = (payload: Record<string, unknown>, key: string): string | null => {
  const value = payload[key];
  return typeof value === 'string' ? value : null;
};

const bool = (payload: Record<string, unknown>, key: string): boolean | null => {
  const value = payload[key];
  return typeof value === 'boolean' ? value : null;
};

/** "1,29,900 paise (₹1,299.00)" — the paise integer always leads. */
const money = (payload: Record<string, unknown>, key: string): string => {
  const shown = displayPaise(payload[key]);
  return shown.rupees === null ? shown.paise : `${shown.paise} (${shown.rupees})`;
};

/** Shared by agent.refused / payment.refused / mandate.refused. */
function refusalExplanation(payload: Record<string, unknown>): Explanation {
  const code = str(payload, 'code') ?? 'UNKNOWN_CODE';
  const reason = str(payload, 'reason') ?? 'no reason recorded';
  const recoverable = bool(payload, 'recoverable');
  const detail =
    recoverable === null
      ? undefined
      : recoverable
        ? 'Recoverable — the Agent can adjust its request and try again.'
        : 'Not recoverable — this exact request can never succeed; the Agent must start over.';
  return {
    verdict: 'refused',
    label: 'Why refused',
    line: `${code} — ${reason}`,
    ...(detail === undefined ? {} : { detail }),
  };
}

export function explainEvent(type: string, payload: Record<string, unknown>): Explanation {
  switch (type) {
    case 'agent.registered': {
      const custody = str(payload, 'custody');
      return {
        verdict: 'note',
        label: '',
        line:
          `A new Agent identity was minted${custody === null ? '' : ` (${custody} custody)`}, ` +
          `with a spend Cap of ${money(payload, 'capPaise')} fixed for this registration's lifetime.`,
      };
    }

    case 'agent.refused':
    case 'payment.refused':
    case 'mandate.refused':
      return refusalExplanation(payload);

    case 'mandate.intent_declared': {
      const want = str(payload, 'want');
      return {
        verdict: 'note',
        label: '',
        line:
          `The chain's root: the Agent signed its want` +
          `${want === null ? '' : ` — “${want}” —`} with a Budget of ` +
          `${money(payload, 'budgetPaise')}. No money can move except under this Intent, and it authorizes at most one purchase.`,
      };
    }

    case 'mandate.cart_created':
      return {
        verdict: 'note',
        label: '',
        line:
          `Both sides signed an immutable snapshot of exact items totalling ` +
          `${money(payload, 'totalAmountPaise')}, with the catalog price pinned by hash — ` +
          `a later price change refuses instead of surprising the buyer.`,
      };

    case 'payment.verified':
      return {
        verdict: 'allowed',
        label: 'Why allowed',
        line:
          `Mandate chain verified — Intent → Cart → Payment hashes bind, signatures check out, ` +
          `and the total of ${money(payload, 'amountPaise')} sits within both the Intent's Budget and the Agent's Cap.`,
      };

    case 'order.created':
      return {
        verdict: 'note',
        label: '',
        line:
          `The domain Order now exists — created only after the trust gate passed, ` +
          `for ${money(payload, 'amountPaise')} of verified cart items.`,
      };

    case 'gateway.payment_link_attempted':
      return {
        verdict: 'note',
        label: '',
        line:
          `Recorded before Razorpay was called, for ${money(payload, 'amountPaise')} — ` +
          `if the process died mid-request the ledger would show an attempt with no outcome, which is a fact, not a gap.`,
      };

    case 'gateway.payment_link_issued':
      return {
        verdict: 'note',
        label: '',
        line: `Razorpay issued the Payment Link for the human consent step — ${money(payload, 'amountPaise')} to approve.`,
      };

    case 'gateway.webhook_received': {
      const matched = bool(payload, 'matched');
      return {
        verdict: 'note',
        label: '',
        line:
          matched === false
            ? 'A signed webhook verified but matched no Order — recorded rather than dropped, so nothing arrives silently.'
            : 'A signed webhook from the gateway verified and was matched to this Order.',
      };
    }

    case 'gateway.order_linked': {
      const id = str(payload, 'gatewayOrderId');
      return {
        verdict: 'note',
        label: '',
        line:
          `Razorpay's own gateway order id${id === null ? '' : ` (${id})`} recorded against this Order — ` +
          `learned from the webhook, never trusted at checkout time.`,
      };
    }

    case 'order.paid':
      return {
        verdict: 'allowed',
        label: 'Why allowed',
        line:
          `The gateway's signed webhook reported ${money(payload, 'amountPaise')} paid, and that amount ` +
          `matched the Order exactly — only then was the Order marked paid.`,
      };

    case 'order.anomaly_detected': {
      const reason = str(payload, 'reason') ?? 'unrecorded reason';
      return {
        verdict: 'anomaly',
        label: 'Why not acted on',
        line: `${reason} — something arrived that could not safely be acted on, so the Order was deliberately left exactly as it was.`,
      };
    }

    case 'receipt.issued':
      return {
        verdict: 'allowed',
        label: 'Proof issued',
        line:
          `The Merchant signed a Receipt binding the Intent, Cart and Payment hashes to the gateway charge ` +
          `for ${money(payload, 'amountPaise')} — the purchase is now attestable end-to-end.`,
      };

    case 'payment.replayed':
      return {
        verdict: 'allowed',
        label: 'Why no second charge',
        line:
          `Same idempotency key with the same cart hash — the original result was replayed: ` +
          `no new Order, and the gateway was never contacted again.`,
      };

    default:
      return {
        verdict: 'note',
        label: '',
        line: 'No explainer for this event type yet — its summary and raw payload are shown verbatim below.',
      };
  }
}

import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { agents, type AgentRow } from '../db/schema.js';
import { appendAuditEvent } from './auditLog.js';
import { newId } from './ids.js';
import { generateSigningKeypair } from './keys.js';
import { moneyView, paise, type MoneyView, type Paise } from './money.js';
import { Refusal, ValidationError } from './refusal.js';

/**
 * Agent registration — the trust layer's front door (T3).
 *
 * An Agent IS its registration (ADR-0001): `registerAgent` mints, in one
 * transaction, a custodial Ed25519 keypair, a bearer token, and the
 * buyer-declared Cap — and that row never changes afterwards. Re-registering
 * mints a *new* Agent with a fresh Cap; Sybil cap-bypass is the documented v1
 * non-goal (README → Threat model note).
 *
 * Custody note: the token is stored plaintext, deliberately. The same row
 * already holds the Agent's private key — the whole point of custodial keys is
 * that the server keeps the secrets — so hashing the token at rest would
 * protect one secret sitting beside an unprotected one.
 */

const AGENT_TOKEN_PREFIX = 'agt_tok_';

/**
 * 256-bit bearer token. Prefixed like the ids (`agt_tok_` vs the Agent id's
 * `agt_`) so a token pasted into a log or a prompt is visually recognizable —
 * and never mistaken for an agent id.
 */
export function newAgentToken(): string {
  return `${AGENT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/**
 * A Cap that is not a positive integer number of paise is a malformed request —
 * a validation error, never a Refusal (CONTEXT.md → Failure vocabulary). No
 * float is silently rounded: `4999.5` is rejected, not normalized, so the
 * number stored is always exactly the number the buyer declared. Zero is
 * rejected too — a ceiling that authorizes nothing is a mistake worth
 * surfacing at registration, not at first checkout.
 */
export function capPaiseFromInput(value: number): Paise {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError(
      'INVALID_CAP',
      `Cap must be a positive integer number of paise (e.g. 500000 = ₹5,000.00), got: ${String(value)}`,
    );
  }
  return paise(value);
}

export interface RegisterAgentInput {
  /** Buyer-declared per-merchant spend ceiling, integer paise. */
  readonly capPaise: number;
}

/** What the buyer gets back. The custodial private key never leaves the server. */
export interface AgentRegistration {
  readonly agentId: string;
  /** Present this as `agentToken` on every subsequent tool call. */
  readonly agentToken: string;
  /** The Agent's Ed25519 public key (base64 SPKI DER). */
  readonly publicKey: string;
  readonly cap: MoneyView;
  readonly createdAt: string;
}

export async function registerAgent(
  db: Database,
  merchantId: string,
  input: RegisterAgentInput,
): Promise<AgentRegistration> {
  const cap = capPaiseFromInput(input.capPaise);
  const agentId = newId('agent');
  const agentToken = newAgentToken();
  const keypair = generateSigningKeypair();

  // ADR-0003: the Agent row and its `agent.registered` event commit together.
  // The payload carries no secret — the public key, never the token or the
  // private key, because the audit log is served over HTTP.
  const [inserted] = await db.transaction(async (tx) => {
    const rows = await tx
      .insert(agents)
      .values({
        id: agentId,
        merchantId,
        token: agentToken,
        publicKey: keypair.publicKey,
        privateKey: keypair.privateKey,
        capPaise: cap,
      })
      .returning();
    await appendAuditEvent(tx, {
      type: 'agent.registered',
      merchantId,
      orderId: null,
      payload: { agentId, capPaise: cap, publicKey: keypair.publicKey },
    });
    return rows;
  });
  if (inserted === undefined) {
    throw new Error(`Agent insert for ${agentId} returned no row`);
  }

  return {
    agentId,
    agentToken,
    publicKey: keypair.publicKey,
    cap: moneyView(cap),
    createdAt: inserted.createdAt.toISOString(),
  };
}

/**
 * The token gate. Resolves a presented token to its Agent row, or refuses with
 * `UNREGISTERED_AGENT` — writing the `agent.refused` audit event first, in its
 * own transaction (the audit-only-write precedent of
 * `gateway.payment_link_attempted`), with `orderId: null` because no Order
 * exists to attribute it to. Recoverable: the buyer can call `register_agent`
 * and try again.
 *
 * Runs strictly before any domain state changes and before the gateway is ever
 * touched, so this Refusal always means zero money moved. The presented token
 * itself is never written to the audit log — an *almost*-valid token is still
 * a secret-shaped string.
 */
export async function requireRegisteredAgent(
  db: Database,
  merchantId: string,
  agentToken: string | undefined,
  tool: string,
): Promise<AgentRow> {
  const presented = agentToken?.trim() ?? '';
  if (presented !== '') {
    // Equality via the unique index; a 256-bit random token makes the lookup
    // itself the constant-time comparison that matters here.
    const [row] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.token, presented), eq(agents.merchantId, merchantId)))
      .limit(1);
    if (row !== undefined) return row;
  }

  const refusal = new Refusal({
    code: 'UNREGISTERED_AGENT',
    reason:
      presented === ''
        ? `${tool} requires an agentToken. Call register_agent to mint one, then retry with it.`
        : `agentToken matches no registered Agent. Call register_agent to mint a new one, then retry.`,
    recoverable: true,
  });

  await db.transaction(async (tx) => {
    await appendAuditEvent(tx, {
      type: 'agent.refused',
      merchantId,
      orderId: null,
      payload: {
        code: refusal.code,
        reason: refusal.reason,
        recoverable: refusal.recoverable,
        tool,
        tokenPresented: presented !== '',
      },
    });
  });

  throw refusal;
}

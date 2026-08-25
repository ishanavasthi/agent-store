import { and, eq } from 'drizzle-orm';
import type { Executor, Transaction } from '../db/client.js';
import { cartMandates, merchants, paymentMandates, receipts } from '../db/schema.js';
import type { AnomalyReason } from './auditEvents.js';
import { appendAuditEvent } from './auditLog.js';
import { newId } from './ids.js';
import { hashMandate, parseReceiptPayload, signMandate, type ReceiptPayload } from './mandates.js';
import { paise } from './money.js';

/**
 * Receipt composition and minting (CONTEXT.md → Receipt): the merchant-signed
 * proof that one verified mandate chain became one paid Order.
 *
 * `mintReceiptForPaidOrder` takes a `Transaction` on purpose — a Receipt is
 * only ever minted inside the same transaction as the `order.paid` event it
 * proves (ADR-0003), from the one code path that won the one-way paid
 * transition in `applyGatewayWebhook`. That caller's `WHERE status <> 'paid'`
 * guard is what makes minting exactly-once; nothing here re-checks it.
 */

export interface MintReceiptParams {
  readonly merchantId: string;
  readonly orderId: string;
  /** The gateway-reported amount, already asserted equal to the Order's. */
  readonly amountPaise: number;
  /** Best-known gateway payment id: webhook first, then the Order row. */
  readonly gatewayPaymentId: string | null;
  readonly issuedAt: Date;
  /** For anomaly-event payload parity with the rest of the webhook path. */
  readonly gatewayName: string;
  readonly gatewayEvent: string;
}

/**
 * Mint the Receipt for a just-paid Order, if it is mandate-backed. A pre-T4
 * Order has no Payment mandate and silently gets none — there is no chain to
 * attest (DECISIONS 2026-08-26).
 *
 * Two conditions make the Receipt unmintable without making the payment less
 * real; each records an `order.anomaly_detected` instead of throwing, because
 * this runs on the webhook path where a throw means endless redelivery:
 *   - no merchant signing key (a provisioning gap), and
 *   - no gateway payment id from any source — a Receipt attests *which charge*
 *     the chain produced, and a blank binding must never be signed.
 */
export async function mintReceiptForPaidOrder(
  tx: Transaction,
  params: MintReceiptParams,
): Promise<void> {
  const [paymentMandate] = await tx
    .select()
    .from(paymentMandates)
    .where(eq(paymentMandates.orderId, params.orderId))
    .limit(1);
  if (paymentMandate === undefined) return;

  const anomaly = async (reason: AnomalyReason, detail: string): Promise<void> => {
    await appendAuditEvent(tx, {
      type: 'order.anomaly_detected',
      merchantId: params.merchantId,
      orderId: params.orderId,
      payload: {
        gateway: params.gatewayName,
        gatewayEvent: params.gatewayEvent,
        reason,
        detail,
      },
    });
  };

  const [merchantRow] = await tx
    .select({ signingPrivateKey: merchants.signingPrivateKey })
    .from(merchants)
    .where(eq(merchants.id, params.merchantId))
    .limit(1);
  if (merchantRow === undefined || merchantRow.signingPrivateKey === null) {
    return anomaly(
      'missing_merchant_signing_key',
      'Order paid but no merchant signing key exists to mint its Receipt',
    );
  }
  if (params.gatewayPaymentId === null) {
    return anomaly(
      'missing_gateway_payment_id',
      'Order paid but no gateway payment id was reported to bind its Receipt to',
    );
  }

  const [cartRow] = await tx
    .select({ intentHash: cartMandates.intentHash })
    .from(cartMandates)
    .where(eq(cartMandates.hash, paymentMandate.cartHash))
    .limit(1);
  if (cartRow === undefined) {
    // Impossible by construction: submit_payment only stores a Payment
    // mandate after resolving its Cart row. A miss means the mandate store
    // was mutilated out-of-band — fail loudly, don't sign fiction.
    throw new Error(
      `Payment mandate ${paymentMandate.id} references no stored Cart mandate ${paymentMandate.cartHash}`,
    );
  }

  const payload: ReceiptPayload = {
    orderId: params.orderId,
    intentHash: cartRow.intentHash,
    cartHash: paymentMandate.cartHash,
    paymentHash: paymentMandate.hash,
    amountPaise: paise(params.amountPaise),
    gatewayPaymentId: params.gatewayPaymentId,
    issuedAt: params.issuedAt.toISOString(),
  };
  const receiptHash = hashMandate(payload);
  const merchantSignature = signMandate(merchantRow.signingPrivateKey, payload);
  await tx.insert(receipts).values({
    id: newId('receipt'),
    merchantId: params.merchantId,
    orderId: params.orderId,
    payload,
    hash: receiptHash,
    merchantSignature,
  });
  await appendAuditEvent(tx, {
    type: 'receipt.issued',
    merchantId: params.merchantId,
    orderId: params.orderId,
    payload: {
      receiptHash,
      intentHash: payload.intentHash,
      cartHash: payload.cartHash,
      paymentHash: payload.paymentHash,
      amountPaise: payload.amountPaise,
      gatewayPaymentId: payload.gatewayPaymentId,
    },
  });
}

/**
 * The Receipt as the buyer retrieves it: payload, detached merchant signature,
 * and the merchant public key — everything an independent verifier needs
 * (`verifyMessage(merchantPublicKey, canonicalJson(payload), signature)`),
 * because no other endpoint publishes the key yet.
 */
export interface OrderReceiptView {
  readonly payload: ReceiptPayload;
  readonly signature: string;
  readonly merchantPublicKey: string;
}

export async function findOrderReceipt(
  executor: Executor,
  merchantId: string,
  orderId: string,
): Promise<OrderReceiptView | null> {
  const rows = await executor
    .select({
      payload: receipts.payload,
      signature: receipts.merchantSignature,
      merchantPublicKey: merchants.signingPublicKey,
    })
    .from(receipts)
    .innerJoin(merchants, eq(receipts.merchantId, merchants.id))
    .where(and(eq(receipts.orderId, orderId), eq(receipts.merchantId, merchantId)))
    .limit(1);
  const row = rows[0];
  if (row === undefined || row.merchantPublicKey === null) return null;
  return {
    payload: parseReceiptPayload(row.payload),
    signature: row.signature,
    merchantPublicKey: row.merchantPublicKey,
  };
}

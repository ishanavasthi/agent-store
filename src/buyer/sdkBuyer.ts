import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  parseCartMandatePayload,
  parseReceiptPayload,
  verifyMandateSignature,
  type CartMandatePayload,
  type IntentMandatePayload,
  type PaymentMandatePayload,
  type ReceiptPayload,
} from '../domain/mandates.js';
import { LocalSigner, type SignedMandate } from './localSigner.js';

/**
 * The scripted non-custodial buyer (T6): drives one full purchase through the
 * MCP protocol surface — the same tools every buyer uses — while holding its
 * Ed25519 key client-side and signing every agent-side mandate locally
 * (ADR-0004). The server sees the public key at registration and signatures
 * thereafter; the private key never leaves the `LocalSigner`.
 *
 * Deliberately not an LLM: T16's live Claude-as-buyer runs ride this same
 * machinery over Streamable HTTP; here the flow is scripted so the protocol
 * capability is provable deterministically. The buyer works against any
 * connected MCP `Client` — an in-process `InMemoryTransport` pair in the
 * integration suite, a remote endpoint later.
 *
 * The buyer is also its own verifier: it checks that every hash the server
 * returns matches the one it computed locally over the same bytes, and it
 * verifies the merchant-signed Receipt independently — nothing is taken on
 * the server's word.
 */

/** A tool call the buyer could not proceed past: an isError result. */
export class SdkBuyerError extends Error {
  readonly tool: string;
  /** The structured wire body — `{refusal}` or `{validationError}`. */
  readonly body: Record<string, unknown>;

  constructor(tool: string, body: Record<string, unknown>) {
    super(`${tool} failed: ${JSON.stringify(body)}`);
    this.name = 'SdkBuyerError';
    this.tool = tool;
    this.body = body;
  }
}

/** The consent step handed to the caller: make this payment link paid. */
export interface PaymentLinkView {
  readonly orderId: string;
  readonly paymentLinkUrl: string;
  readonly gatewayPaymentLinkId: string;
}

export interface SdkBuyerConfig {
  /** Cap declared at registration, integer paise. */
  readonly capPaise: number;
  readonly want: string;
  /** Budget for this Intent, integer paise. */
  readonly budgetPaise: number;
  readonly items: ReadonlyArray<{ readonly variantId: string; readonly quantity: number }>;
  /**
   * The human-consent step, injected: given the issued payment link, cause it
   * to be paid (the integration suite completes it on the stub gateway and
   * delivers the webhooks; T16's live runs hand it to a payer-bot).
   */
  readonly approvePayment: (payment: PaymentLinkView) => Promise<void>;
  /** get_order_status polling until `paid`. Defaults: 20 polls, 500ms apart. */
  readonly pollIntervalMs?: number;
  readonly maxPolls?: number;
}

/** Everything the buyer holds at the end — its own copy of the whole chain. */
export interface SdkBuyerPurchase {
  readonly agentId: string;
  readonly agentToken: string;
  readonly merchantId: string;
  readonly intent: SignedMandate<IntentMandatePayload>;
  readonly cart: SignedMandate<CartMandatePayload>;
  readonly merchantCartSignature: string;
  readonly payment: SignedMandate<PaymentMandatePayload>;
  readonly idempotencyKey: string;
  readonly orderId: string;
  readonly receipt: {
    readonly payload: ReceiptPayload;
    readonly signature: string;
    readonly merchantPublicKey: string;
  };
}

/** One tool call over the wire, with the JSON body parsed back out. */
async function callTool(
  client: Client,
  tool: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name: tool, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  const body = JSON.parse(content[0]!.text) as Record<string, unknown>;
  if (result.isError === true) {
    throw new SdkBuyerError(tool, body);
  }
  return body;
}

function expectString(body: Record<string, unknown>, key: string, tool: string): string {
  const value = body[key];
  if (typeof value !== 'string') {
    throw new SdkBuyerError(tool, { unexpectedShape: `missing string ${key}`, ...body });
  }
  return value;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run one full non-custodial purchase: generate nothing server-side —
 * register with the signer's public key, sign Intent, Cart, and Payment
 * locally, hand the payment link to `approvePayment`, and poll until the
 * merchant-signed Receipt arrives and independently verifies.
 */
export async function runSdkBuyerPurchase(
  client: Client,
  signer: LocalSigner,
  config: SdkBuyerConfig,
): Promise<SdkBuyerPurchase> {
  // 1. Register with the client-generated public key. The private key stays
  //    in the LocalSigner; the token is the identity every later call carries.
  const registration = await callTool(client, 'register_agent', {
    capPaise: config.capPaise,
    publicKey: signer.publicKey,
  });
  const agentId = expectString(registration, 'agentId', 'register_agent');
  const agentToken = expectString(registration, 'agentToken', 'register_agent');
  const merchantId = expectString(registration, 'merchantId', 'register_agent');

  // 2. Declare the Intent — composed and signed here, minted createdAt and
  //    all; the server recomposes the same payload and verifies our signature.
  const intent = signer.composeIntent({
    agentId,
    merchantId,
    want: config.want,
    budgetPaise: config.budgetPaise,
  });
  const declared = await callTool(client, 'declare_intent', {
    agentToken,
    want: intent.payload.want,
    budgetPaise: intent.payload.budgetPaise,
    createdAt: intent.payload.createdAt,
    signature: intent.signature,
  });
  if (declared['intentHash'] !== intent.hash) {
    throw new SdkBuyerError('declare_intent', {
      unexpectedShape: `server intentHash ${String(declared['intentHash'])} != local ${intent.hash}`,
    });
  }

  // 3. Create the Cart. The server pins prices and composes the payload; we
  //    parse it, check it is OUR chain (intentHash) with OUR identity, then
  //    sign that exact payload locally — the deferred agent-side signature.
  const cartBody = await callTool(client, 'create_cart', {
    agentToken,
    intentHash: intent.hash,
    items: config.items.map((item) => ({ ...item })),
  });
  const cartPayload = parseCartMandatePayload(cartBody['payload']);
  const cart = signer.signCart(cartPayload);
  if (
    cartBody['cartHash'] !== cart.hash ||
    cartPayload.intentHash !== intent.hash ||
    cartPayload.agentId !== agentId ||
    cartPayload.merchantId !== merchantId
  ) {
    throw new SdkBuyerError('create_cart', {
      unexpectedShape: 'cart payload does not match the chain this buyer is building',
      ...cartBody,
    });
  }
  const merchantCartSignature = expectString(cartBody, 'merchantSignature', 'create_cart');

  // 4. Submit the Payment — locally signed over the cartHash, carrying the
  //    cart signature from step 3 and a freshly minted idempotency key.
  const idempotencyKey = randomUUID();
  const payment = signer.composePayment({
    agentId,
    merchantId,
    cartHash: cart.hash,
    idempotencyKey,
  });
  const submitted = await callTool(client, 'submit_payment', {
    agentToken,
    cartHash: cart.hash,
    idempotencyKey,
    cartSignature: cart.signature,
    paymentCreatedAt: payment.payload.createdAt,
    paymentSignature: payment.signature,
  });
  const orderId = expectString(submitted, 'orderId', 'submit_payment');
  const paymentMandate = submitted['paymentMandate'] as Record<string, unknown> | undefined;
  if (paymentMandate?.['paymentHash'] !== payment.hash) {
    throw new SdkBuyerError('submit_payment', {
      unexpectedShape: `server paymentHash != local ${payment.hash}`,
      ...submitted,
    });
  }

  // 5. The consent step — the only way money moves.
  await config.approvePayment({
    orderId,
    paymentLinkUrl: expectString(submitted, 'paymentLinkUrl', 'submit_payment'),
    gatewayPaymentLinkId: expectString(submitted, 'gatewayPaymentLinkId', 'submit_payment'),
  });

  // 6. Poll for `paid`, then verify the Receipt independently: merchant public
  //    key + canonical payload + signature, and the payload must name exactly
  //    the three mandates this buyer signed or countersigned.
  const maxPolls = config.maxPolls ?? 20;
  const pollIntervalMs = config.pollIntervalMs ?? 500;
  for (let attempt = 1; attempt <= maxPolls; attempt += 1) {
    const status = await callTool(client, 'get_order_status', { agentToken, orderId });
    if (status['status'] === 'paid') {
      const receiptBody = status['receipt'] as Record<string, unknown> | null;
      if (receiptBody === null || receiptBody === undefined) {
        throw new SdkBuyerError('get_order_status', {
          unexpectedShape: 'paid Order without a Receipt',
          ...status,
        });
      }
      const receiptPayload = parseReceiptPayload(receiptBody['payload']);
      const signature = expectString(receiptBody, 'signature', 'get_order_status');
      const merchantPublicKey = expectString(receiptBody, 'merchantPublicKey', 'get_order_status');
      const receiptValid =
        verifyMandateSignature(merchantPublicKey, receiptPayload, signature) &&
        receiptPayload.orderId === orderId &&
        receiptPayload.intentHash === intent.hash &&
        receiptPayload.cartHash === cart.hash &&
        receiptPayload.paymentHash === payment.hash;
      if (!receiptValid) {
        throw new SdkBuyerError('get_order_status', {
          unexpectedShape: 'Receipt failed independent verification against the mandate chain',
          receipt: receiptBody,
        });
      }
      return {
        agentId,
        agentToken,
        merchantId,
        intent,
        cart,
        merchantCartSignature,
        payment,
        idempotencyKey,
        orderId,
        receipt: { payload: receiptPayload, signature, merchantPublicKey },
      };
    }
    if (attempt < maxPolls) await sleep(pollIntervalMs);
  }
  throw new SdkBuyerError('get_order_status', {
    unexpectedShape: `Order ${orderId} not paid after ${maxPolls} polls`,
  });
}

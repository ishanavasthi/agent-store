import { Router, json, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { MERCHANT_NAME } from '../config.js';
import type { StorefrontDeps } from '../deps.js';
import { registerAgent, requireRegisteredAgent } from '../domain/agents.js';
import { listPublishedVariants } from '../domain/catalog.js';
import { createCart, declareIntent } from '../domain/mandateFlow.js';
import { readOrderStatus } from '../domain/orderStatus.js';
import { Refusal, ValidationError } from '../domain/refusal.js';
import { submitPayment } from '../domain/submitPayment.js';

/**
 * The ACP-flavored REST face of the storefront core (T14, PLAN §3/§4).
 *
 * A thin *second face* over exactly the same core the MCP tools call: every
 * handler is `parse body → requireRegisteredAgent → one domain call → the same
 * response body the MCP tool serializes`. No trust-layer or enforcement logic
 * lives here — a Refusal raised by the core reaches the wire byte-identical on
 * both faces, and each handler passes the *MCP operation name* to
 * `requireRegisteredAgent` so refusal reasons and `agent.refused` audit events
 * speak one vocabulary regardless of which door the buyer came through.
 *
 * "ACP-flavored" is the dialect, not the spec: resource-noun endpoints,
 * `Authorization: Bearer <agentToken>`, an `Idempotency-Key` header, JSON in
 * and out, `201` for created resources. The mandate chain stays ours (AP2
 * vocabulary), so this face mirrors the MCP tools' inputs/outputs one-to-one
 * rather than adopting ACP's checkout_sessions model.
 *
 * Failure vocabulary on the wire (identical bodies to the MCP face):
 *   - Refusal          → HTTP 403, `{ refusal: {code, reason, recoverable, retryAfter?} }`
 *   - Validation error → HTTP 400, `{ validationError: {code, message} }`
 *                        (404 when the code is ORDER_NOT_FOUND — a GET miss)
 *   - Malformed body   → HTTP 400, `{ error: 'invalid_request', issues }` —
 *                        the transport saying no, the counterpart of an MCP
 *                        schema rejection, deliberately *not* a ValidationError.
 */

export const REST_BASE_PATH = '/acp';
export const DISCOVERY_PATH = '/.well-known/agent-store.json';

// ---------------------------------------------------------------------------
// Input schemas — the same fields, types and optionality as the MCP tools'
// inputSchema (src/mcp/server.ts). Descriptions live in the discovery doc.
// ---------------------------------------------------------------------------

const registerBody = z.object({
  capPaise: z.number(),
  publicKey: z.string().optional(),
});

const intentBody = z.object({
  agentToken: z.string().optional(),
  want: z.string(),
  budgetPaise: z.number(),
  createdAt: z.string().optional(),
  signature: z.string().optional(),
});

const cartBody = z.object({
  agentToken: z.string().optional(),
  intentHash: z.string(),
  items: z
    .array(z.object({ variantId: z.string(), quantity: z.number().int().min(1) }))
    .min(1),
});

const paymentBody = z.object({
  agentToken: z.string().optional(),
  cartHash: z.string(),
  idempotencyKey: z.string().min(1).optional(),
  cartSignature: z.string().optional(),
  paymentCreatedAt: z.string().optional(),
  paymentSignature: z.string().optional(),
});

/** `Authorization: Bearer <agentToken>` is canonical; a body `agentToken` also works. */
function bearerToken(req: Request): string | undefined {
  const header = req.get('authorization');
  if (header !== undefined && /^bearer\s+/i.test(header)) {
    const token = header.replace(/^bearer\s+/i, '').trim();
    if (token !== '') return token;
  }
  return undefined;
}

function parseBody<Schema extends z.ZodType>(
  schema: Schema,
  req: Request,
  res: Response,
): z.output<Schema> | null {
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: 'invalid_request',
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
    return null;
  }
  return parsed.data;
}

export function createRestRouter(deps: StorefrontDeps): Router {
  const router = Router();
  // Self-sufficient: the router parses its own JSON so mounting order in
  // app.ts (webhook raw-body first!) can never silently break this face.
  router.use(json({ limit: '4mb' }));

  // --- Catalog — public, like the MCP get_product tool: a shop window ------
  router.get('/products', async (_req: Request, res: Response) => {
    const catalogue = await listPublishedVariants(deps.db, deps.merchantId);
    res.json({
      merchant: MERCHANT_NAME,
      note: 'All prices are integer paise. 49900 paise = ₹499.00.',
      variants: catalogue,
    });
  });

  // --- Registration — mirrors register_agent -------------------------------
  router.post('/agents', async (req: Request, res: Response) => {
    const body = parseBody(registerBody, req, res);
    if (body === null) return;
    const registration = await registerAgent(deps.db, deps.merchantId, body);
    res.status(201).json({
      ...registration,
      note:
        'Send this agentToken as `Authorization: Bearer <agentToken>` on every subsequent call. ' +
        (registration.custody === 'client'
          ? 'The server stored only your public key: sign each mandate payload locally ' +
            '(Ed25519 over its canonical JSON) and pass the signatures to POST /acp/intents ' +
            'and POST /acp/payments. '
          : 'Your private key stays in merchant custody and is never returned. ') +
        'To change the Cap, register again: that mints a new Agent with the new Cap.',
    });
  });

  // --- Intent mandate — mirrors declare_intent ------------------------------
  router.post('/intents', async (req: Request, res: Response) => {
    const body = parseBody(intentBody, req, res);
    if (body === null) return;
    const agent = await requireRegisteredAgent(
      deps.db,
      deps.merchantId,
      bearerToken(req) ?? body.agentToken,
      'declare_intent',
    );
    const result = await declareIntent(deps.db, agent, body);
    res.status(201).json({
      intentHash: result.intentHash,
      payload: result.payload,
      signature: result.signature,
      budget: result.budget,
      nextStep:
        'POST /acp/carts with this intentHash and the items you want ' +
        '(variantId + quantity from GET /acp/products).',
    });
  });

  // --- Cart mandate — mirrors create_cart -----------------------------------
  router.post('/carts', async (req: Request, res: Response) => {
    const body = parseBody(cartBody, req, res);
    if (body === null) return;
    const agent = await requireRegisteredAgent(
      deps.db,
      deps.merchantId,
      bearerToken(req) ?? body.agentToken,
      'create_cart',
    );
    const result = await createCart(deps.db, agent, body);
    res.status(201).json({
      cartHash: result.cartHash,
      payload: result.payload,
      agentSignature: result.agentSignature,
      merchantSignature: result.merchantSignature,
      total: result.total,
      items: result.items,
      nextStep:
        (result.agentSignature === null
          ? 'Sign the canonical JSON of this exact payload with your local key, then POST ' +
            '/acp/payments with this cartHash, that signature as cartSignature, a locally ' +
            'signed Payment mandate (paymentCreatedAt + paymentSignature), and a fresh UUID ' +
            'you mint as the Idempotency-Key.'
          : 'POST /acp/payments with this cartHash and a fresh UUID you mint as the ' +
            'Idempotency-Key.') +
        ' If prices change before then, the payment refuses PRICE_CHANGED and you ' +
        'simply POST /acp/carts again.',
    });
  });

  // --- Payment mandate — mirrors submit_payment ------------------------------
  router.post('/payments', async (req: Request, res: Response) => {
    const body = parseBody(paymentBody, req, res);
    if (body === null) return;
    // ACP flavor: the idempotency key may ride the standard header instead of
    // the body. Either way it is buyer-minted (DECISIONS 2026-08-23).
    const idempotencyKey = body.idempotencyKey ?? req.get('idempotency-key')?.trim();
    if (idempotencyKey === undefined || idempotencyKey === '') {
      res.status(400).json({
        error: 'invalid_request',
        issues: [
          {
            path: 'idempotencyKey',
            message:
              'Mint a fresh UUID per payment attempt; send it as the Idempotency-Key ' +
              'header or the idempotencyKey body field.',
          },
        ],
      });
      return;
    }
    // The trust gate runs first — an unregistered agent is refused before any
    // Order exists and before the gateway is ever touched (same as MCP).
    const agent = await requireRegisteredAgent(
      deps.db,
      deps.merchantId,
      bearerToken(req) ?? body.agentToken,
      'submit_payment',
    );
    const result = await submitPayment(deps, agent, { ...body, idempotencyKey });
    res.status(201).json({
      orderId: result.orderId,
      status: result.status,
      total: result.total,
      items: result.items,
      paymentLinkUrl: result.paymentLinkUrl,
      gatewayPaymentLinkId: result.gatewayPaymentLinkId,
      paymentMandate: result.paymentMandate,
      nextStep:
        'Give paymentLinkUrl to your human and ask them to approve it. ' +
        'In Razorpay test mode the UPI id success@razorpay completes the payment. ' +
        `Then GET /acp/orders/${result.orderId}; once paid it ` +
        'includes the merchant-signed Receipt.',
      auditUrl: `${deps.publicBaseUrl}/audit/${result.orderId}`,
    });
  });

  // --- Order status + Receipt — mirrors get_order_status ---------------------
  router.get('/orders/:orderId', async (req: Request<{ orderId: string }>, res: Response) => {
    await requireRegisteredAgent(deps.db, deps.merchantId, bearerToken(req), 'get_order_status');
    res.json(await readOrderStatus(deps, req.params.orderId));
  });

  // --- The one place core errors become REST responses ----------------------
  // Express 5 forwards rejected async handlers here; anything that is neither
  // a Refusal nor a ValidationError falls through to the app-level 500.
  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error instanceof Refusal) {
      res.status(403).json({ refusal: error.toPayload() });
      return;
    }
    if (error instanceof ValidationError) {
      res
        .status(error.code === 'ORDER_NOT_FOUND' ? 404 : 400)
        .json({ validationError: error.toPayload() });
      return;
    }
    next(error);
  });

  return router;
}

// ---------------------------------------------------------------------------
// Discovery — /.well-known/agent-store.json describes both faces so an agent
// landing on the bare domain can pick its protocol and start buying.
// ---------------------------------------------------------------------------

export function discoveryDocument(deps: StorefrontDeps): Record<string, unknown> {
  const base = deps.publicBaseUrl;
  return {
    service: 'agent-store',
    version: '0.1.0',
    merchant: { id: deps.merchantId, name: MERCHANT_NAME },
    money: {
      currency: 'INR',
      unit: 'paise',
      note: 'Every amount is an integer number of paise: 129900 means ₹1,299.00. Never send rupees or decimals.',
    },
    purchaseFlow: [
      'Browse the catalog (public).',
      'Register once, declaring your Cap (spend ceiling, integer paise) — returns the agentToken every later call requires.',
      'Declare an Intent mandate: what you want plus your budgetPaise for this purchase — returns an intentHash.',
      'Create the immutable Cart mandate from that intentHash and your items — returns a cartHash.',
      'Submit the Payment mandate with the cartHash and a fresh buyer-minted idempotency key — the server verifies the whole signed chain and returns a Razorpay-hosted payment link.',
      'A human approves the payment link; that approval is the only way money moves.',
      'Poll order status until "paid" — the response then carries the merchant-signed Receipt.',
    ],
    faces: {
      mcp: {
        protocol: 'mcp',
        transport: 'streamable-http',
        endpoint: `${base}/mcp`,
        authentication:
          'None at the transport. Identity lives in-protocol: register_agent mints an agentToken passed as a tool argument on every call.',
        tools: [
          'get_product',
          'register_agent',
          'declare_intent',
          'create_cart',
          'submit_payment',
          'get_order_status',
        ],
      },
      rest: {
        protocol: 'rest',
        flavor: 'acp',
        baseUrl: `${base}${REST_BASE_PATH}`,
        authentication:
          'Authorization: Bearer <agentToken> (minted by POST /acp/agents). POST bodies may carry agentToken instead. GET /acp/products is public.',
        endpoints: [
          {
            method: 'GET',
            path: `${REST_BASE_PATH}/products`,
            mirrors: 'get_product',
            description: 'List published Variants — the sellable unit — with price (integer paise) and stock.',
          },
          {
            method: 'POST',
            path: `${REST_BASE_PATH}/agents`,
            mirrors: 'register_agent',
            body: { capPaise: 'integer paise', 'publicKey?': 'base64 SPKI DER Ed25519 (client custody)' },
            description: 'Register an Agent and declare its immutable Cap. Returns the agentToken.',
          },
          {
            method: 'POST',
            path: `${REST_BASE_PATH}/intents`,
            mirrors: 'declare_intent',
            body: {
              want: 'plain-language description',
              budgetPaise: 'integer paise',
              'createdAt?': 'client custody: ISO-8601 timestamp you signed',
              'signature?': 'client custody: base64 Ed25519 over the canonical Intent payload',
            },
            description: 'Declare the signed Intent mandate. Returns the intentHash.',
          },
          {
            method: 'POST',
            path: `${REST_BASE_PATH}/carts`,
            mirrors: 'create_cart',
            body: { intentHash: 'from POST /acp/intents', items: '[{variantId, quantity}]' },
            description:
              'One-shot: turn an Intent into a priced, immutable Cart mandate (no cart editing — POST again to change items). Returns the cartHash.',
          },
          {
            method: 'POST',
            path: `${REST_BASE_PATH}/payments`,
            mirrors: 'submit_payment',
            headers: { 'Idempotency-Key': 'fresh buyer-minted UUID per attempt (or idempotencyKey in the body)' },
            body: {
              cartHash: 'from POST /acp/carts',
              'cartSignature?': 'client custody: your signature over the Cart payload',
              'paymentCreatedAt?': 'client custody: ISO-8601 timestamp you signed',
              'paymentSignature?': 'client custody: base64 Ed25519 over the canonical Payment payload',
            },
            description:
              'Verify the whole Intent → Cart → Payment chain and return the Order plus the Razorpay-hosted payment link a human approves.',
          },
          {
            method: 'GET',
            path: `${REST_BASE_PATH}/orders/{orderId}`,
            mirrors: 'get_order_status',
            description:
              'Order status; once "paid" the body carries the merchant-signed Receipt (payload, signature, merchant public key).',
          },
        ],
        errors: {
          refusal: {
            status: 403,
            shape: { refusal: { code: '…', reason: '…', recoverable: 'boolean', 'retryAfter?': 'seconds' } },
            note: 'The trust layer saying no, on policy, before money moves. Identical body on both faces.',
          },
          validationError: {
            status: '400 (404 for ORDER_NOT_FOUND)',
            shape: { validationError: { code: '…', message: '…' } },
            note: 'Malformed or unsatisfiable input. Identical body on both faces.',
          },
          invalidRequest: {
            status: 400,
            shape: { error: 'invalid_request', issues: '[{path, message}]' },
            note: 'The transport rejecting a malformed body — the REST counterpart of an MCP schema rejection.',
          },
        },
      },
    },
    audit: {
      directory: `${base}/audit`,
      order: `${base}/audit/{orderId}`,
      refusal: `${base}/audit/refusals/{seq}`,
      viewer: `${base}/viewer`,
    },
  };
}

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { REST_BASE_PATH } from '../../http/restFace.js';

/**
 * The two protocol doors, behind one interface — so every scenario is written
 * once against `FaceDriver` and can be pointed at either face (PLAN §6: the
 * scenarios exercise the MCP *and* REST surfaces). Both drivers go over real
 * HTTP to the same ephemeral server: the MCP driver is a Streamable HTTP MCP
 * client hitting `/mcp` exactly as a connector does, the REST driver is
 * `fetch` against `/acp/*` exactly as the T14 curl sequence does. Nothing is
 * in-process; what is asserted is what a real buyer would see on the wire.
 *
 * Results are normalised to one shape. The trust layer's two kinds of "no"
 * stay distinct (CONTEXT.md → Failure vocabulary): a Refusal surfaces under
 * `refusal`, a validation error under `validationError` — never coerced into
 * each other, because scenarios assert on exactly which kind arrived.
 */

export interface FaceCallResult {
  readonly ok: boolean;
  /** The parsed wire body — tool text content (MCP) or response JSON (REST). */
  readonly body: Record<string, unknown>;
  /** Present iff the call was refused on policy: `{code, reason, recoverable, retryAfter?}`. */
  readonly refusal: Record<string, unknown> | null;
  /** Present iff the call was a validation error: `{code, message}`. */
  readonly validationError: Record<string, unknown> | null;
}

export interface RegisterArgs {
  readonly capPaise: number;
  readonly publicKey?: string;
}

export interface DeclareIntentArgs {
  readonly agentToken?: string;
  readonly want: string;
  readonly budgetPaise: number;
  readonly createdAt?: string;
  readonly signature?: string;
}

export interface CreateCartArgs {
  readonly agentToken?: string;
  readonly intentHash: string;
  readonly items: ReadonlyArray<{ readonly variantId: string; readonly quantity: number }>;
}

export interface SubmitPaymentArgs {
  readonly agentToken?: string;
  readonly cartHash: string;
  readonly idempotencyKey: string;
  readonly cartSignature?: string;
  readonly paymentCreatedAt?: string;
  readonly paymentSignature?: string;
}

export interface FaceDriver {
  readonly face: 'mcp' | 'rest';
  getProduct(): Promise<FaceCallResult>;
  registerAgent(args: RegisterArgs): Promise<FaceCallResult>;
  declareIntent(args: DeclareIntentArgs): Promise<FaceCallResult>;
  createCart(args: CreateCartArgs): Promise<FaceCallResult>;
  submitPayment(args: SubmitPaymentArgs): Promise<FaceCallResult>;
  getOrderStatus(args: { agentToken?: string; orderId: string }): Promise<FaceCallResult>;
  close(): Promise<void>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Pull the two structured failure shapes out of a wire body, whichever face. */
function classify(ok: boolean, body: Record<string, unknown>): FaceCallResult {
  return {
    ok,
    body,
    refusal: asRecord(body['refusal']),
    validationError: asRecord(body['validationError']),
  };
}

// ---------------------------------------------------------------------------
// MCP — a real Streamable HTTP client against POST /mcp, one session per
// driver, the same transport a claude.ai connector or Claude Code uses.
// ---------------------------------------------------------------------------

class McpDriver implements FaceDriver {
  readonly face = 'mcp' as const;
  readonly #client: Client;
  #connected: Promise<void> | null = null;
  readonly #url: string;

  constructor(baseUrl: string) {
    this.#client = new Client({ name: 'protocol-eval-buyer', version: '0.1.0' });
    this.#url = `${baseUrl}/mcp`;
  }

  async #call(tool: string, args: Record<string, unknown>): Promise<FaceCallResult> {
    this.#connected ??= this.#client.connect(new StreamableHTTPClientTransport(new URL(this.#url)));
    await this.#connected;
    const result = await this.#client.callTool({ name: tool, arguments: args });
    const content = result.content as Array<{ type: string; text: string }>;
    const body = JSON.parse(content[0]!.text) as Record<string, unknown>;
    return classify(result.isError !== true, body);
  }

  getProduct(): Promise<FaceCallResult> {
    return this.#call('get_product', {});
  }

  registerAgent(args: RegisterArgs): Promise<FaceCallResult> {
    return this.#call('register_agent', { ...args });
  }

  declareIntent(args: DeclareIntentArgs): Promise<FaceCallResult> {
    return this.#call('declare_intent', { ...args });
  }

  createCart(args: CreateCartArgs): Promise<FaceCallResult> {
    return this.#call('create_cart', { ...args, items: args.items.map((item) => ({ ...item })) });
  }

  submitPayment(args: SubmitPaymentArgs): Promise<FaceCallResult> {
    return this.#call('submit_payment', { ...args });
  }

  getOrderStatus(args: { agentToken?: string; orderId: string }): Promise<FaceCallResult> {
    return this.#call('get_order_status', { ...args });
  }

  async close(): Promise<void> {
    if (this.#connected !== null) {
      await this.#connected.catch(() => undefined);
      await this.#client.close();
    }
  }
}

// ---------------------------------------------------------------------------
// REST — fetch against /acp/*, bearer auth, Idempotency-Key header: the ACP
// dialect exactly as the discovery doc describes it.
// ---------------------------------------------------------------------------

class RestDriver implements FaceDriver {
  readonly face = 'rest' as const;
  readonly #base: string;

  constructor(baseUrl: string) {
    this.#base = `${baseUrl}${REST_BASE_PATH}`;
  }

  async #request(
    method: 'GET' | 'POST',
    path: string,
    options: { body?: Record<string, unknown>; token?: string; headers?: Record<string, string> } = {},
  ): Promise<FaceCallResult> {
    const response = await fetch(`${this.#base}${path}`, {
      method,
      headers: {
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const body = (await response.json()) as Record<string, unknown>;
    return classify(response.ok, body);
  }

  getProduct(): Promise<FaceCallResult> {
    return this.#request('GET', '/products');
  }

  registerAgent(args: RegisterArgs): Promise<FaceCallResult> {
    return this.#request('POST', '/agents', { body: { ...args } });
  }

  declareIntent(args: DeclareIntentArgs): Promise<FaceCallResult> {
    const { agentToken, ...body } = args;
    return this.#request('POST', '/intents', { body, token: agentToken });
  }

  createCart(args: CreateCartArgs): Promise<FaceCallResult> {
    const { agentToken, ...rest } = args;
    return this.#request('POST', '/carts', {
      body: { ...rest, items: rest.items.map((item) => ({ ...item })) },
      token: agentToken,
    });
  }

  submitPayment(args: SubmitPaymentArgs): Promise<FaceCallResult> {
    const { agentToken, idempotencyKey, ...body } = args;
    // The key rides the standard header — the canonical ACP spelling (T14).
    return this.#request('POST', '/payments', {
      body,
      token: agentToken,
      headers: { 'idempotency-key': idempotencyKey },
    });
  }

  getOrderStatus(args: { agentToken?: string; orderId: string }): Promise<FaceCallResult> {
    return this.#request('GET', `/orders/${encodeURIComponent(args.orderId)}`, {
      token: args.agentToken,
    });
  }

  async close(): Promise<void> {
    // Stateless — nothing to tear down.
  }
}

export function createFaceDriver(face: 'mcp' | 'rest', baseUrl: string): FaceDriver {
  return face === 'mcp' ? new McpDriver(baseUrl) : new RestDriver(baseUrl);
}

/**
 * The viewer's whole world: the three read-only /audit endpoints (T7) plus the
 * merchant confirmation endpoints under /merchant (T13). Shapes match what
 * src/http/app.ts serves; everything inside `payload` stays untyped on
 * purpose — it is rendered defensively, never trusted.
 */

export interface MoneyView {
  readonly amountPaise: number;
  readonly amountDisplay: string;
  readonly currency: string;
}

export interface AuditEvent {
  readonly seq: number;
  readonly type: string;
  readonly summary: string;
  readonly occurredAt: string;
  readonly payload: Record<string, unknown>;
}

export interface OrderStatusView {
  readonly orderId: string;
  readonly status: string;
  readonly total: MoneyView;
  readonly quantity: number | null;
  readonly gatewayOrderId: string | null;
  readonly gatewayPaymentId: string | null;
  readonly gatewayPaymentLinkId: string | null;
  readonly paymentLinkUrl: string | null;
  readonly createdAt: string;
  readonly paidAt: string | null;
  readonly cancelledAt: string | null;
  readonly refundedAt: string | null;
  /**
   * The structured Decline a fail-closed cancellation stored (T8) — a gateway
   * Decline, never a Refusal. Untyped beyond "object": rendered defensively
   * like every payload.
   */
  readonly decline: Record<string, unknown> | null;
  /**
   * The structured Oversell a refunded Order stored (T9) — a fulfilment-time
   * stock shortfall after capture, automatically refunded; neither a Refusal
   * nor a Decline. Rendered defensively like every payload.
   */
  readonly oversell: Record<string, unknown> | null;
}

/** Named as the server names it (src/domain/orders.ts) — one shape, one name. */
export interface OrderDirectoryEntry {
  readonly orderId: string;
  readonly status: string;
  readonly total: MoneyView;
  readonly createdAt: string;
}

export interface AuditDirectory {
  readonly merchant: string;
  readonly orders: readonly OrderDirectoryEntry[];
  readonly refusals: readonly AuditEvent[];
}

export interface OrderAudit {
  readonly orderId: string;
  readonly order: OrderStatusView | null;
  readonly complete: boolean;
  readonly missingSteps: readonly string[];
  readonly anomalies: number;
  readonly events: readonly AuditEvent[];
}

export interface RefusalAudit {
  readonly seq: number;
  readonly refusal: AuditEvent;
  readonly events: readonly AuditEvent[];
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`Request failed with status ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Non-JSON error body — the status alone is the story.
    }
    throw new ApiError(response.status, body);
  }
  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Merchant confirmation (T13) — mirrors src/domain/confirmation.ts views and
// src/ingestion/extractionRecord.ts, restated in wire types.
// ---------------------------------------------------------------------------

export interface RecordedField {
  readonly value: unknown;
  /** Self-reported by the model, 0–1. Ranked, never trusted as probability. */
  readonly confidence: number;
  /** True when this field alone held the Product out of `published`. */
  readonly belowThreshold: boolean;
}

export interface HoldReason {
  readonly field: string;
  readonly reason: string;
}

export interface ExtractionRecord {
  readonly sourceId: string;
  readonly imagePath: string | null;
  readonly caption: string;
  readonly modelId: string;
  readonly extractedAt: string;
  readonly threshold: number;
  readonly fields: Readonly<Record<string, RecordedField>>;
  readonly holds: readonly HoldReason[];
}

export interface ConfirmationVariant {
  readonly variantId: string;
  readonly label: string | null;
  readonly isDefault: boolean;
  readonly pricePaise: number | null;
  readonly stock: number | null;
}

export interface ConfirmationProduct {
  readonly productId: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: string;
  readonly extraction: ExtractionRecord | null;
  readonly variants: readonly ConfirmationVariant[];
}

export interface ConfirmationList {
  readonly merchant: string;
  readonly products: readonly ConfirmationProduct[];
}

export interface ConfirmationDetail {
  readonly merchant: string;
  readonly product: ConfirmationProduct;
}

/** What POST /merchant/confirmations/:productId expects — the complete final state. */
export interface ConfirmationSubmission {
  readonly title: string;
  readonly description: string | null;
  readonly variants: ReadonlyArray<{
    readonly variantId?: string;
    readonly label: string | null;
    readonly pricePaise: number;
    readonly stock: number;
  }>;
}

export interface ConfirmationResult {
  readonly productId: string;
  readonly status: string;
  readonly product: ConfirmationProduct;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // Non-JSON error body — the status alone is the story.
    }
    throw new ApiError(response.status, payload);
  }
  return (await response.json()) as T;
}

/**
 * The server's answer when it refuses a submission, flattened for display.
 * Both dialects (`validationError` and `invalid_request`) are covered so the
 * screen always shows the server's reason, never a generic "failed".
 */
export function describeApiError(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'Could not reach the server. Is it running?';
  }
  const body = error.body;
  if (typeof body === 'object' && body !== null) {
    const record = body as Record<string, unknown>;
    const validation = record['validationError'];
    if (typeof validation === 'object' && validation !== null) {
      const v = validation as Record<string, unknown>;
      if (typeof v['message'] === 'string') {
        return typeof v['code'] === 'string' ? `${v['code']}: ${v['message']}` : v['message'];
      }
    }
    if (record['error'] === 'invalid_request' && Array.isArray(record['issues'])) {
      const issues = (record['issues'] as Array<Record<string, unknown>>)
        .map((issue) => `${String(issue['path'])}: ${String(issue['message'])}`)
        .join('; ');
      return `The server rejected the request body — ${issues}`;
    }
  }
  return `The server answered ${error.status}.`;
}

export const fetchConfirmations = (): Promise<ConfirmationList> =>
  getJson('/merchant/confirmations');

export const fetchConfirmationProduct = (productId: string): Promise<ConfirmationDetail> =>
  getJson(`/merchant/confirmations/${encodeURIComponent(productId)}`);

export const postConfirmation = (
  productId: string,
  submission: ConfirmationSubmission,
): Promise<ConfirmationResult> =>
  postJson(`/merchant/confirmations/${encodeURIComponent(productId)}`, submission);

export const photoUrl = (productId: string): string =>
  `/merchant/confirmations/${encodeURIComponent(productId)}/photo`;

export const fetchDirectory = (): Promise<AuditDirectory> => getJson('/audit');

export const fetchOrderAudit = (orderId: string): Promise<OrderAudit> =>
  getJson(`/audit/${encodeURIComponent(orderId)}`);

export const fetchRefusalAudit = (seq: string): Promise<RefusalAudit> =>
  getJson(`/audit/refusals/${encodeURIComponent(seq)}`);

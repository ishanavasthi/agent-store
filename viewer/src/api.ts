/**
 * The viewer's whole world: the three read-only /audit endpoints. Shapes match
 * what src/http/app.ts serves (T7 contract); everything inside `payload` stays
 * untyped on purpose — it is rendered defensively, never trusted.
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
}

export interface DirectoryOrder {
  readonly orderId: string;
  readonly status: string;
  readonly total: MoneyView;
  readonly createdAt: string;
}

export interface AuditDirectory {
  readonly merchant: string;
  readonly orders: readonly DirectoryOrder[];
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

export const fetchDirectory = (): Promise<AuditDirectory> => getJson('/audit');

export const fetchOrderAudit = (orderId: string): Promise<OrderAudit> =>
  getJson(`/audit/${encodeURIComponent(orderId)}`);

export const fetchRefusalAudit = (seq: string): Promise<RefusalAudit> =>
  getJson(`/audit/refusals/${encodeURIComponent(seq)}`);

import type { Database } from './db/client.js';
import type { PaymentGateway } from './gateway/types.js';

/**
 * Everything the storefront core needs, assembled once at the composition root
 * (`src/index.ts`) and passed down unchanged.
 *
 * One type rather than a per-layer copy: the HTTP layer, the MCP layer and
 * `checkout()` all want the same four things, and three near-identical
 * interfaces would drift the moment the trust layer adds a fifth.
 */
export interface StorefrontDeps {
  readonly db: Database;
  readonly gateway: PaymentGateway;
  /** v1 serves exactly one Merchant per deployment (PLAN §4). */
  readonly merchantId: string;
  readonly publicBaseUrl: string;
}

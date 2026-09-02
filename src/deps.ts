import type { Database } from './db/client.js';
import type { PaymentGateway } from './gateway/types.js';
import type { ExtractionModel } from './ingestion/types.js';

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
  /**
   * Where the built T7 viewer SPA lives. Defaults to `<cwd>/dist/viewer` —
   * both `npm run dev` and the deploy's `npm start` run at the repo root.
   * Tests point it at a stub dir; absent entirely, `/viewer` 404s and the
   * rest of the app keeps working.
   */
  readonly viewerDistDir?: string;
  /**
   * The extraction model `submit_catalog_item` runs (S1.3). Optional because a
   * deployment with no LLM key must still boot and serve its catalog: absent,
   * that one tool answers `EXTRACTION_NOT_CONFIGURED` and nothing else changes.
   */
  readonly extractionModel?: ExtractionModel;
  /**
   * How a merchant-submitted photo URL is fetched. Defaults to global `fetch`;
   * tests inject one so the address guard can be exercised without a network.
   */
  readonly fetchImpl?: typeof fetch;
}

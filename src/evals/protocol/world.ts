import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { asc, eq } from 'drizzle-orm';
import { auditEvents, variants } from '../../db/schema.js';
import type { StorefrontDeps } from '../../deps.js';
import { RAZORPAY_SIGNATURE_HEADER } from '../../gateway/razorpayWebhook.js';
import { StubGateway, type SyntheticWebhook } from '../../gateway/stubGateway.js';
import { createApp } from '../../http/app.js';
import { createTestDatabase, type TestDatabaseHandle } from '../../testSupport/pgliteDatabase.js';
import { MERCHANT_ID, seedCatalog } from '../../testSupport/seedCatalog.js';
import { createFaceDriver, type FaceDriver } from './faces.js';
import type { AuditLogRecord } from './types.js';

/**
 * One scenario's world: a fresh embedded PGlite Postgres (real committed
 * migrations, append-only audit triggers included), a fresh StubGateway, and
 * the REAL Express app — MCP face, REST face, webhook route and all — bound to
 * an ephemeral port. Every scenario starts from the identical seeded catalog,
 * so scenarios are order-independent and the suite is deterministic end to end
 * (PLAN §5.4: the stub is what makes the scripted suite CI-runnable).
 *
 * Webhooks are delivered over `POST /webhooks/razorpay`, not by calling the
 * domain directly — so the decline bound, the paid transition, and the
 * *automatic* oversell refund all run exactly the code a real Razorpay
 * delivery runs.
 */

export const SEEDED_STOCK = 5;
export const TEE_VARIANT = 'var_test_tee_default';
export const CAP_VARIANT = 'var_test_cap_default';
export const TEE_PRICE_PAISE = 129900;
export const CAP_PRICE_PAISE = 49900;

export interface ScenarioWorld {
  readonly deps: StorefrontDeps;
  readonly gateway: StubGateway;
  readonly baseUrl: string;
  /** A fresh driver for one buyer session on the given face. */
  driver(face: 'mcp' | 'rest'): FaceDriver;
  /** Deliver stub webhooks over the real HTTP route; returns each response body. */
  deliver(hooks: readonly SyntheticWebhook[]): Promise<ReadonlyArray<Record<string, unknown>>>;
  /** Merchant-side catalog edit: reprice a Variant (drives PRICE_CHANGED). */
  setVariantPrice(variantId: string, pricePaise: number): Promise<void>;
  /** Merchant-side catalog edit: restock/drain a Variant. */
  setVariantStock(variantId: string, stock: number): Promise<void>;
  /** Record one successful checkout's submit latency (see ProtocolSuiteRun). */
  recordCheckoutLatency(ms: number): void;
  readonly checkoutLatenciesMs: readonly number[];
  /** Every audit_events row this world wrote, in seq order, tagged. */
  exportAuditLog(scenarioId: string): Promise<AuditLogRecord[]>;
  close(): Promise<void>;
}

export interface ScenarioWorldOptions {
  /** Seeded stock per Variant. Defaults to SEEDED_STOCK. */
  readonly stock?: number;
}

export async function createScenarioWorld(
  options: ScenarioWorldOptions = {},
): Promise<ScenarioWorld> {
  const handle: TestDatabaseHandle = await createTestDatabase();
  const gateway = new StubGateway();
  await seedCatalog(handle.db, options.stock ?? SEEDED_STOCK);

  const deps: StorefrontDeps = {
    db: handle.db,
    gateway,
    merchantId: MERCHANT_ID,
    publicBaseUrl: 'https://merchant.example',
  };

  const server: Server = createServer(createApp(deps));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const drivers: FaceDriver[] = [];
  const checkoutLatenciesMs: number[] = [];

  return {
    deps,
    gateway,
    baseUrl,
    driver(face) {
      const driver = createFaceDriver(face, baseUrl);
      drivers.push(driver);
      return driver;
    },
    async deliver(hooks) {
      const outcomes: Array<Record<string, unknown>> = [];
      for (const hook of hooks) {
        const response = await fetch(`${baseUrl}/webhooks/razorpay`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [RAZORPAY_SIGNATURE_HEADER]: hook.signature,
          },
          body: hook.rawBody,
        });
        outcomes.push((await response.json()) as Record<string, unknown>);
      }
      return outcomes;
    },
    async setVariantPrice(variantId, pricePaise) {
      await handle.db.update(variants).set({ pricePaise }).where(eq(variants.id, variantId));
    },
    async setVariantStock(variantId, stock) {
      await handle.db.update(variants).set({ stock }).where(eq(variants.id, variantId));
    },
    recordCheckoutLatency(ms) {
      checkoutLatenciesMs.push(ms);
    },
    checkoutLatenciesMs,
    async exportAuditLog(scenarioId) {
      const rows = await handle.db.select().from(auditEvents).orderBy(asc(auditEvents.seq));
      return rows.map((row) => ({
        seq: row.seq,
        type: row.type,
        orderId: row.orderId,
        merchantId: row.merchantId,
        payload: row.payload as Record<string, unknown>,
        scenarioId,
      }));
    },
    async close() {
      for (const driver of drivers) {
        await driver.close().catch(() => undefined);
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      await handle.close();
    },
  };
}

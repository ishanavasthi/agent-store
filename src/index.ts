import { MERCHANT_ID, loadConfig } from './config.js';
import { createDatabase } from './db/client.js';
import { RazorpayGateway } from './gateway/razorpayGateway.js';
import { createApp } from './http/app.js';
import { createExtractionModelIfConfigured } from './ingestion/extractionModel.js';

/**
 * Composition root — the only place the real gateway implementation is chosen.
 * T2's deterministic stub is swapped in here (and in the eval runner); nothing
 * else in the codebase knows which one it is talking to.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const { db, close } = createDatabase(config.databaseUrl);

  const gateway = new RazorpayGateway({
    keyId: config.razorpay.keyId,
    keySecret: config.razorpay.keySecret,
    webhookSecret: config.razorpay.webhookSecret,
  });

  // Extraction is optional at boot (S1.3): no key means `submit_catalog_item`
  // answers EXTRACTION_NOT_CONFIGURED, not that the storefront refuses to start.
  const extractionModel = createExtractionModelIfConfigured();

  const app = createApp({
    db,
    gateway,
    merchantId: MERCHANT_ID,
    publicBaseUrl: config.publicBaseUrl,
    ...(extractionModel === null ? {} : { extractionModel }),
  });

  const server = app.listen(config.port, () => {
    console.log(`[agent-store] listening on :${config.port}`);
    console.log(`[agent-store] MCP endpoint    ${config.publicBaseUrl}/mcp`);
    console.log(`[agent-store] webhook target  ${config.publicBaseUrl}/webhooks/razorpay`);
    console.log(
      extractionModel === null
        ? '[agent-store] extraction     disabled (no key) — submit_catalog_item will refuse'
        : `[agent-store] extraction     ${extractionModel.modelId}`,
    );
  });

  const shutdown = (signal: string): void => {
    console.log(`[agent-store] ${signal} received, shutting down`);
    server.close(() => {
      void close().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error('[agent-store] failed to start', error);
  process.exit(1);
});

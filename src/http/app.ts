import { existsSync } from 'node:fs';
import path from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { MERCHANT_NAME } from '../config.js';
import type { StorefrontDeps } from '../deps.js';
import {
  missingHappyPathSteps,
  type AuditChainEntry,
  type WireAuditEvent,
} from '../domain/auditEvents.js';
import {
  listRecentRefusals,
  readPurchaseAuditChain,
  readRefusalContext,
} from '../domain/auditLog.js';
import {
  applyGatewayWebhook,
  findOrderById,
  listRecentOrders,
  toOrderStatusView,
} from '../domain/orders.js';
import { RAZORPAY_SIGNATURE_HEADER, WebhookParseError } from '../gateway/razorpayWebhook.js';
import { createMcpServer } from '../mcp/server.js';

/** Each `GET /audit` directory list is capped here; the log itself is unbounded. */
const AUDIT_DIRECTORY_LIMIT = 50;

function toWireEvent(event: AuditChainEntry): WireAuditEvent {
  return {
    seq: event.seq,
    type: event.type,
    summary: event.summary,
    occurredAt: event.occurredAt.toISOString(),
    payload: event.payload,
  };
}

/** Escape text destined for HTML. Nothing user-influenced is interpolated raw. */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function createApp(deps: StorefrontDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  // ---------------------------------------------------------------------------
  // Webhook — registered before the JSON body parser on purpose.
  //
  // Signature verification is HMAC over the *raw bytes* Razorpay sent. Once
  // `express.json()` has parsed and a handler re-serialises, key order and
  // whitespace differ and the signature can never match again.
  // ---------------------------------------------------------------------------
  app.post(
    '/webhooks/razorpay',
    express.text({ type: '*/*', limit: '1mb' }),
    async (req: Request, res: Response) => {
      const rawBody = typeof req.body === 'string' ? req.body : '';
      const signature = req.get(RAZORPAY_SIGNATURE_HEADER) ?? '';

      if (!deps.gateway.verifyWebhookSignature(rawBody, signature)) {
        // Unverified: not a Refusal and not a Decline — an unauthenticated
        // request. Nothing is written; there is no state change to record.
        res.status(401).json({ error: 'invalid_signature' });
        return;
      }

      let event;
      try {
        event = deps.gateway.parseWebhookEvent(rawBody);
      } catch (error) {
        if (error instanceof WebhookParseError) {
          // Signed by us, so genuinely from Razorpay — but unintelligible, and
          // it will be just as unintelligible next time. A non-2xx would make
          // Razorpay redeliver it forever, so acknowledge and move on. Logged
          // loudly because a body we cannot read is an integration problem.
          console.error('[agent-store] unparseable signed webhook', error.message);
          res.status(200).json({ received: true, result: 'ignored', reason: 'unparseable' });
          return;
        }
        throw error;
      }

      const outcome = await applyGatewayWebhook(deps.db, deps.merchantId, event, deps.gateway.name);

      // Always 200 on a verified event, including `unmatched` and `anomaly`: a
      // non-2xx makes Razorpay redeliver, and redelivery fixes neither.
      res.status(200).json({ received: true, gatewayEvent: event.rawEvent, ...outcome });
    },
  );

  app.use(express.json({ limit: '4mb' }));

  // ---------------------------------------------------------------------------
  // MCP — authless Streamable HTTP, stateless (a fresh server + transport per
  // request). Statelessness is what lets Render's free tier restart or scale
  // this process without dropping a connector mid-purchase.
  // ---------------------------------------------------------------------------
  app.post('/mcp', async (req: Request, res: Response) => {
    const server = createMcpServer(deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
      throw error;
    }
  });

  // Stateless mode has no server→client stream and no session to delete.
  const noSession = (_req: Request, res: Response): void => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed: this MCP server is stateless' },
      id: null,
    });
  };
  app.get('/mcp', noSession);
  app.delete('/mcp', noSession);

  // ---------------------------------------------------------------------------
  // Audit — the whole point of ADR-0003 made visible. The T7 React viewer reads
  // exactly these endpoints; the rule-auditor reads exactly this data.
  //
  // Registration order matters: `/audit` and `/audit/refusals/:seq` must come
  // before `/audit/:orderId`, or Express routes `refusals` as an orderId.
  // ---------------------------------------------------------------------------
  app.get('/audit', async (_req: Request, res: Response) => {
    const [recentOrders, recentRefusals] = await Promise.all([
      listRecentOrders(deps.db, deps.merchantId, AUDIT_DIRECTORY_LIMIT),
      listRecentRefusals(deps.db, deps.merchantId, AUDIT_DIRECTORY_LIMIT),
    ]);
    res.json({
      merchant: MERCHANT_NAME,
      orders: recentOrders,
      refusals: recentRefusals.map(toWireEvent),
    });
  });

  // A standalone Refusal has no Order — it is addressed by its audit `seq`
  // (DECISIONS 2026-08-26, refusal addressing).
  app.get('/audit/refusals/:seq', async (req: Request<{ seq: string }>, res: Response) => {
    const seq = Number.parseInt(req.params.seq, 10);
    const context =
      Number.isSafeInteger(seq) && seq > 0
        ? await readRefusalContext(deps.db, deps.merchantId, seq)
        : null;

    if (context === null) {
      // Unknown seq and a seq naming a non-refusal event answer identically:
      // this endpoint only ever confirms Refusals.
      res.status(404).json({ error: 'refusal_not_found', seq: req.params.seq });
      return;
    }

    res.json({
      seq,
      refusal: toWireEvent(context.refusal),
      events: context.events.map(toWireEvent),
    });
  });

  app.get('/audit/:orderId', async (req: Request<{ orderId: string }>, res: Response) => {
    const orderId = req.params.orderId;
    const order = await findOrderById(deps.db, deps.merchantId, orderId);
    // The purchase-scoped read: includes the mandate events written before the
    // Order existed, linked back through the Payment mandate's chain hashes —
    // without them every mandate purchase would read as incomplete here.
    const events = await readPurchaseAuditChain(deps.db, orderId);

    if (order === null && events.length === 0) {
      res.status(404).json({ error: 'order_not_found', orderId });
      return;
    }

    const missingSteps = missingHappyPathSteps(events);
    res.json({
      orderId,
      order: order === null ? null : toOrderStatusView(order),
      complete: missingSteps.length === 0,
      missingSteps,
      anomalies: events.filter((event) => event.type === 'order.anomaly_detected').length,
      events: events.map(toWireEvent),
    });
  });

  // ---------------------------------------------------------------------------
  // Viewer — the T7 SPA, served by this same app (no second deployment). The
  // build lands in `dist/viewer`; the routes below it (`/viewer/orders/:id`,
  // `/viewer/refusals/:seq`) are client-side, so anything without a matching
  // file falls back to the SPA's index. A missing build must not take the rest
  // of the app down: dev and test runs routinely have no viewer build, so the
  // fallback answers 404 with a hint instead of throwing at startup.
  // ---------------------------------------------------------------------------
  const viewerDistDir = path.resolve(deps.viewerDistDir ?? path.join(process.cwd(), 'dist/viewer'));
  const serveViewerIndex = (_req: Request, res: Response): void => {
    const indexPath = path.join(viewerDistDir, 'index.html');
    if (!existsSync(indexPath)) {
      res.status(404).json({ error: 'viewer_not_built' });
      return;
    }
    res.sendFile(indexPath);
  };
  app.get('/viewer', serveViewerIndex);
  app.use('/viewer', express.static(viewerDistDir));
  app.get('/viewer/*splat', serveViewerIndex);

  // Where Razorpay returns the human's browser after they approve the link.
  // Purely cosmetic: the webhook, not this redirect, is what marks the Order paid.
  app.get('/payment-callback', (req: Request, res: Response) => {
    const raw = req.query['orderId'];
    const orderId = typeof raw === 'string' ? raw : null;
    // Anyone can craft this URL, so the value is escaped for HTML and
    // percent-encoded for the href — never interpolated raw.
    const safeText = orderId === null ? null : escapeHtml(orderId);
    const safeHref = orderId === null ? null : escapeHtml(encodeURIComponent(orderId));

    res
      .status(200)
      .type('html')
      .send(
        `<!doctype html><meta charset="utf-8"><title>Payment received</title>` +
          `<body style="font-family:system-ui;max-width:34rem;margin:4rem auto;line-height:1.6">` +
          `<h1>Thanks — payment approved</h1>` +
          `<p>${escapeHtml(MERCHANT_NAME)} has been notified. Your agent can now call ` +
          `<code>get_order_status</code>.</p>` +
          (safeText === null
            ? ''
            : `<p>Order <code>${safeText}</code> — <a href="/audit/${safeHref}">audit trail</a></p>`) +
          `</body>`,
      );
  });

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ ok: true, service: 'agent-store', merchant: MERCHANT_NAME });
  });

  app.get('/', (_req: Request, res: Response) => {
    res.json({
      service: 'agent-store',
      merchant: MERCHANT_NAME,
      mcp: `${deps.publicBaseUrl}/mcp`,
      endpoints: [
        '/mcp',
        '/webhooks/razorpay',
        '/audit',
        '/audit/:orderId',
        '/audit/refusals/:seq',
        '/viewer',
        '/healthz',
      ],
    });
  });

  // Express 5 forwards rejected async handlers here. Details stay server-side:
  // a buyer agent gets a code it can act on, not a stack trace.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[agent-store] unhandled request error', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'internal_error' });
    }
  });

  return app;
}

import path from 'node:path';
import { Router, json, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { MERCHANT_NAME } from '../config.js';
import type { StorefrontDeps } from '../deps.js';
import {
  confirmProduct,
  findConfirmationProduct,
  listProductsNeedingConfirmation,
} from '../domain/confirmation.js';
import { ValidationError } from '../domain/refusal.js';

/**
 * The merchant confirmation face (T13, issue #14) — what the `/viewer/confirm`
 * screen reads and writes. Mounted at `/merchant`, and authless like every
 * other surface here: v1 has no merchant login (PLAN §10 cuts the analytics
 * dashboard, and the audit endpoints are already public by design); transport
 * auth is deployment-specific hardening, exactly as it is for the MCP face.
 *
 * Every publish decision is made server-side in `domain/confirmation.ts` — the
 * router only parses, so a client speaking raw HTTP meets the same "nothing
 * unconfirmed is ever published" wall as the UI.
 *
 * Error shapes follow the REST face's dialect (src/http/restFace.ts):
 *   - Malformed body    → 400 `{ error: 'invalid_request', issues }`
 *   - ValidationError   → `{ validationError: {code, message} }` with
 *                         404 for PRODUCT_NOT_FOUND, 409 for
 *                         PRODUCT_NOT_CONFIRMABLE, 400 otherwise.
 */

const confirmBody = z.object({
  title: z.string(),
  description: z.string().nullable(),
  variants: z
    .array(
      z.object({
        variantId: z.string().optional(),
        label: z.string().nullable(),
        pricePaise: z.number(),
        stock: z.number(),
      }),
    )
    .min(1),
});

export function createMerchantRouter(deps: StorefrontDeps): Router {
  const router = Router();
  // Self-sufficient like the REST face: mounting order in app.ts (webhook
  // raw-body first!) can never silently break this face.
  router.use(json({ limit: '1mb' }));

  // --- The worklist: every Product waiting on the merchant ------------------
  router.get('/confirmations', async (_req: Request, res: Response) => {
    const products = await listProductsNeedingConfirmation(deps.db, deps.merchantId);
    res.json({ merchant: MERCHANT_NAME, products });
  });

  // --- One Product, any status — after confirming this reads `published` ----
  router.get(
    '/confirmations/:productId',
    async (req: Request<{ productId: string }>, res: Response) => {
      const product = await findConfirmationProduct(deps.db, deps.merchantId, req.params.productId);
      if (product === null) {
        res.status(404).json({
          validationError: {
            code: 'PRODUCT_NOT_FOUND',
            message: `no product ${req.params.productId} for this merchant`,
          },
        });
        return;
      }
      res.json({ merchant: MERCHANT_NAME, product });
    },
  );

  // --- The source photo the caption came with, for the review screen --------
  router.get(
    '/confirmations/:productId/photo',
    async (req: Request<{ productId: string }>, res: Response) => {
      const product = await findConfirmationProduct(deps.db, deps.merchantId, req.params.productId);
      const imagePath = product?.extraction?.imagePath ?? null;
      if (imagePath === null) {
        res.status(404).json({ error: 'photo_not_found' });
        return;
      }
      // `imagePath` is repo-relative (written by our own ingest); `root` makes
      // express contain the resolved path, so even a hostile row cannot escape.
      res.sendFile(imagePath, { root: path.resolve(process.cwd()) }, (error) => {
        if (error !== undefined && !res.headersSent) {
          res.status(404).json({ error: 'photo_not_found' });
        }
      });
    },
  );

  // --- The confirmation itself: complete final state in, published out ------
  router.post(
    '/confirmations/:productId',
    async (req: Request<{ productId: string }>, res: Response) => {
      const parsed = confirmBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({
          error: 'invalid_request',
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
        return;
      }
      const confirmed = await confirmProduct(
        deps.db,
        deps.merchantId,
        req.params.productId,
        parsed.data,
      );
      res.json({
        productId: confirmed.productId,
        status: confirmed.status,
        product: confirmed.product,
        note: 'Published — the Product is immediately searchable and purchasable via MCP and REST.',
      });
    },
  );

  // --- The one place domain errors become merchant-face responses -----------
  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent || !(error instanceof ValidationError)) {
      next(error);
      return;
    }
    const status =
      error.code === 'PRODUCT_NOT_FOUND' ? 404 : error.code === 'PRODUCT_NOT_CONFIRMABLE' ? 409 : 400;
    res.status(status).json({ validationError: error.toPayload() });
  });

  return router;
}

/**
 * Process configuration, read once from the environment.
 *
 * v1 serves exactly one Merchant per deployment (PLAN §4), so the merchant's
 * identity is configuration, not routing.
 */

export interface Config {
  readonly port: number;
  readonly publicBaseUrl: string;
  readonly databaseUrl: string;
  readonly razorpay: {
    readonly keyId: string;
    readonly keySecret: string;
    readonly webhookSecret: string;
  };
}

class MissingEnvError extends Error {
  constructor(names: readonly string[]) {
    super(
      `Missing required environment variable(s): ${names.join(', ')}. ` +
        `See .env.example for what each one is and where to get it.`,
    );
    this.name = 'MissingEnvError';
  }
}

function requireEnv(env: NodeJS.ProcessEnv, names: readonly string[]): Record<string, string> {
  const missing = names.filter((n) => {
    const v = env[n];
    return v === undefined || v.trim() === '';
  });
  if (missing.length > 0) throw new MissingEnvError(missing);
  return Object.fromEntries(names.map((n) => [n, env[n] as string]));
}

/** Strip any trailing slashes so URL joining is `${base}/path` everywhere. */
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = requireEnv(env, [
    'DATABASE_URL',
    'RAZORPAY_KEY_ID',
    'RAZORPAY_KEY_SECRET',
    'RAZORPAY_WEBHOOK_SECRET',
    'PUBLIC_BASE_URL',
  ]);

  const port = Number.parseInt(env['PORT'] ?? '3000', 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, got: ${env['PORT']}`);
  }

  return {
    port,
    publicBaseUrl: normalizeBaseUrl(required['PUBLIC_BASE_URL'] as string),
    databaseUrl: required['DATABASE_URL'] as string,
    razorpay: {
      keyId: required['RAZORPAY_KEY_ID'] as string,
      keySecret: required['RAZORPAY_KEY_SECRET'] as string,
      webhookSecret: required['RAZORPAY_WEBHOOK_SECRET'] as string,
    },
  };
}

/**
 * The single Merchant this deployment serves. T1 hardcodes it; the ingestion
 * pipeline (M4) will write real catalog rows against this same merchant id.
 */
export const MERCHANT_ID = 'mrc_kalaakar_streetwear';
export const MERCHANT_NAME = 'Kalaakar Streetwear';

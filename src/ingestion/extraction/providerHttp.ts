import { ExtractionError } from '../types.js';

/**
 * The one POST both adapters make, with the retry policy from plan D5.
 *
 * Three attempts, and only for the two statuses that mean "the request was
 * fine, the server was not": 429 and 5xx. Every other 4xx is a bug in what we
 * sent — a wrong model id, a malformed schema, a dead key — and retrying it
 * three times just spends three times as long arriving at the same error.
 *
 * A rate limit that names a small `Retry-After` is honoured; a huge one is
 * not slept through, it is reported. The final error carries
 * `retryAfterSeconds` so the merchant-facing tool result can say "retry in N
 * seconds" instead of "something went wrong" (plan D5, ticket S1.3).
 */

const MAX_ATTEMPTS = 3;

/** Backoff before attempt 2 and attempt 3, when the provider names no delay. */
const BACKOFF_MS = [500, 1500] as const;

/**
 * A `Retry-After` longer than this is reported, not waited out. Ingestion runs
 * inside a chat tool call with a wall-clock budget of a few minutes (plan §1);
 * sleeping a minute inside it burns the budget the extraction still needs.
 */
const MAX_HONOURED_RETRY_AFTER_SECONDS = 20;

export interface PostJsonOptions {
  readonly url: string;
  readonly apiKey: string;
  readonly body: unknown;
  readonly timeoutMs: number;
  /** Merged after the standard ones, e.g. OpenRouter's `HTTP-Referer`. */
  readonly extraHeaders?: Readonly<Record<string, string>>;
  /** Names the provider in error messages, e.g. `OpenRouter`. */
  readonly label: string;
  /** Defaults to the global `fetch`. Injected by tests, never in production. */
  readonly fetchImpl?: typeof fetch;
  /** Injected by tests so backoff does not make the suite slow. */
  readonly sleepImpl?: (ms: number) => Promise<void>;
}

/** The response body as text. Non-2xx and timeouts throw `ExtractionError`. */
export async function postJson(options: PostJsonOptions): Promise<string> {
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const sleep = options.sleepImpl ?? defaultSleep;

  let lastError: ExtractionError | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const response = await postOnce(fetchImpl, options);
    const text = await response.text();
    if (response.ok) return text;

    const retryAfterSeconds = readRetryAfterSeconds(response);
    lastError = new ExtractionError(
      `${options.label} returned ${String(response.status)}: ${text.slice(0, 500)}`,
      undefined,
      retryAfterSeconds === undefined ? undefined : { retryAfterSeconds },
    );

    if (!isRetryable(response.status) || attempt === MAX_ATTEMPTS) break;

    const honoured =
      retryAfterSeconds !== undefined && retryAfterSeconds <= MAX_HONOURED_RETRY_AFTER_SECONDS
        ? retryAfterSeconds * 1000
        : (BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!);
    await sleep(honoured);
  }

  throw lastError ?? new ExtractionError(`${options.label} request failed`);
}

async function postOnce(fetchImpl: typeof fetch, options: PostJsonOptions): Promise<Response> {
  try {
    return await fetchImpl(options.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
        ...(options.extraHeaders ?? {}),
      },
      body: JSON.stringify(options.body),
      // Per *request*, not per call: a retry gets its own full budget.
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (cause) {
    // An abort is the timeout firing; anything else is DNS, TLS, socket.
    const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
    throw new ExtractionError(
      timedOut
        ? `${options.label} did not respond within ${String(options.timeoutMs)}ms`
        : `${options.label} request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  }
}

/** Only the statuses that mean "try the same request again" (plan D5). */
function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Seconds form only; the HTTP-date form is not what these providers send. */
function readRetryAfterSeconds(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (header === null) return undefined;
  const seconds = Number(header.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

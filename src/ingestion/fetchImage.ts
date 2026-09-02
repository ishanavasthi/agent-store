import { isIP } from 'node:net';
import { ValidationError } from '../domain/refusal.js';
import type { ExtractionImage } from './types.js';

/**
 * Fetch a merchant-supplied photo link into the `ExtractionImage` the
 * extraction seam already takes (S1.3).
 *
 * This is the one place in the server where a *caller-chosen URL* is fetched,
 * which makes it the whole server-side request forgery surface: without a
 * guard, `submit_catalog_item` would be a proxy that reads
 * `http://169.254.169.254/…` or a service on `localhost` and hands the bytes to
 * an LLM. So the guard is a security control (plan D4), not input hygiene:
 * http(s) only, no loopback/private/link-local address, `image/*` only, and a
 * hard 4 MiB cap enforced **twice** — once from `content-length`, and again
 * while the body streams, because a lying or absent header is exactly what a
 * hostile origin sends.
 *
 * Every failure is one `ValidationError('INVALID_IMAGE')`. The merchant's next
 * move is the same in every case (send a different, public link), and a finer
 * taxonomy would turn this into an address scanner that reports which hosts
 * exist.
 *
 * Known limit, accepted for v1: the guard checks the URL's own host and the
 * final `response.url` after redirects, so it catches a redirect into private
 * space, but a hostname whose DNS resolves to a private address slips through
 * (a resolve-then-pin fetch is the real fix). One merchant, one token, and the
 * bytes only ever reach the extraction model — see DECISIONS.md.
 */

/** 4 MiB. Comfortably above any phone photo, far below anything that hurts. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const IMAGE_FETCH_TIMEOUT_MS = 10_000;

export interface FetchImageOptions {
  readonly fetchImpl?: typeof fetch;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

function invalidImage(message: string): ValidationError {
  return new ValidationError('INVALID_IMAGE', message);
}

/** Refuses the address ranges that are "somewhere inside the deployment". */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) return true;

  const kind = isIP(host);
  if (kind === 0) return false; // A public DNS name; see the module comment.
  if (kind === 6) {
    // IPv4-mapped (`::ffff:127.0.0.1`) is an IPv4 address wearing a hat.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    if (mapped?.[1] !== undefined) return isBlockedHost(mapped[1]);
    if (host === '::1' || host === '::') return true;
    const head = host.split(':')[0] ?? '';
    if (/^f[cd][0-9a-f]{0,2}$/.test(head)) return true; // fc00::/7 unique-local
    if (/^fe[89ab][0-9a-f]?$/.test(head)) return true; // fe80::/10 link-local
    return false;
  }

  const parts = host.split('.').map(Number);
  const [a = 0, b = 0] = parts;
  if (a === 0 || a === 127) return true; // "this network" and loopback
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function requireAllowedUrl(raw: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalidImage(`${label} is not a URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw invalidImage(`${label} must be http or https, got ${url.protocol}`);
  }
  if (isBlockedHost(url.hostname)) {
    throw invalidImage(`${label} points at a private or loopback address (${url.hostname})`);
  }
  return url;
}

export async function fetchImage(
  rawUrl: string,
  options: FetchImageOptions = {},
): Promise<ExtractionImage> {
  const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES;
  const timeoutMs = options.timeoutMs ?? IMAGE_FETCH_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;
  const url = requireAllowedUrl(rawUrl, 'imageUrl');

  let response: Response;
  try {
    response = await doFetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'image/*' },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw invalidImage(`could not fetch imageUrl within ${String(timeoutMs)}ms: ${reason}`);
  }

  // A redirect into private space is the same attack by another route, so the
  // address the response actually came from is checked too.
  if (typeof response.url === 'string' && response.url !== '') {
    requireAllowedUrl(response.url, 'imageUrl (after redirect)');
  }
  if (!response.ok) {
    throw invalidImage(`imageUrl returned HTTP ${String(response.status)}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  const mediaType = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  if (!mediaType.startsWith('image/')) {
    throw invalidImage(`imageUrl must serve an image, got content-type ${contentType || '(none)'}`);
  }

  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw invalidImage(`image is ${String(declared)} bytes; the limit is ${String(maxBytes)}`);
  }

  const bytes = await readCapped(response, maxBytes);
  if (bytes.byteLength === 0) throw invalidImage('imageUrl returned an empty body');
  return { mediaType, base64: Buffer.from(bytes).toString('base64') };
}

/**
 * The second half of the cap: stop reading the moment the body exceeds the
 * limit, rather than buffering whatever an origin decides to send.
 */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const body = response.body;
  if (body === null) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw invalidImage(`image body exceeds the ${String(maxBytes)} byte limit`);
    }
    return buffer;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw invalidImage(`image body exceeds the ${String(maxBytes)} byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

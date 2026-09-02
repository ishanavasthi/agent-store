import { describe, expect, it } from 'vitest';
import { ValidationError } from '../domain/refusal.js';
import { fetchImage, isBlockedHost, MAX_IMAGE_BYTES } from './fetchImage.js';

/**
 * S1.3 (issue #41): the address guard is plan D4 — a security control, not
 * input hygiene. `submit_catalog_item` is the only place a caller-chosen URL
 * is fetched, so every refusal below is the difference between a photo fetcher
 * and an SSRF proxy. Each one is asserted separately because each one is a
 * separate way in.
 */

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

function respond(
  body: Uint8Array | string,
  headers: Record<string, string>,
  init: { status?: number; url?: string } = {},
): typeof fetch {
  return (() => {
    const response = new Response(typeof body === 'string' ? body : body, {
      status: init.status ?? 200,
      headers,
    });
    if (init.url !== undefined) Object.defineProperty(response, 'url', { value: init.url });
    return Promise.resolve(response);
  }) as unknown as typeof fetch;
}

const never: typeof fetch = () => {
  throw new Error('fetch must not be called');
};

async function refusal(promise: Promise<unknown>): Promise<ValidationError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return error as ValidationError;
  }
  throw new Error('expected INVALID_IMAGE, but the fetch resolved');
}

describe('fetchImage', () => {
  it('reads a public jpeg into the ExtractionImage the model already takes', async () => {
    const image = await fetchImage('https://cdn.example.com/drop.jpg', {
      fetchImpl: respond(JPEG, { 'content-type': 'image/jpeg; charset=binary' }),
    });
    expect(image).toEqual({ mediaType: 'image/jpeg', base64: JPEG.toString('base64') });
  });

  it('refuses any scheme but http and https, without fetching', async () => {
    for (const url of ['file:///etc/passwd', 'data:image/png;base64,AAAA', 'ftp://x.example/a.jpg']) {
      const error = await refusal(fetchImage(url, { fetchImpl: never }));
      expect(error.code, url).toBe('INVALID_IMAGE');
    }
  });

  it('refuses loopback, private and link-local addresses, without fetching', async () => {
    const blocked = [
      'http://localhost:3000/a.jpg',
      'http://127.0.0.1/a.jpg',
      'http://10.1.2.3/a.jpg',
      'http://172.16.0.9/a.jpg',
      'http://192.168.1.5/a.jpg',
      // The cloud metadata endpoint — the reason this guard exists at all.
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      'http://[::1]/a.jpg',
      'http://[fe80::1]/a.jpg',
      'http://[fd00::1]/a.jpg',
      'http://[::ffff:127.0.0.1]/a.jpg',
    ];
    for (const url of blocked) {
      const error = await refusal(fetchImage(url, { fetchImpl: never }));
      expect(error.code, url).toBe('INVALID_IMAGE');
    }
    // …and a public address is not caught by the same net.
    expect(isBlockedHost('cdn.example.com')).toBe(false);
    expect(isBlockedHost('93.184.216.34')).toBe(false);
    expect(isBlockedHost('172.32.0.1')).toBe(false);
  });

  it('refuses a redirect that lands on a private address', async () => {
    const error = await refusal(
      fetchImage('https://cdn.example.com/drop.jpg', {
        fetchImpl: respond(JPEG, { 'content-type': 'image/jpeg' }, { url: 'http://127.0.0.1/a.jpg' }),
      }),
    );
    expect(error.code).toBe('INVALID_IMAGE');
  });

  it('refuses a response that is not an image', async () => {
    const error = await refusal(
      fetchImage('https://cdn.example.com/drop.jpg', {
        fetchImpl: respond('<html>not a photo</html>', { 'content-type': 'text/html' }),
      }),
    );
    expect(error.message).toContain('text/html');
  });

  it('refuses an oversize image declared by content-length, before reading it', async () => {
    const error = await refusal(
      fetchImage('https://cdn.example.com/huge.jpg', {
        fetchImpl: respond(JPEG, {
          'content-type': 'image/jpeg',
          'content-length': String(MAX_IMAGE_BYTES + 1),
        }),
      }),
    );
    expect(error.code).toBe('INVALID_IMAGE');
  });

  it('refuses an oversize body even when the header lies about the size', async () => {
    const error = await refusal(
      fetchImage('https://cdn.example.com/huge.jpg', {
        maxBytes: 64,
        fetchImpl: respond(new Uint8Array(4096), {
          'content-type': 'image/jpeg',
          'content-length': '10',
        }),
      }),
    );
    expect(error.message).toContain('exceeds');
  });

  it('gives up when the origin never answers', async () => {
    const hangs: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('The operation was aborted due to timeout'));
        });
      });
    const error = await refusal(
      fetchImage('https://cdn.example.com/slow.jpg', { fetchImpl: hangs, timeoutMs: 20 }),
    );
    expect(error.code).toBe('INVALID_IMAGE');
    expect(error.message).toContain('20ms');
  });

  it('surfaces a non-2xx as INVALID_IMAGE rather than a raw HTTP error', async () => {
    const error = await refusal(
      fetchImage('https://cdn.example.com/gone.jpg', {
        fetchImpl: respond('', { 'content-type': 'image/jpeg' }, { status: 404 }),
      }),
    );
    expect(error.message).toContain('404');
  });
});

import { describe, expect, it } from 'vitest';
import { ExtractionError } from '../types.js';
import { postJson } from './providerHttp.js';

/**
 * The retry policy from plan D5, with the clock injected: three attempts, and
 * only for the statuses that mean "the server was busy", never for the ones
 * that mean "your request was wrong".
 */

/** Replies with the queued responses in order, recording what it was asked. */
function scriptedFetch(
  replies: readonly { status: number; body?: unknown; retryAfter?: string }[],
) {
  const calls: RequestInit[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const reply = replies[calls.length] ?? replies[replies.length - 1]!;
    calls.push(init ?? {});
    const headers: Record<string, string> =
      reply.retryAfter === undefined ? {} : { 'Retry-After': reply.retryAfter };
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status,
      headers,
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const slept: number[] = [];
const sleepImpl = async (ms: number): Promise<void> => {
  slept.push(ms);
};

const options = {
  url: 'https://provider.example/v1/chat/completions',
  apiKey: 'k',
  body: { model: 'm' },
  timeoutMs: 5_000,
  label: 'OpenRouter',
  sleepImpl,
};

describe('a request that eventually succeeds', () => {
  it('retries a 429 and returns the second body', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      { status: 429, body: { error: 'slow down' } },
      { status: 200, body: { ok: true } },
    ]);

    const text = await postJson({ ...options, fetchImpl });

    expect(JSON.parse(text)).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it('retries a 500 too', async () => {
    const { fetchImpl, calls } = scriptedFetch([{ status: 500 }, { status: 200, body: { ok: 1 } }]);
    await postJson({ ...options, fetchImpl });
    expect(calls).toHaveLength(2);
  });

  it('sends the key, the JSON body and any extra headers', async () => {
    const { fetchImpl, calls } = scriptedFetch([{ status: 200, body: {} }]);
    await postJson({
      ...options,
      fetchImpl,
      extraHeaders: { 'X-Title': 'agent-store' },
    });

    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers).toEqual({
      Authorization: 'Bearer k',
      'Content-Type': 'application/json',
      'X-Title': 'agent-store',
    });
    expect(calls[0]!.body).toBe(JSON.stringify({ model: 'm' }));
  });
});

describe('a request that fails', () => {
  it('never retries a 400 — the request itself is what is wrong', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      { status: 400, body: { error: { message: 'unknown model' } } },
    ]);

    await expect(postJson({ ...options, fetchImpl })).rejects.toThrow(
      /OpenRouter returned 400: .*unknown model/,
    );
    expect(calls).toHaveLength(1);
  });

  it('gives up after exactly three attempts, carrying the retry-after hint', async () => {
    slept.length = 0;
    const { fetchImpl, calls } = scriptedFetch([
      { status: 429, retryAfter: '2' },
      { status: 429, retryAfter: '2' },
      { status: 429, retryAfter: '7' },
    ]);

    const error = await postJson({ ...options, fetchImpl }).catch((cause: unknown) => cause);

    expect(calls).toHaveLength(3);
    expect(error).toBeInstanceOf(ExtractionError);
    expect((error as ExtractionError).retryAfterSeconds).toBe(7);
    // A small Retry-After is honoured in place of the default backoff.
    expect(slept).toEqual([2000, 2000]);
  });

  it('reports rather than sleeps through an implausibly long Retry-After', async () => {
    slept.length = 0;
    const { fetchImpl } = scriptedFetch([
      { status: 429, retryAfter: '600' },
      { status: 200, body: {} },
    ]);

    await postJson({ ...options, fetchImpl });

    expect(slept).toEqual([500]);
  });

  it('aborts a request that never answers, at the configured timeout', async () => {
    // Resolves only when the injected AbortSignal fires, which is the timeout.
    const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject((init.signal as AbortSignal).reason as Error);
        });
      })) as unknown as typeof fetch;

    await expect(postJson({ ...options, timeoutMs: 20, fetchImpl })).rejects.toThrow(
      /OpenRouter did not respond within 20ms/,
    );
  });
});

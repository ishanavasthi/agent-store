import { useEffect, useState } from 'react';
import { ApiError } from './api';

export type Loadable<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly title: string; readonly body: string }
  | { readonly status: 'ok'; readonly data: T };

/** A fetch failure is a first-class screen state here, never a blank page. */
export function useLoad<T>(load: () => Promise<T>, key: string): Loadable<T> {
  const [state, setState] = useState<Loadable<T>>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    load().then(
      (data) => {
        if (!cancelled) setState({ status: 'ok', data });
      },
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError) {
          const code =
            typeof error.body === 'object' &&
            error.body !== null &&
            typeof (error.body as Record<string, unknown>)['error'] === 'string'
              ? String((error.body as Record<string, unknown>)['error'])
              : null;
          setState({
            status: 'error',
            title: code === null ? `The server answered ${error.status}` : code.replace(/_/g, ' '),
            body:
              error.status === 404 && code !== null
                ? 'Nothing in the audit log answers to this address. Check the id in the URL, or start from the ledger.'
                : error.status === 404
                  ? 'This server has no audit endpoint at that path. Is it running the current build?'
                  : 'The audit endpoint returned an error. The server logs will say more.',
          });
        } else {
          setState({
            status: 'error',
            title: 'Could not reach the audit log',
            body: 'The viewer reads /audit on the same host it is served from. Is the server running?',
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
    // The key string is the identity of the request; `load` is assumed stable for a given key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state;
}

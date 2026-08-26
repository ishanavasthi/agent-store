/** Small shared renderings: money, hashes, timestamps, status — the ledger's atoms. */

import { displayPaise } from '../money';

/** The paise integer is the fact and always on screen; ₹ is derived and secondary. */
export function Money({ paise }: { paise: unknown }) {
  const shown = displayPaise(paise);
  return (
    <span className="money">
      <span className="money-paise">{shown.paise}</span>
      {shown.rupees === null ? null : <span className="money-rupees"> ({shown.rupees})</span>}
    </span>
  );
}

/** First 12 chars visible; the full hash rides on the title for hover/copy. */
export function Hash({ value }: { value: string }) {
  const short = value.length > 12 ? `${value.slice(0, 12)}…` : value;
  return (
    <span className="hash" title={value}>
      {short}
    </span>
  );
}

/** Booleans in untrusted payloads: render as words, or "—" when not stated. */
export function YesNo({ value }: { value: unknown }) {
  return <>{typeof value === 'boolean' ? (value ? 'yes' : 'no') : '—'}</>;
}

export function Timestamp({ iso }: { iso: string }) {
  const date = new Date(iso);
  const text = Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'medium' });
  return (
    <time className="timestamp" dateTime={iso} title={iso}>
      {text}
    </time>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone = status === 'paid' ? 'ok' : status === 'refunded' || status === 'cancelled' ? 'bad' : 'wait';
  return <span className={`status status-${tone}`}>{status}</span>;
}

export function Loading({ what }: { what: string }) {
  return <p className="panel panel-muted">Loading {what}…</p>;
}

export function ErrorPanel({ title, body }: { title: string; body?: string }) {
  return (
    <div className="panel panel-error" role="alert">
      <p className="panel-title">{title}</p>
      {body === undefined ? null : <p>{body}</p>}
    </div>
  );
}

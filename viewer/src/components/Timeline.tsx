/**
 * The ledger itself: one row per audit event, in seq order, with the log's own
 * monotonic seq as the line number. Events are rendered defensively — payload
 * facts are derived by shape (…Paise → money, …Hash → short hash), so unknown
 * or future event types still render completely.
 */

import type { AuditEvent } from '../api';
import { explainEvent } from '../explainEvent';
import { Hash, Money, Timestamp } from './Bits';

function FactValue({ name, value }: { name: string; value: unknown }) {
  if (name.endsWith('Paise')) return <Money paise={value} />;
  if (typeof value === 'string' && (name.endsWith('Hash') || name === 'priceHash')) {
    return <Hash value={value} />;
  }
  if (value === null) return <span className="fact-null">—</span>;
  if (typeof value === 'boolean') return <>{value ? 'yes' : 'no'}</>;
  if (typeof value === 'string' || typeof value === 'number') return <>{String(value)}</>;
  return <>{JSON.stringify(value)}</>;
}

/** Cart lines get a real list; `reason` is omitted — the verdict line already speaks it. */
function Facts({ payload }: { payload: Record<string, unknown> }) {
  const entries = Object.entries(payload).filter(([key]) => key !== 'reason' && key !== 'items');
  const items = Array.isArray(payload['items']) ? (payload['items'] as unknown[]) : null;
  if (entries.length === 0 && items === null) return null;
  return (
    <dl className="facts">
      {entries.map(([key, value]) => (
        <div className="fact" key={key}>
          <dt>{key}</dt>
          <dd>
            <FactValue name={key} value={value} />
          </dd>
        </div>
      ))}
      {items === null ? null : (
        <div className="fact fact-wide">
          <dt>items</dt>
          <dd>
            {items.map((item, i) => {
              const line = item as Record<string, unknown>;
              return (
                <span className="cart-line" key={i}>
                  {String(line['variantId'] ?? '?')} × {String(line['quantity'] ?? '?')}
                </span>
              );
            })}
          </dd>
        </div>
      )}
    </dl>
  );
}

function EventCard({ event }: { event: AuditEvent }) {
  const explanation = explainEvent(event.type, event.payload);
  return (
    <article className={`event event-${explanation.verdict}`}>
      <div className="event-seq" aria-label={`audit seq ${event.seq}`}>
        {event.seq}
      </div>
      <div className="event-body">
        <header className="event-head">
          <span className="event-type">{event.type}</span>
          <Timestamp iso={event.occurredAt} />
        </header>
        <p className="event-summary">{event.summary}</p>
        <div className={`verdict verdict-${explanation.verdict}`}>
          {explanation.label === '' ? null : <span className="verdict-label">{explanation.label}</span>}
          <p className="verdict-line">
            {explanation.line}
            {explanation.detail === undefined ? null : (
              <span className="verdict-detail"> {explanation.detail}</span>
            )}
          </p>
        </div>
        <Facts payload={event.payload} />
        <details className="raw">
          <summary>raw payload</summary>
          <pre>{JSON.stringify(event.payload, null, 2)}</pre>
        </details>
      </div>
    </article>
  );
}

export function Timeline({ events }: { events: readonly AuditEvent[] }) {
  return (
    <div className="timeline">
      {events.map((event) => (
        <EventCard key={event.seq} event={event} />
      ))}
    </div>
  );
}

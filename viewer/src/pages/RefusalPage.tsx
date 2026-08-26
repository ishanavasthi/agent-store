/**
 * One Refusal replayed. A Refusal has no Order — it is addressed by its audit
 * seq, and its context (the Intent and Cart mandates it refused against, plus
 * sibling refusals) is linked through the hashes its payload already carries.
 */

import { Link, useParams } from 'react-router-dom';
import { fetchRefusalAudit } from '../api';
import { ErrorPanel, Loading, Timestamp, YesNo } from '../components/LedgerAtoms';
import { Timeline } from '../components/Timeline';
import { useLoad } from '../useLoad';

export function RefusalPage() {
  const { seq = '' } = useParams();
  const state = useLoad(() => fetchRefusalAudit(seq), `refusal:${seq}`);

  if (state.status === 'loading') return <Loading what={`Refusal ${seq}`} />;
  if (state.status === 'error') return <ErrorPanel title={state.title} body={state.body} />;

  const { refusal, events } = state.data;
  const code = refusal.payload['code'];
  const reason = refusal.payload['reason'];
  const recoverable = refusal.payload['recoverable'];

  return (
    <div>
      <p className="crumb">
        <Link to="/">← Ledger</Link>
      </p>
      <header className="page-head">
        <p className="eyebrow">Refusal · audit seq {refusal.seq}</p>
        <h2 className="page-id page-id-refused">{typeof code === 'string' ? code : refusal.type}</h2>
        {typeof reason === 'string' ? <p className="refusal-reason">{reason}</p> : null}
        <dl className="head-facts">
          <div>
            <dt>event</dt>
            <dd>{refusal.type}</dd>
          </div>
          <div>
            <dt>recoverable</dt>
            <dd>
              <YesNo value={recoverable} />
            </dd>
          </div>
          <div>
            <dt>refused at</dt>
            <dd>
              <Timestamp iso={refusal.occurredAt} />
            </dd>
          </div>
        </dl>
        <p className="section-note">
          No money moved. A Refusal is the trust layer's answer, given before the gateway is ever
          contacted.
        </p>
      </header>

      <h3 className="section-head">Purchase-attempt context</h3>
      {events.length <= 1 ? (
        <p className="section-note">
          This Refusal is its own complete story — it was refused before any mandate was stored,
          so there is no earlier context to show.
        </p>
      ) : (
        <p className="section-note">
          The mandates this attempt was refused against, linked by the hashes in the Refusal's own
          payload, in audit seq order.
        </p>
      )}
      <Timeline events={events} />
    </div>
  );
}

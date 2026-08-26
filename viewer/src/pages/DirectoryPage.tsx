/** The ledger's front page: recent Orders and recent Refusals, newest first. */

import { Link } from 'react-router-dom';
import { fetchDirectory } from '../api';
import { ErrorPanel, Loading, Money, StatusBadge, Timestamp } from '../components/Bits';
import { useLoad } from '../useLoad';

export function DirectoryPage() {
  const state = useLoad(fetchDirectory, 'directory');

  if (state.status === 'loading') return <Loading what="the ledger" />;
  if (state.status === 'error') return <ErrorPanel title={state.title} body={state.body} />;

  const { merchant, orders, refusals } = state.data;

  return (
    <div>
      <p className="merchant-line">
        Merchant: <strong>{merchant}</strong>
      </p>

      <section>
        <h2 className="section-head">
          Orders <span className="section-count">{orders.length}</span>
        </h2>
        {orders.length === 0 ? (
          <p className="panel panel-muted">
            No Orders yet. A completed purchase writes its whole mandate chain here.
          </p>
        ) : (
          <ul className="dir-list">
            {orders.map((order) => (
              <li key={order.orderId}>
                <Link className="dir-row" to={`/orders/${encodeURIComponent(order.orderId)}`}>
                  <span className="dir-id">{order.orderId}</span>
                  <StatusBadge status={order.status} />
                  <Money paise={order.total.amountPaise} />
                  <Timestamp iso={order.createdAt} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="section-head">
          Refusals <span className="section-count">{refusals.length}</span>
        </h2>
        <p className="section-note">
          The trust layer saying no on policy, before any money moved. Each carries a structured
          code and reason.
        </p>
        {refusals.length === 0 ? (
          <p className="panel panel-muted">No Refusals recorded. Every no will show up here with its reason code.</p>
        ) : (
          <ul className="dir-list">
            {refusals.map((refusal) => {
              const code = refusal.payload['code'];
              return (
                <li key={refusal.seq}>
                  <Link className="dir-row dir-row-refusal" to={`/refusals/${refusal.seq}`}>
                    <span className="dir-seq">{refusal.seq}</span>
                    <span className="dir-code">{typeof code === 'string' ? code : refusal.type}</span>
                    <span className="dir-type">{refusal.type}</span>
                    <Timestamp iso={refusal.occurredAt} />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

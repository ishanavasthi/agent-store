/** One Order replayed end-to-end: header facts, completeness ruling, then the ledger. */

import { Link, useParams } from 'react-router-dom';
import { fetchOrderAudit } from '../api';
import { ErrorPanel, Hash, Loading, Money, StatusBadge, Timestamp } from '../components/LedgerAtoms';
import { Timeline } from '../components/Timeline';
import { useLoad } from '../useLoad';

export function OrderPage() {
  const { orderId = '' } = useParams();
  const state = useLoad(() => fetchOrderAudit(orderId), `order:${orderId}`);

  if (state.status === 'loading') return <Loading what={`Order ${orderId}`} />;
  if (state.status === 'error') return <ErrorPanel title={state.title} body={state.body} />;

  const { order, complete, missingSteps, anomalies, events } = state.data;

  return (
    <div>
      <p className="crumb">
        <Link to="/">← Ledger</Link>
      </p>
      <header className="page-head">
        <p className="eyebrow">Order</p>
        <h2 className="page-id">{orderId}</h2>
        {order === null ? (
          <p className="section-note">
            No Order row exists — only audit events answer to this id. The trail below is still
            the complete record of what happened.
          </p>
        ) : (
          <dl className="head-facts">
            <div>
              <dt>status</dt>
              <dd>
                <StatusBadge status={order.status} />
              </dd>
            </div>
            <div>
              <dt>total</dt>
              <dd>
                <Money paise={order.total.amountPaise} />
              </dd>
            </div>
            <div>
              <dt>created</dt>
              <dd>
                <Timestamp iso={order.createdAt} />
              </dd>
            </div>
            {order.paidAt === null ? null : (
              <div>
                <dt>paid</dt>
                <dd>
                  <Timestamp iso={order.paidAt} />
                </dd>
              </div>
            )}
            {order.gatewayOrderId === null ? null : (
              <div>
                <dt>gateway order</dt>
                <dd>
                  <Hash value={order.gatewayOrderId} />
                </dd>
              </div>
            )}
            {order.gatewayPaymentId === null ? null : (
              <div>
                <dt>gateway payment</dt>
                <dd>
                  <Hash value={order.gatewayPaymentId} />
                </dd>
              </div>
            )}
          </dl>
        )}
      </header>

      {complete ? (
        <div className="banner banner-complete" role="status">
          <span className="banner-stamp">Complete</span>
          Every required transition of the happy path is present — mandate chain, verification,
          gateway, payment and Receipt.
        </div>
      ) : (
        <div className="banner banner-incomplete" role="status">
          <span className="banner-stamp">Incomplete</span>
          Required transitions still missing:{' '}
          <span className="banner-steps">{missingSteps.join(', ')}</span>
        </div>
      )}
      {anomalies > 0 ? (
        <div className="banner banner-anomaly" role="status">
          <span className="banner-stamp">
            {anomalies} {anomalies === 1 ? 'anomaly' : 'anomalies'}
          </span>
          Something arrived that was deliberately not acted on — the events below say why.
        </div>
      ) : null}

      <Timeline events={events} />
    </div>
  );
}

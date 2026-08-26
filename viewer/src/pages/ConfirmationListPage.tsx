/** The confirmation desk's worklist: every Product ingestion held for a human answer. */

import { Link } from 'react-router-dom';
import { fetchConfirmations, type ConfirmationProduct } from '../api';
import { ErrorPanel, Loading } from '../components/LedgerAtoms';
import { useLoad } from '../useLoad';

function holdSummary(product: ConfirmationProduct): string {
  const holds = product.extraction?.holds ?? [];
  if (holds.length === 0) return 'held';
  const fields = [...new Set(holds.map((hold) => hold.field))];
  return fields.join(', ');
}

export function ConfirmationListPage() {
  const state = useLoad(fetchConfirmations, 'confirmations');

  if (state.status === 'loading') return <Loading what="the confirmation worklist" />;
  if (state.status === 'error') return <ErrorPanel title={state.title} body={state.body} />;

  const { merchant, products } = state.data;

  return (
    <div>
      <p className="merchant-line">
        Merchant: <strong>{merchant}</strong>
      </p>

      <section>
        <h2 className="section-head">
          Awaiting confirmation <span className="section-count">{products.length}</span>
        </h2>
        <p className="section-note">
          One below-threshold or missing field holds the whole Product out of{' '}
          <code>published</code> — no half-visible products. Confirm or correct each flagged
          field, state every Variant's stock, and the Product becomes buyable the moment you
          publish.
        </p>
        {products.length === 0 ? (
          <p className="panel panel-muted">
            Nothing awaits confirmation — every ingested Product has published.
          </p>
        ) : (
          <ul className="dir-list">
            {products.map((product) => (
              <li key={product.productId}>
                <Link
                  className="dir-row dir-row-confirm"
                  to={`/confirm/${encodeURIComponent(product.productId)}`}
                >
                  <span className="confirm-title">{product.title}</span>
                  <span className="confirm-holds">{holdSummary(product)}</span>
                  <span className="dir-type">
                    {product.variants.length}{' '}
                    {product.variants.length === 1 ? 'variant' : 'variants'}
                  </span>
                  <span className="dir-id">{product.productId}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * One held Product, reviewed and published. The left half is the evidence —
 * photo, caption, and every extracted field with the model's own confidence,
 * flagged where it fell below the auto-publish threshold. The right half is the
 * merchant's answer: the complete final state (title, description, every
 * Variant's price and stock) that POST /merchant/confirmations/:productId
 * validates server-side before anything publishes. The UI never decides what
 * may publish — it just makes the server's questions easy to answer.
 */

import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  describeApiError,
  fetchConfirmationProduct,
  photoUrl,
  postConfirmation,
  type ConfirmationProduct,
  type ConfirmationResult,
  type RecordedField,
} from '../api';
import { ErrorPanel, Loading, Money } from '../components/LedgerAtoms';
import { paiseFromRupeeInput, rupeeInputFromPaise } from '../money';
import { useLoad } from '../useLoad';

// ---------------------------------------------------------------------------
// Form model — strings while editing; parsed only at submit time.
// ---------------------------------------------------------------------------

interface VariantDraft {
  readonly key: string;
  readonly variantId?: string;
  readonly label: string;
  readonly price: string;
  readonly stock: string;
}

interface Draft {
  readonly title: string;
  readonly description: string;
  readonly variants: readonly VariantDraft[];
}

let draftKeySeq = 0;
const nextKey = (): string => `draft-${draftKeySeq++}`;

function initialDraft(product: ConfirmationProduct): Draft {
  return {
    title: product.title,
    description: product.description ?? '',
    variants: product.variants.map((variant) => ({
      key: nextKey(),
      variantId: variant.variantId,
      label: variant.label ?? '',
      price: rupeeInputFromPaise(variant.pricePaise),
      stock: variant.stock === null ? '' : String(variant.stock),
    })),
  };
}

function showValue(value: unknown): string {
  if (value === null || value === undefined) return 'not found';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.length === 0 ? 'none stated' : value.map(String).join(', ');
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.length === 0
      ? 'none stated'
      : entries.map(([k, v]) => `${k}: ${String(v)}`).join(' · ');
  }
  return String(value);
}

function FieldRow({ name, field }: { name: string; field: RecordedField }) {
  return (
    <div className={`readout-row${field.belowThreshold ? ' readout-row-flagged' : ''}`}>
      <dt>
        {name}
        {field.belowThreshold ? <span className="flag">held</span> : null}
      </dt>
      <dd>
        <span className={field.value === null ? 'fact-null' : ''}>{showValue(field.value)}</span>
        <span className="confidence" title="Model's self-reported confidence — ranked, never trusted">
          {field.confidence.toFixed(2)}
        </span>
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The page: load, then hand the product to the form.
// ---------------------------------------------------------------------------

export function ConfirmProductPage() {
  const { productId = '' } = useParams();
  const state = useLoad(() => fetchConfirmationProduct(productId), `confirm:${productId}`);

  if (state.status === 'loading') return <Loading what={`Product ${productId}`} />;
  if (state.status === 'error') return <ErrorPanel title={state.title} body={state.body} />;

  return <ConfirmProduct product={state.data.product} />;
}

function ConfirmProduct({ product }: { product: ConfirmationProduct }) {
  const [draft, setDraft] = useState<Draft>(() => initialDraft(product));
  const [problem, setProblem] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmed, setConfirmed] = useState<ConfirmationResult | null>(null);
  const [photoMissing, setPhotoMissing] = useState(false);

  const extraction = product.extraction;

  if (confirmed !== null) {
    return (
      <div>
        <p className="crumb">
          <Link to="/confirm">← Confirmation desk</Link>
        </p>
        <div className="banner banner-complete" role="status">
          <span className="banner-stamp">Published</span>
          {confirmed.product.title} is live — immediately searchable and purchasable by buyer
          Agents via MCP and REST.
        </div>
        <dl className="head-facts">
          {confirmed.product.variants.map((variant) => (
            <div key={variant.variantId}>
              <dt>{variant.label ?? 'default variant'}</dt>
              <dd>
                <Money paise={variant.pricePaise} /> · stock {variant.stock ?? '—'}
              </dd>
            </div>
          ))}
        </dl>
        <p className="section-note">
          Back to the <Link to="/confirm">worklist</Link>, or watch the first purchase land in
          the <Link to="/">audit ledger</Link>.
        </p>
      </div>
    );
  }

  if (product.status !== 'needs_confirmation') {
    return (
      <div>
        <p className="crumb">
          <Link to="/confirm">← Confirmation desk</Link>
        </p>
        <p className="panel panel-muted">
          {product.title} is <code>{product.status}</code> — nothing awaits confirmation here.
        </p>
      </div>
    );
  }

  const holds = extraction?.holds ?? [];
  const statedTotal =
    extraction !== null && typeof extraction.fields['stock']?.value === 'number'
      ? (extraction.fields['stock'].value as number)
      : null;
  const missingStockCount = draft.variants.filter((v) => v.stock.trim() === '').length;

  function updateVariant(key: string, patch: Partial<VariantDraft>): void {
    setDraft((current) => ({
      ...current,
      variants: current.variants.map((v) => (v.key === key ? { ...v, ...patch } : v)),
    }));
  }

  function removeVariant(key: string): void {
    setDraft((current) => ({
      ...current,
      variants: current.variants.filter((v) => v.key !== key),
    }));
  }

  function addVariant(): void {
    const shared = draft.variants[0]?.price ?? '';
    setDraft((current) => ({
      ...current,
      variants: [...current.variants, { key: nextKey(), label: '', price: shared, stock: '' }],
    }));
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setProblem(null);

    // Courtesy pre-checks only — the server re-validates everything and is
    // the authority on what may publish.
    if (draft.title.trim() === '') {
      setProblem('Give the product a title.');
      return;
    }
    if (draft.variants.length === 0) {
      setProblem('A product needs at least one variant to sell.');
      return;
    }
    const submissionVariants = [];
    for (const [index, variant] of draft.variants.entries()) {
      const where = variant.label.trim() === '' ? `variant ${index + 1}` : variant.label.trim();
      const pricePaise = paiseFromRupeeInput(variant.price);
      if (pricePaise === null || pricePaise === 0) {
        setProblem(`State a price in rupees for ${where} — e.g. 1299 or 1299.50.`);
        return;
      }
      const stockText = variant.stock.trim();
      if (!/^[0-9]+$/.test(stockText)) {
        setProblem(
          `State the stock for ${where} as a whole number (0 means sold out). ` +
            'Publishing without a stated count is refused by the server.',
        );
        return;
      }
      const label = variant.label.trim();
      submissionVariants.push({
        ...(variant.variantId === undefined ? {} : { variantId: variant.variantId }),
        label: label === '' ? null : label,
        pricePaise,
        stock: Number(stockText),
      });
    }

    setSubmitting(true);
    try {
      const result = await postConfirmation(product.productId, {
        title: draft.title.trim(),
        description: draft.description.trim() === '' ? null : draft.description.trim(),
        variants: submissionVariants,
      });
      setConfirmed(result);
    } catch (error) {
      setProblem(describeApiError(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <p className="crumb">
        <Link to="/confirm">← Confirmation desk</Link>
      </p>
      <header className="page-head">
        <p className="eyebrow">Needs confirmation</p>
        <h2 className="page-id">{product.productId}</h2>
      </header>

      {holds.length > 0 ? (
        <div className="banner banner-incomplete" role="status">
          <span className="banner-stamp">
            {holds.length} {holds.length === 1 ? 'hold' : 'holds'}
          </span>
          <ul className="hold-list">
            {holds.map((hold) => (
              <li key={`${hold.field}:${hold.reason}`}>
                <strong>{hold.field}</strong> — {hold.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="confirm-layout">
        {/* ---- the evidence ------------------------------------------------ */}
        <section className="evidence">
          <h3 className="section-head">What ingestion read</h3>
          {extraction === null ? (
            <p className="panel panel-muted">
              This Product has no extraction record — it was seeded by hand, not ingested.
            </p>
          ) : (
            <>
              {extraction.imagePath !== null && !photoMissing ? (
                <img
                  className="evidence-photo"
                  src={photoUrl(product.productId)}
                  alt={`Source photo for ${product.title}`}
                  onError={() => setPhotoMissing(true)}
                />
              ) : null}
              <blockquote className="caption">{extraction.caption}</blockquote>
              <dl className="readout">
                {Object.entries(extraction.fields).map(([name, field]) => (
                  <FieldRow key={name} name={name} field={field} />
                ))}
              </dl>
              <p className="evidence-meta">
                Extracted by <code>{extraction.modelId}</code> · auto-publish threshold{' '}
                {extraction.threshold.toFixed(2)} · confidences are the model's own and are
                ranked, never trusted.
              </p>
            </>
          )}
        </section>

        {/* ---- the answer -------------------------------------------------- */}
        <form className="answer" onSubmit={(event) => void submit(event)}>
          <h3 className="section-head">Your answer</h3>

          <label className="field">
            <span className="field-label">Title</span>
            <input
              type="text"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </label>

          <label className="field">
            <span className="field-label">Description</span>
            <textarea
              rows={3}
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </label>

          <div className="variants-head">
            <span className="field-label">Variants — price (₹) and stock per variant</span>
            {statedTotal !== null && missingStockCount > 0 ? (
              <p className="split-hint">
                The caption states a total of <strong>{statedTotal}</strong>
                {draft.variants.length > 1
                  ? ' across variants but no per-variant split — splitting it is your call, never a guess of ours.'
                  : ' — confirm or correct it below.'}
              </p>
            ) : null}
            {statedTotal === null && missingStockCount > 0 ? (
              <p className="split-hint">
                The caption never states a stock count. State one per variant — 0 means sold
                out; publishing without a stated count is refused.
              </p>
            ) : null}
          </div>

          {draft.variants.map((variant, index) => (
            <div className="variant-row" key={variant.key}>
              <input
                type="text"
                className="variant-label"
                placeholder={draft.variants.length === 1 ? 'default variant' : `label ${index + 1}`}
                value={variant.label}
                onChange={(e) => updateVariant(variant.key, { label: e.target.value })}
              />
              <input
                type="text"
                inputMode="decimal"
                className="variant-price"
                placeholder="₹"
                value={variant.price}
                onChange={(e) => updateVariant(variant.key, { price: e.target.value })}
              />
              <input
                type="text"
                inputMode="numeric"
                className={`variant-stock${variant.stock.trim() === '' ? ' input-missing' : ''}`}
                placeholder="stock"
                value={variant.stock}
                onChange={(e) => updateVariant(variant.key, { stock: e.target.value })}
              />
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => removeVariant(variant.key)}
                aria-label={`Remove variant ${variant.label === '' ? index + 1 : variant.label}`}
              >
                remove
              </button>
            </div>
          ))}
          <button type="button" className="btn btn-quiet" onClick={addVariant}>
            + add variant
          </button>

          {problem === null ? null : (
            <p className="panel panel-error" role="alert">
              {problem}
            </p>
          )}

          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? 'Publishing…' : 'Confirm & publish'}
          </button>
          <p className="section-note">
            Publishing makes every Variant above buyable immediately. The server refuses
            anything unconfirmed: missing stock, a non-integer price, a blank title.
          </p>
        </form>
      </div>
    </div>
  );
}

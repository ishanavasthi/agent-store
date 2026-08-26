import { Link, NavLink, Route, Routes } from 'react-router-dom';
import { ConfirmationListPage } from './pages/ConfirmationListPage';
import { ConfirmProductPage } from './pages/ConfirmProductPage';
import { DirectoryPage } from './pages/DirectoryPage';
import { OrderPage } from './pages/OrderPage';
import { RefusalPage } from './pages/RefusalPage';

export function App() {
  return (
    <div className="shell">
      <header className="masthead">
        <Link to="/" className="masthead-title">
          Merchant desk
        </Link>
        <p className="masthead-sub">
          The audit ledger replays every Order and Refusal; the confirmation desk publishes what
          ingestion held for a human answer.
        </p>
        <nav className="masthead-nav" aria-label="Sections">
          <NavLink to="/" end>
            Audit ledger
          </NavLink>
          <NavLink to="/confirm">Confirmation desk</NavLink>
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<DirectoryPage />} />
          <Route path="/orders/:orderId" element={<OrderPage />} />
          <Route path="/refusals/:seq" element={<RefusalPage />} />
          <Route path="/confirm" element={<ConfirmationListPage />} />
          <Route path="/confirm/:productId" element={<ConfirmProductPage />} />
          <Route
            path="*"
            element={
              <p className="panel panel-error" role="alert">
                Nothing lives at this address. Start from the <Link to="/">ledger</Link> or the{' '}
                <Link to="/confirm">confirmation desk</Link>.
              </p>
            }
          />
        </Routes>
      </main>
      <footer className="colophon">
        Money is integer paise, INR only. Rows are ordered by the audit log's own seq — never by
        timestamp.
      </footer>
    </div>
  );
}

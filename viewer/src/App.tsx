import { Link, Route, Routes } from 'react-router-dom';
import { DirectoryPage } from './pages/DirectoryPage';
import { OrderPage } from './pages/OrderPage';
import { RefusalPage } from './pages/RefusalPage';

export function App() {
  return (
    <div className="shell">
      <header className="masthead">
        <Link to="/" className="masthead-title">
          Audit ledger
        </Link>
        <p className="masthead-sub">
          Every Order and every Refusal, replayed from the append-only audit log.
        </p>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<DirectoryPage />} />
          <Route path="/orders/:orderId" element={<OrderPage />} />
          <Route path="/refusals/:seq" element={<RefusalPage />} />
          <Route
            path="*"
            element={
              <p className="panel panel-error" role="alert">
                Nothing lives at this address. Start from the <Link to="/">ledger</Link>.
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

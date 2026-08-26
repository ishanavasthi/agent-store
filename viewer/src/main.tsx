import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './styles.css';

const root = document.getElementById('root');
if (root === null) throw new Error('viewer: #root missing from index.html');

// basename matches both the Vite base and the Express mount (T7 URL scheme).
createRoot(root).render(
  <StrictMode>
    <BrowserRouter basename="/viewer">
      <App />
    </BrowserRouter>
  </StrictMode>,
);

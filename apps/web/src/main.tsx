import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CardPage } from './CardPage.tsx';
import { tokenFromPath } from './cardView.ts';
import { DemoPage } from './DemoPage.tsx';
import { SetupPage } from './SetupPage.tsx';
import './styles.css';

const path = window.location.pathname;
const token = tokenFromPath(path);
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      {token ? (
        <CardPage token={token} />
      ) : path.startsWith('/a/') ? (
        <main>
          <p>This card is too old. Ask Penny again for a fresh one.</p>
        </main>
      ) : path.startsWith('/demo') ? (
        <DemoPage />
      ) : (
        <SetupPage />
      )}
    </StrictMode>,
  );
}

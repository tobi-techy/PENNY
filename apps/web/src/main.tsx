import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApprovalPage } from './ApprovalPage.tsx';
import { SetupPage } from './SetupPage.tsx';
import './styles.css';

const path = window.location.pathname;
const approval = /^\/a\/(apr_[A-Za-z0-9]+)/.exec(path);
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>{approval?.[1] ? <ApprovalPage id={approval[1]} /> : <SetupPage />}</StrictMode>,
  );
}

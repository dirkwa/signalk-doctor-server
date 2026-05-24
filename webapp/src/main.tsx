import 'bootstrap/dist/css/bootstrap.min.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadSession } from './api';
import { applyColorScheme } from './theme';

applyColorScheme();
// Token fetched once at boot — only mutating endpoints check it, but we
// need it ready before the user clicks Recover.
void loadSession();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('signalk-doctor: #root element missing in index.html');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

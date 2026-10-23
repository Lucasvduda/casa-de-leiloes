import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './app/App';
import { ErrorBoundary } from './app/ErrorBoundary';
import { createQueryClient } from './app/query-client';
import { ToastProvider } from './components/toast';
import { SessionProvider } from './features/auth/session';
import './index.css';

const queryClient = createQueryClient();
const container = document.getElementById('root');
if (container === null) throw new Error('Elemento #root não encontrado.');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <SessionProvider>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </SessionProvider>
        </ToastProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);

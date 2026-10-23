import { Route, Routes } from 'react-router-dom';
import { Button, Spinner } from '../components/ui';
import { AuditPage } from '../features/audit/AuditPage';
import { ReceiptPage } from '../features/audit/ReceiptPage';
import { LoginPage } from '../features/auth/LoginPage';
import { RegisterPage } from '../features/auth/RegisterPage';
import { useSession } from '../features/auth/session';
import { MyBidsPage } from '../features/bidder/MyBidsPage';
import { HomePage } from '../features/lots/HomePage';
import { LotRoomPage } from '../features/lots/LotRoomPage';
import { DashboardPage } from '../features/seller/DashboardPage';
import { NewLotPage } from '../features/seller/NewLotPage';
import { WalletPage } from '../features/wallet/WalletPage';
import { RedirectIfAuthenticated, RequireAuth } from './guards';
import { Layout } from './Layout';
import { NotFoundPage } from './NotFoundPage';

/**
 * Antes de saber SE a pessoa esta logada nao se desenha nenhuma rota (evita piscar "Entrar" para quem
 * ja tem sessao). Servidor fora do ar: tela propria com "tentar de novo", nunca "deslogado" falso.
 */
function SessionGate({ children }: { children: React.ReactNode }) {
  const { status, retry } = useSession();
  if (status === 'loading') {
    return (
      <div
        className="flex min-h-screen items-center justify-center"
        role="status"
        aria-label="Carregando"
      >
        <Spinner className="size-10" />
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div role="alert" className="mx-auto mt-24 max-w-md px-4 text-center">
        <h1 className="font-serif text-2xl font-bold">Não foi possível conectar</h1>
        <p className="mt-2 text-sm text-stone-600 dark:text-stone-400">
          O servidor não respondeu. Verifique sua internet e tente de novo.
        </p>
        <Button className="mt-4" onClick={retry}>
          Tentar de novo
        </Button>
      </div>
    );
  }
  return <>{children}</>;
}

export function App() {
  return (
    <SessionGate>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<HomePage />} />
          <Route path="lotes/:id" element={<LotRoomPage />} />
          <Route path="auditoria/:id" element={<AuditPage />} />
          <Route path="comprovantes/:code" element={<ReceiptPage />} />

          <Route
            path="entrar"
            element={
              <RedirectIfAuthenticated to={(role) => (role === 'seller' ? '/painel' : '/')}>
                <LoginPage />
              </RedirectIfAuthenticated>
            }
          />
          <Route
            path="cadastro"
            element={
              <RedirectIfAuthenticated to={(role) => (role === 'seller' ? '/painel' : '/')}>
                <RegisterPage />
              </RedirectIfAuthenticated>
            }
          />

          <Route
            path="carteira"
            element={
              <RequireAuth>
                <WalletPage />
              </RequireAuth>
            }
          />
          <Route
            path="meus-lances"
            element={
              <RequireAuth role="bidder">
                <MyBidsPage />
              </RequireAuth>
            }
          />
          <Route
            path="painel"
            element={
              <RequireAuth role="seller">
                <DashboardPage />
              </RequireAuth>
            }
          />
          <Route
            path="painel/novo"
            element={
              <RequireAuth role="seller">
                <NewLotPage />
              </RequireAuth>
            }
          />

          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </SessionGate>
  );
}

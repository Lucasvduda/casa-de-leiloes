import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import type { Role } from '../api/types';
import { ButtonLink, EmptyState, Spinner } from '../components/ui';
import { useSession } from '../features/auth/session';

/** Telas que exigem login (e, opcionalmente, um tipo de conta). */
export function RequireAuth({ role, children }: { role?: Role; children: ReactNode }) {
  const { status, user } = useSession();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <div className="flex justify-center py-20" role="status" aria-label="Carregando">
        <Spinner className="size-8" />
      </div>
    );
  }

  if (status !== 'authenticated' || user === null) {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/entrar?next=${encodeURIComponent(next)}`} replace />;
  }

  if (role !== undefined && user.role !== role) {
    return (
      <EmptyState
        title="Esta área é de outro tipo de conta"
        action={<ButtonLink to="/">Voltar à vitrine</ButtonLink>}
      >
        {role === 'seller'
          ? 'Somente leiloeiros acessam esta página.'
          : 'Somente licitantes acessam esta página.'}
      </EmptyState>
    );
  }

  return <>{children}</>;
}

/** Login e cadastro: quem ja esta logado vai direto para o seu lugar. */
export function RedirectIfAuthenticated({
  to,
  children,
}: {
  to: (role: Role) => string;
  children: ReactNode;
}) {
  const { status, user } = useSession();
  if (status === 'authenticated' && user !== null) return <Navigate to={to(user.role)} replace />;
  return <>{children}</>;
}

import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { User } from '../api/types';
import { BIDDER, SELLER } from '../test/fixtures';
import { RedirectIfAuthenticated, RequireAuth } from './guards';

const sessionState: { status: string; user: User | null } = { status: 'anonymous', user: null };
vi.mock('../features/auth/session', () => ({
  useSession: () => sessionState,
}));

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

function renderAt(path: string, element: React.ReactNode) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/privado" element={element} />
        <Route path="/entrar" element={<Where />} />
        <Route path="/entrar-livre" element={element} />
        <Route path="/painel" element={<Where />} />
        <Route path="/" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

function setSession(status: string, user: User | null) {
  sessionState.status = status;
  sessionState.user = user;
}

describe('RequireAuth', () => {
  it('visitante vai para /entrar guardando o destino em ?next=', () => {
    setSession('anonymous', null);
    renderAt('/privado?x=1', <RequireAuth>segredo</RequireAuth>);
    expect(screen.getByTestId('where')).toHaveTextContent('/entrar?next=%2Fprivado%3Fx%3D1');
    expect(screen.queryByText('segredo')).not.toBeInTheDocument();
  });

  it('enquanto verifica a sessao mostra espera (nao redireciona nem mostra o conteudo)', () => {
    setSession('loading', null);
    renderAt('/privado', <RequireAuth>segredo</RequireAuth>);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByText('segredo')).not.toBeInTheDocument();
    expect(screen.queryByTestId('where')).not.toBeInTheDocument();
  });

  it('logado com o papel certo ve o conteudo', () => {
    setSession('authenticated', SELLER);
    renderAt('/privado', <RequireAuth role="seller">segredo</RequireAuth>);
    expect(screen.getByText('segredo')).toBeInTheDocument();
  });

  it('papel errado ve explicacao e NAO o conteudo', () => {
    setSession('authenticated', BIDDER);
    renderAt('/privado', <RequireAuth role="seller">segredo</RequireAuth>);
    expect(screen.getByText('Esta área é de outro tipo de conta')).toBeInTheDocument();
    expect(screen.getByText('Somente leiloeiros acessam esta página.')).toBeInTheDocument();
    expect(screen.queryByText('segredo')).not.toBeInTheDocument();
  });

  it('sem exigir papel, qualquer logado entra', () => {
    setSession('authenticated', BIDDER);
    renderAt('/privado', <RequireAuth>segredo</RequireAuth>);
    expect(screen.getByText('segredo')).toBeInTheDocument();
  });
});

describe('RedirectIfAuthenticated', () => {
  const to = (role: string) => (role === 'seller' ? '/painel' : '/');

  it('visitante ve a tela de login', () => {
    setSession('anonymous', null);
    renderAt(
      '/entrar-livre',
      <RedirectIfAuthenticated to={to}>formulario</RedirectIfAuthenticated>,
    );
    expect(screen.getByText('formulario')).toBeInTheDocument();
  });

  it('leiloeiro logado vai ao painel', () => {
    setSession('authenticated', SELLER);
    renderAt(
      '/entrar-livre',
      <RedirectIfAuthenticated to={to}>formulario</RedirectIfAuthenticated>,
    );
    expect(screen.getByTestId('where')).toHaveTextContent('/painel');
  });

  it('licitante logado vai a vitrine', () => {
    setSession('authenticated', BIDDER);
    renderAt(
      '/entrar-livre',
      <RedirectIfAuthenticated to={to}>formulario</RedirectIfAuthenticated>,
    );
    expect(screen.getByTestId('where')).toHaveTextContent('/');
  });
});

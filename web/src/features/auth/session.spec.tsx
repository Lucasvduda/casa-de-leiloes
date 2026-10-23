import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/endpoints';
import { csrf, http } from '../../api/http';
import { ToastProvider } from '../../components/toast';
import { BIDDER } from '../../test/fixtures';
import { SessionProvider, homeFor, safeNextPath, useSession } from './session';

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const unauthenticated = () =>
  reply(401, { error: { code: 'UNAUTHENTICATED', message: 'Faça login.', requestId: 'r1' } });

function Probe() {
  const { status, user, login, logout, retry } = useSession();
  return (
    <div>
      <p data-testid="status">{status}</p>
      <p data-testid="user">{user?.displayName ?? 'ninguem'}</p>
      <button type="button" onClick={() => void login({ email: 'a@a.com', password: 'x' })}>
        entrar
      </button>
      <button type="button" onClick={() => void logout()}>
        sair
      </button>
      <button type="button" onClick={retry}>
        tentar
      </button>
    </div>
  );
}

function setup() {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <SessionProvider>
          <Probe />
        </SessionProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { queryClient };
}

describe('SessionProvider', () => {
  beforeEach(() => csrf.set(null));
  afterEach(() => vi.unstubAllGlobals());

  it('visitante: /auth/me 401 vira "anonymous" SEM aviso de sessao expirada', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => unauthenticated()),
    );
    setup();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
    expect(screen.queryByText(/sessão expirou/i)).not.toBeInTheDocument();
  });

  it('com cookie valido: autentica e guarda o token CSRF so em memoria', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply(200, { user: BIDDER, csrfToken: 'tok-1' })),
    );
    setup();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(screen.getByTestId('user')).toHaveTextContent('Ana Licitante');
    expect(csrf.get()).toBe('tok-1');
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('servidor fora do ar NAO finge deslogado: mostra erro e permite tentar de novo', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(reply(200, { user: BIDDER, csrfToken: 'tok-2' }));
    vi.stubGlobal('fetch', fetchMock);
    setup();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
    await userEvent.click(screen.getByRole('button', { name: 'tentar' }));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
  });

  it('sessao que expira depois de logado: volta a anonimo, limpa o cache e avisa', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/auth/me')
          ? reply(200, { user: BIDDER, csrfToken: 'tok-3' })
          : unauthenticated(),
      ),
    );
    const { queryClient } = setup();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    queryClient.setQueryData(['balance', BIDDER.id], { total: 1 });

    await act(async () => {
      await api.wallet().catch(() => undefined);
    });

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
    expect(screen.getByText(/sessão expirou/i)).toBeInTheDocument();
    expect(csrf.get()).toBeNull();
    expect(queryClient.getQueryData(['balance', BIDDER.id])).toBeUndefined();
  });

  it('login troca a identidade e descarta o cache de quem estava antes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/auth/me')
          ? unauthenticated()
          : reply(200, { user: BIDDER, csrfToken: 'tok-4' }),
      ),
    );
    const { queryClient } = setup();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
    queryClient.setQueryData(['lots', 'anon'], { items: [] });

    await userEvent.click(screen.getByRole('button', { name: 'entrar' }));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(queryClient.getQueryData(['lots', 'anon'])).toBeUndefined();
    expect(csrf.get()).toBe('tok-4');
  });

  it('sair limpa usuario e token mesmo se a rede falhar', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/auth/me')) return reply(200, { user: BIDDER, csrfToken: 'tok-5' });
        throw new TypeError('offline');
      }),
    );
    setup();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    await userEvent.click(screen.getByRole('button', { name: 'sair' }));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
    expect(csrf.get()).toBeNull();
    // `http` continua utilizavel (nada ficou preso no cliente).
    expect(typeof http.get).toBe('function');
  });
});

describe('safeNextPath (anti open-redirect)', () => {
  it.each([
    ['/lotes/abc', '/lotes/abc'],
    ['/carteira?x=1', '/carteira?x=1'],
    ['//evil.com', '/'],
    ['/\\evil.com', '/'],
    ['https://evil.com', '/'],
    ['javascript:alert(1)', '/'],
    ['', '/'],
    ['/ok\nSet-Cookie: x=1', '/'],
  ])('%j -> %j', (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });

  it('null e undefined viram a raiz', () => {
    expect(safeNextPath(null)).toBe('/');
    expect(safeNextPath(undefined)).toBe('/');
  });
});

describe('homeFor', () => {
  it('leiloeiro vai ao painel e licitante a vitrine', () => {
    expect(homeFor({ ...BIDDER, role: 'seller' })).toBe('/painel');
    expect(homeFor(BIDDER)).toBe('/');
  });
});

import { Link, NavLink, Outlet } from 'react-router-dom';
import { Button, cn } from '../components/ui';
import { useSession } from '../features/auth/session';
import { useBalance } from '../features/wallet/use-balance';
import { formatBRL } from '../lib/money';
import { useTheme } from '../lib/theme';

const navClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'rounded-lg px-3 py-2 text-sm font-medium transition-colors',
    isActive
      ? 'bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900'
      : 'text-stone-700 hover:bg-stone-200/70 dark:text-stone-300 dark:hover:bg-stone-800/70',
  );

function BalanceChip() {
  const { data } = useBalance();
  if (data === undefined) return null;
  return (
    <Link
      to="/carteira"
      className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm font-semibold text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
      aria-label={`Saldo disponível ${formatBRL(data.available)}. Abrir carteira`}
    >
      <span className="hidden sm:inline">Disponível </span>
      <span className="tabular">{formatBRL(data.available)}</span>
    </Link>
  );
}

function ThemeToggle() {
  const { dark, toggle } = useTheme();
  return (
    <Button
      variant="ghost"
      className="min-w-11 px-2"
      onClick={toggle}
      aria-label={dark ? 'Usar tema claro' : 'Usar tema escuro'}
      aria-pressed={dark}
    >
      <span aria-hidden="true">{dark ? '☀️' : '🌙'}</span>
    </Button>
  );
}

export function Layout() {
  const { status, user, logout } = useSession();

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#conteudo"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-amber-500 focus:px-4 focus:py-2 focus:font-semibold focus:text-stone-950"
      >
        Pular para o conteúdo
      </a>

      <header className="border-b border-stone-200 bg-white/90 backdrop-blur dark:border-stone-800 dark:bg-stone-900/90">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <Link to="/" className="flex items-center gap-2 font-serif text-xl font-bold">
            <img src="/favicon.svg" alt="" width="28" height="28" className="rounded-md" />
            Casa de Leilões
          </Link>

          <nav aria-label="Principal" className="flex flex-wrap items-center gap-1">
            <NavLink to="/" end className={navClass}>
              Vitrine
            </NavLink>
            {user?.role === 'bidder' && (
              <>
                <NavLink to="/meus-lances" className={navClass}>
                  Meus lances
                </NavLink>
                <NavLink to="/carteira" className={navClass}>
                  Carteira
                </NavLink>
              </>
            )}
            {user?.role === 'seller' && (
              <>
                <NavLink to="/painel" end className={navClass}>
                  Painel
                </NavLink>
                <NavLink to="/carteira" className={navClass}>
                  Carteira
                </NavLink>
              </>
            )}
          </nav>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            {status === 'authenticated' && user !== null && <BalanceChip />}
            <ThemeToggle />
            {status === 'authenticated' && user !== null ? (
              <div className="flex items-center gap-2">
                <span className="hidden text-sm sm:inline">
                  <span className="font-medium">{user.displayName}</span>
                  <span className="ml-1 text-stone-500 dark:text-stone-400">
                    ({user.role === 'seller' ? 'leiloeiro' : 'licitante'})
                  </span>
                </span>
                <Button variant="secondary" onClick={() => void logout()}>
                  Sair
                </Button>
              </div>
            ) : (
              status !== 'loading' && (
                <div className="flex items-center gap-2">
                  <Link
                    to="/entrar"
                    className="rounded-lg px-3 py-2 text-sm font-medium hover:bg-stone-200/70 dark:hover:bg-stone-800/70"
                  >
                    Entrar
                  </Link>
                  <Link
                    to="/cadastro"
                    className="rounded-lg bg-amber-500 px-3 py-2 text-sm font-semibold text-stone-950 hover:bg-amber-400"
                  >
                    Criar conta
                  </Link>
                </div>
              )
            )}
          </div>
        </div>
      </header>

      <main
        id="conteudo"
        tabIndex={-1}
        className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 outline-none"
      >
        <Outlet />
      </main>

      <footer className="border-t border-stone-200 py-6 text-center text-xs text-stone-500 dark:border-stone-800 dark:text-stone-400">
        <p>
          Projeto de demonstração: o dinheiro é fictício e nenhum pagamento real acontece. Imagens e
          dados do acervo aberto (CC0) do{' '}
          <a
            className="underline"
            href="https://openaccess.clevelandart.org/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Cleveland Museum of Art
          </a>
          .
        </p>
      </footer>
    </div>
  );
}

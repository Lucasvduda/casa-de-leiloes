import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { api } from '../../api/endpoints';
import { isApiError } from '../../api/errors';
import { csrf, setSessionExpiredHandler } from '../../api/http';
import type { Role, SessionPayload, User } from '../../api/types';
import { useToast } from '../../components/toast';

export type SessionStatus = 'loading' | 'anonymous' | 'authenticated' | 'error';

export interface SessionValue {
  status: SessionStatus;
  user: User | null;
  /** Muda ao entrar/sair: faz parte das chaves de cache de tudo que depende de quem esta vendo. */
  viewerKey: string;
  login(input: { email: string; password: string }): Promise<User>;
  register(input: {
    email: string;
    displayName: string;
    password: string;
    role: Role;
  }): Promise<User>;
  logout(): Promise<void>;
  /** Tenta de novo a verificacao inicial (quando o servidor nao respondeu ao abrir o app). */
  retry(): void;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [attempt, setAttempt] = useState(0);

  const adopt = useCallback(
    (payload: SessionPayload) => {
      csrf.set(payload.csrfToken);
      // Qualquer troca de identidade descarta as respostas guardadas (carregam dados de quem estava logado).
      queryClient.clear();
      setUser(payload.user);
      setStatus('authenticated');
      return payload.user;
    },
    [queryClient],
  );

  const drop = useCallback(() => {
    csrf.set(null);
    queryClient.clear();
    setUser(null);
    setStatus('anonymous');
  }, [queryClient]);

  // Verificacao inicial: o cookie (httpOnly) diz quem e a pessoa; o JS so recebe o resultado.
  useEffect(() => {
    const controller = new AbortController();
    api
      .me(controller.signal)
      .then((payload) => {
        csrf.set(payload.csrfToken);
        setUser(payload.user);
        setStatus('authenticated');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (isApiError(error) && error.status === 401) {
          csrf.set(null);
          setUser(null);
          setStatus('anonymous');
          return;
        }
        // Servidor fora do ar: NAO fingir que a pessoa esta deslogada.
        setStatus('error');
      });
    return () => controller.abort();
  }, [attempt]);

  // O servidor respondeu 401 a uma acao autenticada: a sessao expirou (7 dias) ou foi encerrada.
  // Quem nunca entrou (visitante, ou a checagem inicial /auth/me) recebe 401 normalmente: nao e
  // "sessao expirada", entao nao ha aviso nem limpeza.
  const authenticatedRef = useRef(false);
  useEffect(() => {
    authenticatedRef.current = status === 'authenticated';
  }, [status]);
  useEffect(() => {
    setSessionExpiredHandler(() => {
      if (!authenticatedRef.current) return;
      drop();
      toast.push('warning', 'Sua sessão expirou. Entre novamente para continuar.');
    });
    return () => setSessionExpiredHandler(null);
  }, [drop, toast]);

  const login = useCallback<SessionValue['login']>(
    async (input) => adopt(await api.login(input)),
    [adopt],
  );
  const register = useCallback<SessionValue['register']>(
    async (input) => adopt(await api.register(input)),
    [adopt],
  );
  const logout = useCallback<SessionValue['logout']>(async () => {
    try {
      await api.logout();
    } catch {
      // Sair e idempotente no servidor; se a rede falhou, a tela sai do mesmo jeito e o cookie
      // expira sozinho. Mostrar erro aqui so prenderia a pessoa numa conta que ela quer deixar.
    } finally {
      drop();
    }
  }, [drop]);
  const retry = useCallback(() => {
    setStatus('loading');
    setAttempt((n) => n + 1);
  }, []);

  const value = useMemo<SessionValue>(
    () => ({ status, user, viewerKey: user?.id ?? 'anon', login, register, logout, retry }),
    [status, user, login, register, logout, retry],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const context = useContext(SessionContext);
  if (context === null) throw new Error('useSession fora do SessionProvider');
  return context;
}

/** So caminho interno do app: bloqueia "//outro-site.com" e "https://..." (open redirect). */
export function safeNextPath(next: string | null | undefined): string {
  if (next === null || next === undefined) return '/';
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  for (let i = 0; i < next.length; i += 1) {
    if (next.charCodeAt(i) < 0x20) return '/';
  }
  return next;
}

/** Para onde mandar a pessoa logo depois de entrar. */
export function homeFor(user: User): string {
  return user.role === 'seller' ? '/painel' : '/';
}

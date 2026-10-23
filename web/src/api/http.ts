import { createApiClient } from './client';

/**
 * Token CSRF da sessao em MEMORIA. Recarregar a pagina o recupera com GET /auth/me (o cookie de
 * sessao e httpOnly e o proprio JavaScript nunca o le).
 */
let csrfToken: string | null = null;
let onSessionExpired: (() => void) | null = null;

export const csrf = {
  get: (): string | null => csrfToken,
  set: (token: string | null): void => {
    csrfToken = token;
  },
};

/** A tela de sessao registra aqui o que fazer quando o servidor diz "nao autenticado". */
export function setSessionExpiredHandler(handler: (() => void) | null): void {
  onSessionExpired = handler;
}

export const http = createApiClient({
  getCsrfToken: () => csrfToken,
  onUnauthenticated: () => onSessionExpired?.(),
});

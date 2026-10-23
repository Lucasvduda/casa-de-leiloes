import { QueryClient } from '@tanstack/react-query';
import { isApiError, isRetryable } from '../api/errors';

const MAX_RETRIES = 2;

/**
 * Regras de tentativa para LEITURAS: rede e 502/503/504 tentam de novo (ate 2 vezes); qualquer
 * outra resposta da API (404, 401, 403...) e definitiva. Escritas (lance, deposito) nunca passam
 * por aqui: a tela decide, com chave de idempotencia.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_RETRIES) return false;
  if (isApiError(error) && error.status === 429) return false;
  return isRetryable(error);
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        retry: shouldRetryQuery,
        retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 8_000),
        refetchOnWindowFocus: true,
      },
      mutations: { retry: false },
    },
  });
}

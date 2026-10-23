/** Erro devolvido pela API no contrato `{ error: { code, message, requestId, details? } }`. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  readonly requestId: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    details?: Record<string, unknown> | undefined;
    requestId?: string | undefined;
    retryAfterSeconds?: number | undefined;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.details = init.details;
    this.requestId = init.requestId;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

/** Nao houve resposta: sem internet, servidor fora do ar ou tempo esgotado. */
export class NetworkError extends Error {
  readonly kind: 'offline' | 'timeout';

  constructor(kind: 'offline' | 'timeout', options?: { cause?: unknown }) {
    super(kind === 'timeout' ? 'Tempo de resposta esgotado.' : 'Sem conexao com o servidor.');
    this.name = 'NetworkError';
    this.kind = kind;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

export const isApiError = (error: unknown): error is ApiError => error instanceof ApiError;
export const isNetworkError = (error: unknown): error is NetworkError =>
  error instanceof NetworkError;

/**
 * Vale tentar de novo SEM mudar nada? Falha de rede e 5xx transitorio, sim; qualquer 4xx
 * (credencial, validacao, regra de negocio) nao: repetir so repetiria a recusa.
 */
export function isRetryable(error: unknown): boolean {
  if (isNetworkError(error)) return true;
  if (isApiError(error))
    return error.status === 503 || error.status === 502 || error.status === 504;
  return false;
}

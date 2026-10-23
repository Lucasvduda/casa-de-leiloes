import { ApiError, NetworkError } from './errors';

export interface ApiClientOptions {
  baseUrl?: string;
  /** Lido a cada chamada (permite trocar em teste e evita "Illegal invocation" do fetch solto). */
  fetchImpl?: () => typeof fetch;
  /** Token CSRF da sessao atual (so existe em memoria; nunca em localStorage). */
  getCsrfToken: () => string | null;
  /** Chamado quando uma requisicao autenticada volta 401 UNAUTHENTICATED (sessao expirou). */
  onUnauthenticated?: () => void;
  timeoutMs?: number;
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  query?: Readonly<Record<string, string | number | null | undefined>>;
  body?: unknown;
  idempotencyKey?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface ApiClient {
  request<T>(path: string, options?: RequestOptions): Promise<T>;
  get<T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T>;
  post<T>(
    path: string,
    body?: unknown,
    options?: Omit<RequestOptions, 'method' | 'body'>,
  ): Promise<T>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function buildQuery(query: RequestOptions['query']): string {
  if (query === undefined) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Qualquer coisa que nao seja o contrato `{error:{...}}` (ex.: HTML de proxy 502) vira erro generico. */
function toApiError(status: number, body: unknown, retryAfterHeader: string | null): ApiError {
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  const details =
    error !== null && isRecord(error.details)
      ? (error.details as Record<string, unknown>)
      : undefined;
  const fromDetails =
    details !== undefined && typeof details.retryAfterSeconds === 'number'
      ? details.retryAfterSeconds
      : undefined;
  return new ApiError({
    status,
    code: error !== null && typeof error.code === 'string' ? error.code : `HTTP_${status}`,
    message:
      error !== null && typeof error.message === 'string' ? error.message : 'Erro inesperado.',
    details,
    requestId: error !== null && typeof error.requestId === 'string' ? error.requestId : undefined,
    retryAfterSeconds: parseRetryAfter(retryAfterHeader) ?? fromDetails,
  });
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const baseUrl = options.baseUrl ?? '/api';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const getFetch = options.fetchImpl ?? (() => globalThis.fetch.bind(globalThis));

  async function request<T>(path: string, req: RequestOptions = {}): Promise<T> {
    const method = req.method ?? 'GET';
    const headers: Record<string, string> = { Accept: 'application/json' };
    let body: string | undefined;

    if (method !== 'GET') {
      // O servidor exige JSON em toda escrita (parte da defesa contra CSRF), mesmo sem corpo.
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(req.body ?? {});
      const csrf = options.getCsrfToken();
      if (csrf !== null) headers['X-CSRF-Token'] = csrf;
      if (req.idempotencyKey !== undefined) headers['Idempotency-Key'] = req.idempotencyKey;
    }

    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = req.signal === undefined ? timeout : AbortSignal.any([req.signal, timeout]);

    let response: Response;
    try {
      response = await getFetch()(`${baseUrl}${path}${buildQuery(req.query)}`, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        credentials: 'same-origin',
        signal,
      });
    } catch (error) {
      // Cancelamento pedido por quem chamou (troca de tela): nao e falha, propaga como esta.
      if (req.signal?.aborted === true) throw error;
      if (timeout.aborted) throw new NetworkError('timeout', { cause: error });
      throw new NetworkError('offline', { cause: error });
    }

    const text = await response.text().catch(() => '');
    let parsed: unknown = undefined;
    if (text !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }

    if (!response.ok) {
      const error = toApiError(response.status, parsed, response.headers.get('Retry-After'));
      if (response.status === 401 && error.code === 'UNAUTHENTICATED') {
        options.onUnauthenticated?.();
      }
      throw error;
    }

    if (response.status === 204 || text === '') return undefined as T;
    if (parsed === undefined) {
      throw new ApiError({
        status: response.status,
        code: 'INVALID_RESPONSE',
        message: 'Resposta invalida do servidor.',
      });
    }
    return parsed as T;
  }

  return {
    request,
    get: (path, opts) => request(path, { ...opts, method: 'GET' }),
    post: (path, body, opts) => request(path, { ...opts, method: 'POST', body }),
  };
}

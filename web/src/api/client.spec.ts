import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from './client';
import { ApiError, NetworkError, isRetryable } from './errors';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

function setup(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
  opts: { csrf?: string | null; onUnauthenticated?: () => void; timeoutMs?: number } = {},
) {
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
    respond(String(url), init ?? {}),
  );
  const client = createApiClient({
    fetchImpl: () => fetchMock as unknown as typeof fetch,
    getCsrfToken: () => opts.csrf ?? null,
    ...(opts.onUnauthenticated !== undefined ? { onUnauthenticated: opts.onUnauthenticated } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  return { client, fetchMock };
}

const headersOf = (init: RequestInit) => init.headers as Record<string, string>;

describe('createApiClient: requisicao', () => {
  it('GET: sem corpo, sem CSRF, com credenciais da mesma origem e query limpa', async () => {
    const { client, fetchMock } = setup(() => json(200, { ok: true }), { csrf: 'tok' });
    await client.get('/lots', {
      query: { q: 'vaso', page: 2, sort: undefined, phase: null, x: '' },
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/lots?q=vaso&page=2');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.credentials).toBe('same-origin');
    expect(headersOf(init)['X-CSRF-Token']).toBeUndefined();
    expect(headersOf(init)['Content-Type']).toBeUndefined();
  });

  it('POST: JSON, token CSRF e chave de idempotencia', async () => {
    const { client, fetchMock } = setup(() => json(201, { ok: true }), { csrf: 'csrf-123' });
    await client.post('/lots/1/bids', { amount: 15000 }, { idempotencyKey: 'bid-abc12345' });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"amount":15000}');
    expect(headersOf(init)['Content-Type']).toBe('application/json');
    expect(headersOf(init)['X-CSRF-Token']).toBe('csrf-123');
    expect(headersOf(init)['Idempotency-Key']).toBe('bid-abc12345');
  });

  it('POST sem corpo ainda envia JSON ({}), porque o servidor exige o content-type', async () => {
    const { client, fetchMock } = setup(() => new Response(null, { status: 204 }));
    await client.post('/auth/logout');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe('{}');
    expect(headersOf(init)['Content-Type']).toBe('application/json');
  });

  it('sem sessao nao envia X-CSRF-Token', async () => {
    const { client, fetchMock } = setup(() => json(200, {}), { csrf: null });
    await client.post('/auth/login', { email: 'a@b.c', password: 'x' });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(headersOf(init)['X-CSRF-Token']).toBeUndefined();
  });

  it('nunca manda Idempotency-Key em GET', async () => {
    const { client, fetchMock } = setup(() => json(200, {}));
    await client.get('/lots', { idempotencyKey: 'abc12345' });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(headersOf(init)['Idempotency-Key']).toBeUndefined();
  });
});

describe('createApiClient: resposta', () => {
  it('204 devolve undefined', async () => {
    const { client } = setup(() => new Response(null, { status: 204 }));
    await expect(client.post('/auth/logout')).resolves.toBeUndefined();
  });

  it('200 devolve o JSON', async () => {
    const { client } = setup(() => json(200, { a: 1 }));
    await expect(client.get('/x')).resolves.toEqual({ a: 1 });
  });

  it('erro da API vira ApiError com codigo, detalhes e requestId', async () => {
    const { client } = setup(() =>
      json(409, {
        error: {
          code: 'BELOW_MINIMUM',
          message: 'abaixo',
          requestId: 'req-1',
          details: { minimumRequired: 5000 },
        },
      }),
    );
    const error = await client.post('/lots/1/bids', { amount: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(409);
    expect(apiError.code).toBe('BELOW_MINIMUM');
    expect(apiError.requestId).toBe('req-1');
    expect(apiError.details).toEqual({ minimumRequired: 5000 });
  });

  it('resposta de erro que NAO e o contrato (HTML do proxy) vira ApiError generico', async () => {
    const { client } = setup(
      () =>
        new Response('<html>Bad Gateway</html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        }),
    );
    const error = (await client.get('/x').catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(502);
    expect(error.code).toBe('HTTP_502');
    expect(error.message).toBe('Erro inesperado.');
  });

  it('200 com corpo que nao e JSON e erro, nao "sucesso vazio"', async () => {
    const { client } = setup(() => new Response('oi', { status: 200 }));
    const error = (await client.get('/x').catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('INVALID_RESPONSE');
  });

  it('le Retry-After do cabecalho e, na falta dele, de details.retryAfterSeconds', async () => {
    const withHeader = setup(() =>
      json(429, { error: { code: 'RATE_LIMITED', message: 'x' } }, { 'Retry-After': '12' }),
    );
    const a = (await withHeader.client.get('/x').catch((e: unknown) => e)) as ApiError;
    expect(a.retryAfterSeconds).toBe(12);

    const withDetails = setup(() =>
      json(429, {
        error: { code: 'RATE_LIMITED', message: 'x', details: { retryAfterSeconds: 60 } },
      }),
    );
    const b = (await withDetails.client.get('/x').catch((e: unknown) => e)) as ApiError;
    expect(b.retryAfterSeconds).toBe(60);
  });
});

describe('createApiClient: sessao expirada', () => {
  it('401 UNAUTHENTICATED avisa a aplicacao (uma vez por resposta)', async () => {
    const onUnauthenticated = vi.fn();
    const { client } = setup(
      () => json(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } }),
      { onUnauthenticated },
    );
    await client.get('/wallet').catch(() => undefined);
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
  });

  it('401 de CREDENCIAL ERRADA no login NAO e sessao expirada', async () => {
    const onUnauthenticated = vi.fn();
    const { client } = setup(
      () => json(401, { error: { code: 'INVALID_CREDENTIALS', message: 'x' } }),
      { onUnauthenticated },
    );
    await client.post('/auth/login', {}).catch(() => undefined);
    expect(onUnauthenticated).not.toHaveBeenCalled();
  });

  it('outros erros (403, 409) tambem nao derrubam a sessao', async () => {
    const onUnauthenticated = vi.fn();
    const { client } = setup(() => json(403, { error: { code: 'FORBIDDEN_ROLE', message: 'x' } }), {
      onUnauthenticated,
    });
    await client.get('/x').catch(() => undefined);
    expect(onUnauthenticated).not.toHaveBeenCalled();
  });
});

describe('createApiClient: falhas de rede', () => {
  it('fetch que lanca vira NetworkError offline', async () => {
    const { client } = setup(() => {
      throw new TypeError('Failed to fetch');
    });
    const error = await client.get('/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).kind).toBe('offline');
  });

  it('estouro do tempo limite vira NetworkError timeout', async () => {
    const { client } = setup(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('t', 'TimeoutError')),
          );
        }),
      { timeoutMs: 20 },
    );
    const error = await client.get('/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).kind).toBe('timeout');
  });

  it('cancelamento de quem chamou propaga como esta (nao vira "sem conexao")', async () => {
    const controller = new AbortController();
    const { client } = setup(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('a', 'AbortError')));
        }),
    );
    const pending = client.get('/x', { signal: controller.signal }).catch((e: unknown) => e);
    controller.abort();
    const error = await pending;
    expect(error).not.toBeInstanceOf(NetworkError);
    expect((error as DOMException).name).toBe('AbortError');
  });
});

describe('isRetryable', () => {
  it('rede e 502/503/504 sim; 4xx e 500 nao', () => {
    expect(isRetryable(new NetworkError('offline'))).toBe(true);
    expect(isRetryable(new NetworkError('timeout'))).toBe(true);
    for (const status of [502, 503, 504]) {
      expect(isRetryable(new ApiError({ status, code: 'X', message: 'x' }))).toBe(true);
    }
    for (const status of [400, 401, 403, 404, 409, 422, 429, 500]) {
      expect(isRetryable(new ApiError({ status, code: 'X', message: 'x' }))).toBe(false);
    }
    expect(isRetryable(new Error('x'))).toBe(false);
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  CircuitBreaker,
  UpstreamError,
  UpstreamNotFound,
  fetchJson,
  withRetry,
} from '../../src/adapters/outbound/catalog/resilient-fetch.js';
import { FakeUpstream, jsonResponse } from '../support/fake-upstream.js';

const URL_ = 'https://api.exemplo.test/x';
const opts = (up: FakeUpstream, over: Partial<{ timeoutMs: number; maxBytes: number }> = {}) => ({
  fetch: up.fetch,
  timeoutMs: over.timeoutMs ?? 200,
  maxBytes: over.maxBytes ?? 1_000,
  userAgent: 'teste/1.0',
});

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('deveria ter falhado');
}

/** Corpo em pedacos: permite provar que o limite corta ANTES de ler tudo. */
function chunkedBody(
  chunks: number,
  size: number,
  pulled: { count: number },
): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled.count += 1;
      if (sent >= chunks) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(new Uint8Array(size).fill(0x61));
    },
  });
}

describe('fetchJson', () => {
  it('devolve o JSON e faz GET sem redirecionamento, pedindo JSON', async () => {
    const up = new FakeUpstream(() => jsonResponse({ ok: 1 }));
    await expect(fetchJson(URL_, opts(up))).resolves.toEqual({ ok: 1 });
    const init = up.calls[0]!.init;
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toMatchObject({ accept: 'application/json', 'user-agent': 'teste/1.0' });
    expect(init.credentials).toBeUndefined();
  });

  it('404 -> UpstreamNotFound (resposta valida, nao e falha)', async () => {
    const up = new FakeUpstream(() => new Response('nao existe', { status: 404 }));
    await expect(fetchJson(URL_, opts(up))).rejects.toBeInstanceOf(UpstreamNotFound);
  });

  it.each([
    [500, true],
    [502, true],
    [503, true],
    [429, true],
    [400, false],
    [401, false],
    [403, false],
    [410, false],
  ])('HTTP %i -> UpstreamError http (repetivel: %s)', async (status, retryable) => {
    const up = new FakeUpstream(() => new Response('x', { status }));
    const error = (await failure(fetchJson(URL_, opts(up)))) as UpstreamError;
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error).toMatchObject({ kind: 'http', status, retryable });
  });

  it('rede caiu (fetch rejeita) -> network, repetivel', async () => {
    const up = new FakeUpstream(() => Promise.reject(new TypeError('fetch failed')));
    const error = (await failure(fetchJson(URL_, opts(up)))) as UpstreamError;
    expect(error).toMatchObject({ kind: 'network', retryable: true });
    expect(error.message).not.toContain('fetch failed'); // so o tipo do erro, nunca detalhe do ambiente
  });

  it('redirecionamento (fetch com redirect:error rejeita) -> network', async () => {
    const up = new FakeUpstream(() =>
      Promise.reject(new TypeError('redirect mode is set to error')),
    );
    expect(await failure(fetchJson(URL_, opts(up)))).toMatchObject({ kind: 'network' });
  });

  it('servidor pendurado: o timeout dispara mesmo que o fetch ignore o sinal de abortar', async () => {
    const up = new FakeUpstream(() => new Promise<Response>(() => undefined));
    const started = Date.now();
    const error = await failure(fetchJson(URL_, opts(up, { timeoutMs: 40 })));
    expect(error).toMatchObject({ kind: 'timeout', retryable: true });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('corpo que trava no meio da leitura tambem estoura o timeout', async () => {
    const stalled = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) });
    const up = new FakeUpstream(
      () => new Response(stalled, { headers: { 'content-type': 'application/json' } }),
    );
    expect(await failure(fetchJson(URL_, opts(up, { timeoutMs: 40 })))).toMatchObject({
      kind: 'timeout',
    });
  });

  it('o sinal e abortado quando o timeout vence (libera a conexao)', async () => {
    const up = new FakeUpstream(() => new Promise<Response>(() => undefined));
    await failure(fetchJson(URL_, opts(up, { timeoutMs: 30 })));
    expect((up.calls[0]!.init.signal as AbortSignal).aborted).toBe(true);
  });

  it.each([
    ['text/html', '<html>Attention Required! | Cloudflare</html>'],
    ['text/plain', '{"a":1}'],
    ['', '{"a":1}'],
  ])('content-type %j nao e JSON -> payload', async (type, body) => {
    const up = new FakeUpstream(
      () =>
        new Response(body, { status: 200, headers: type === '' ? {} : { 'content-type': type } }),
    );
    const error = (await failure(fetchJson(URL_, opts(up)))) as UpstreamError;
    // Sem cabecalho, o runtime assume text/plain: tambem recusado.
    expect(error).toMatchObject({ kind: 'payload', retryable: false });
  });

  it.each(['{"a":', 'nao e json', '', '<<<'])(
    'JSON invalido (%j) -> payload, nao repetivel',
    async (body) => {
      const up = new FakeUpstream(() => jsonResponse(body));
      expect(await failure(fetchJson(URL_, opts(up)))).toMatchObject({
        kind: 'payload',
        retryable: false,
      });
    },
  );

  it('Content-Length acima do teto: recusa SEM ler o corpo', async () => {
    const pulled = { count: 0 };
    const up = new FakeUpstream(
      () =>
        new Response(chunkedBody(5, 100, pulled), {
          headers: { 'content-type': 'application/json', 'content-length': '999999999' },
        }),
    );
    expect(await failure(fetchJson(URL_, opts(up)))).toMatchObject({
      kind: 'too_large',
      retryable: false,
    });
    expect(pulled.count).toBeLessThanOrEqual(1);
  });

  it('sem Content-Length (ou mentindo): corta a leitura ao passar do teto, sem baixar tudo', async () => {
    const pulled = { count: 0 };
    // 1000 pedacos de 100 bytes = 100 KB; teto de 1 KB.
    const up = new FakeUpstream(
      () =>
        new Response(chunkedBody(1_000, 100, pulled), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    expect(await failure(fetchJson(URL_, opts(up, { maxBytes: 1_000 })))).toMatchObject({
      kind: 'too_large',
    });
    expect(pulled.count).toBeLessThan(50);
  });

  it('exatamente no teto passa', async () => {
    const body = JSON.stringify({ k: 'x'.repeat(100) });
    const up = new FakeUpstream(() => jsonResponse(body));
    await expect(fetchJson(URL_, opts(up, { maxBytes: body.length }))).resolves.toEqual({
      k: 'x'.repeat(100),
    });
  });

  it('um byte acima do teto falha', async () => {
    const body = JSON.stringify({ k: 'x'.repeat(100) });
    const up = new FakeUpstream(() => jsonResponse(body));
    expect(await failure(fetchJson(URL_, opts(up, { maxBytes: body.length - 1 })))).toMatchObject({
      kind: 'too_large',
    });
  });

  it('decodifica UTF-8 corretamente (acentos, travessao, emoji)', async () => {
    const up = new FakeUpstream(() => jsonResponse({ t: 'Coração – 🎨' }));
    await expect(fetchJson(URL_, opts(up))).resolves.toEqual({ t: 'Coração – 🎨' });
  });

  it('nao deixa rejeicao pendurada quando o timeout vence (sem unhandledRejection)', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => seen.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const up = new FakeUpstream(
        (_u, _i, init) =>
          new Promise<Response>((_res, rej) => {
            init.signal?.addEventListener('abort', () =>
              rej(new DOMException('aborted', 'AbortError')),
            );
          }),
      );
      await failure(fetchJson(URL_, opts(up, { timeoutMs: 20 })));
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(seen).toEqual([]);
  });
});

describe('withRetry', () => {
  const retryOpts = () => ({
    retries: 2,
    baseDelayMs: 100,
    sleep: vi.fn(async (_ms: number) => undefined),
    random: () => 0.5,
  });
  const transient = () => new UpstreamError('x', 'http', 503);

  it('repete falha passageira com backoff exponencial e jitter, e devolve o sucesso', async () => {
    const o = retryOpts();
    let n = 0;
    const result = await withRetry(async () => {
      n += 1;
      if (n < 3) throw transient();
      return 'ok';
    }, o);
    expect(result).toBe('ok');
    expect(n).toBe(3);
    // 100 * 2^0 * 0.75 e 100 * 2^1 * 0.75
    expect(o.sleep.mock.calls.map((c) => c[0])).toEqual([75, 150]);
  });

  it('desiste depois de `retries` tentativas extras e propaga o ultimo erro', async () => {
    const o = retryOpts();
    let n = 0;
    const error = await failure(
      withRetry(async () => {
        n += 1;
        throw transient();
      }, o),
    );
    expect(n).toBe(3);
    expect(error).toBeInstanceOf(UpstreamError);
  });

  it.each([
    new UpstreamError('x', 'http', 403),
    new UpstreamError('x', 'payload'),
    new UpstreamError('x', 'too_large'),
    new UpstreamError('x', 'circuit_open'),
    new UpstreamNotFound(),
    new Error('bug'),
  ])('nao repete erro definitivo (%s)', async (error) => {
    const o = retryOpts();
    let n = 0;
    await failure(
      withRetry(async () => {
        n += 1;
        throw error;
      }, o),
    );
    expect(n).toBe(1);
    expect(o.sleep).not.toHaveBeenCalled();
  });

  it('retries 0 = uma unica tentativa', async () => {
    let n = 0;
    await failure(
      withRetry(
        async () => {
          n += 1;
          throw transient();
        },
        { ...retryOpts(), retries: 0 },
      ),
    );
    expect(n).toBe(1);
  });
});

describe('CircuitBreaker', () => {
  const make = () => {
    const clock = { t: 0 };
    const breaker = new CircuitBreaker({ failureThreshold: 3, openMs: 1_000, now: () => clock.t });
    return { clock, breaker };
  };

  it('abre so apos N falhas CONSECUTIVAS', () => {
    const { breaker } = make();
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.state).toBe('closed');
    breaker.onFailure();
    expect(breaker.state).toBe('open');
    expect(breaker.tryAcquire()).toBe(false);
  });

  it('um sucesso no meio zera a contagem', () => {
    const { breaker } = make();
    breaker.onFailure();
    breaker.onFailure();
    breaker.onSuccess();
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.state).toBe('closed');
  });

  it('depois de openMs vira meio-aberto e deixa passar UMA sonda por vez', () => {
    const { breaker, clock } = make();
    for (let i = 0; i < 3; i++) breaker.onFailure();
    clock.t = 999;
    expect(breaker.state).toBe('open');
    clock.t = 1_000;
    expect(breaker.state).toBe('half_open');
    expect(breaker.tryAcquire()).toBe(true); // a sonda
    expect(breaker.tryAcquire()).toBe(false); // as demais esperam
    expect(breaker.tryAcquire()).toBe(false);
  });

  it('sonda com sucesso fecha o circuito', () => {
    const { breaker, clock } = make();
    for (let i = 0; i < 3; i++) breaker.onFailure();
    clock.t = 1_000;
    breaker.tryAcquire();
    breaker.onSuccess();
    expect(breaker.state).toBe('closed');
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.tryAcquire()).toBe(true);
  });

  it('sonda que falha reabre por mais openMs (a contagem recomeca no momento da falha)', () => {
    const { breaker, clock } = make();
    for (let i = 0; i < 3; i++) breaker.onFailure();
    clock.t = 1_000;
    breaker.tryAcquire();
    breaker.onFailure();
    expect(breaker.state).toBe('open');
    clock.t = 1_999;
    expect(breaker.state).toBe('open');
    clock.t = 2_000;
    expect(breaker.state).toBe('half_open');
  });

  it('fechado, todas as chamadas passam', () => {
    const { breaker } = make();
    for (let i = 0; i < 20; i++) expect(breaker.tryAcquire()).toBe(true);
  });
});

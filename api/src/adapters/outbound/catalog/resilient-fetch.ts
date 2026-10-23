/**
 * Cliente HTTP defensivo para APIs de terceiros: timeout real, teto de bytes, sem redirecionamento,
 * so JSON, retry com backoff e circuit breaker. Nada aqui conhece o dominio do leilao.
 */
export type UpstreamErrorKind =
  'timeout' | 'network' | 'http' | 'payload' | 'too_large' | 'circuit_open';

export class UpstreamError extends Error {
  readonly status: number | undefined;

  constructor(
    message: string,
    readonly kind: UpstreamErrorKind,
    status?: number,
  ) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
  }

  /** Falha provavelmente passageira (vale tentar de novo). 4xx, payload ruim e arquivo gigante nao. */
  get retryable(): boolean {
    if (this.kind === 'timeout' || this.kind === 'network') return true;
    return (
      this.kind === 'http' &&
      this.status !== undefined &&
      (this.status === 429 || this.status >= 500)
    );
  }
}

/** O recurso nao existe la (404). Resposta valida: nao e falha do upstream e nao abre o breaker. */
export class UpstreamNotFound extends Error {
  constructor() {
    super('recurso nao encontrado no upstream');
    this.name = 'UpstreamNotFound';
  }
}

export interface FetchJsonOptions {
  readonly fetch: typeof fetch;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly userAgent: string;
}

export async function fetchJson(url: string, options: FetchJsonOptions): Promise<unknown> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new UpstreamError(`timeout apos ${options.timeoutMs}ms`, 'timeout'));
    }, options.timeoutMs);
  });
  // O `race` se inscreve nas duas pontas: se o timeout vencer, a rejeicao tardia do download
  // (provocada pelo abort) continua tratada e nao vira unhandledRejection.
  const work = download(url, options, controller.signal);
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // ja encerrado
  }
}

async function download(
  url: string,
  options: FetchJsonOptions,
  signal: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await options.fetch(url, {
      method: 'GET',
      signal,
      // Redirecionamento desligado: um 30x malicioso nao pode nos levar a outro host (SSRF).
      redirect: 'error',
      headers: { accept: 'application/json', 'user-agent': options.userAgent },
    });
  } catch (error) {
    throw new UpstreamError(`falha de rede: ${describe(error)}`, 'network');
  }

  if (response.status === 404) {
    await discard(response);
    throw new UpstreamNotFound();
  }
  if (!response.ok) {
    await discard(response);
    throw new UpstreamError(`HTTP ${response.status}`, 'http', response.status);
  }
  if (!/json/i.test(response.headers.get('content-type') ?? '')) {
    await discard(response);
    throw new UpstreamError('resposta nao e JSON', 'payload');
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > options.maxBytes) {
    await discard(response);
    throw new UpstreamError(`resposta maior que ${options.maxBytes} bytes`, 'too_large');
  }

  const text = await readCapped(response, options.maxBytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new UpstreamError('JSON invalido', 'payload');
  }
}

/** Le o corpo em pedacos e aborta ao passar do teto: Content-Length ausente ou mentiroso nao protege ninguem. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new UpstreamError(`resposta maior que ${maxBytes} bytes`, 'too_large');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError(`falha lendo a resposta: ${describe(error)}`, 'network');
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.name : 'erro desconhecido';
}

export interface RetryOptions {
  /** Tentativas EXTRAS depois da primeira. */
  readonly retries: number;
  readonly baseDelayMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
}

/** Backoff exponencial com jitter; so repete erro marcado como passageiro. */
export async function withRetry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof UpstreamError) || !error.retryable || attempt >= options.retries) {
        throw error;
      }
      const jitter = 0.5 + options.random() * 0.5;
      await options.sleep(Math.round(options.baseDelayMs * 2 ** attempt * jitter));
    }
  }
}

export interface BreakerOptions {
  /** Falhas CONSECUTIVAS (chamadas logicas, ja depois dos retries) para abrir. */
  readonly failureThreshold: number;
  readonly openMs: number;
  readonly now: () => number;
}

export type BreakerState = 'closed' | 'open' | 'half_open';

/**
 * Aberto: nem tenta (responde na hora, sem gastar timeout). Depois de `openMs` deixa passar UMA
 * sonda; sucesso fecha, falha reabre por mais `openMs`.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private probing = false;

  constructor(private readonly options: BreakerOptions) {}

  get state(): BreakerState {
    if (this.openedAt === null) return 'closed';
    return this.options.now() - this.openedAt >= this.options.openMs ? 'half_open' : 'open';
  }

  /** true se pode chamar o upstream agora. Em meio-aberto, so uma sonda por vez. */
  tryAcquire(): boolean {
    const state = this.state;
    if (state === 'closed') return true;
    if (state === 'open' || this.probing) return false;
    this.probing = true;
    return true;
  }

  onSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
    this.probing = false;
  }

  onFailure(): void {
    const wasProbe = this.probing;
    this.probing = false;
    this.failures += 1;
    if (wasProbe || this.openedAt !== null || this.failures >= this.options.failureThreshold) {
      this.openedAt = this.options.now();
    }
  }
}

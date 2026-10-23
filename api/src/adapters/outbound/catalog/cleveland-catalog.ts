import { CatalogUnavailableError, NotFoundError } from '../../../application/errors.js';
import type { Catalog, CatalogSearchResult, ItemSnapshot } from '../../../application/ports.js';
import {
  CLEVELAND_FIELDS,
  SOURCE_ID_PATTERN,
  parseItemResponse,
  parseSearchResponse,
} from './cleveland-mapper.js';
import { OFFLINE_ITEMS } from './offline-catalog.data.js';
import {
  CircuitBreaker,
  UpstreamError,
  UpstreamNotFound,
  fetchJson,
  withRetry,
} from './resilient-fetch.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

export interface CatalogLogger {
  warn(data: Record<string, unknown>, message: string): void;
}

export interface ClevelandCatalogOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly logger?: CatalogLogger;
  readonly offlineItems?: readonly ItemSnapshot[];
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly retryBaseDelayMs?: number;
  readonly maxBytes?: number;
  readonly pageSize?: number;
  /** Cache considerado fresco: serve sem chamar a API. */
  readonly freshMs?: number;
  /** Cache vencido ainda serve quando a API falha (stale-if-error). */
  readonly staleMs?: number;
  readonly cacheEntries?: number;
  readonly breakerFailureThreshold?: number;
  readonly breakerOpenMs?: number;
}

interface SearchValue {
  readonly items: readonly ItemSnapshot[];
  readonly total: number;
}

/** Cache LRU simples e limitado (memoria nao cresce com termos de busca arbitrarios). */
class BoundedCache<T> {
  private readonly entries = new Map<string, { value: T; at: number }>();

  constructor(
    private readonly max: number,
    private readonly now: () => number,
  ) {}

  get(key: string): { value: T; ageMs: number } | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry); // mais recente
    return { value: entry.value, ageMs: this.now() - entry.at };
  }

  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, { value, at: this.now() });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }
}

/**
 * Catalogo de itens baseado no Cleveland Museum of Art Open Access (CC0).
 *
 * O leilao nao depende dele em tempo de execucao: o lote guarda um snapshot do item. Aqui so se
 * busca e se escolhe item. Para essa escolha nunca travar, a ordem de degradacao e:
 * cache fresco -> API (com timeout/retry/breaker) -> cache vencido -> catalogo offline embutido.
 */
export class ClevelandCatalog implements Catalog {
  private readonly o: Required<
    Omit<ClevelandCatalogOptions, 'logger' | 'offlineItems' | 'fetch' | 'now' | 'sleep' | 'random'>
  >;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly logger: CatalogLogger | undefined;
  private readonly offline: readonly ItemSnapshot[];
  private readonly breaker: CircuitBreaker;
  private readonly searchCache: BoundedCache<SearchValue>;
  private readonly itemCache: BoundedCache<ItemSnapshot>;
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(options: ClevelandCatalogOptions = {}) {
    this.o = {
      baseUrl: options.baseUrl ?? 'https://openaccess-api.clevelandart.org/api',
      timeoutMs: options.timeoutMs ?? 3_000,
      retries: options.retries ?? 1,
      retryBaseDelayMs: options.retryBaseDelayMs ?? 250,
      maxBytes: options.maxBytes ?? 2_000_000,
      pageSize: options.pageSize ?? 12,
      freshMs: options.freshMs ?? 10 * MIN,
      staleMs: options.staleMs ?? 24 * HOUR,
      cacheEntries: options.cacheEntries ?? 500,
      breakerFailureThreshold: options.breakerFailureThreshold ?? 4,
      breakerOpenMs: options.breakerOpenMs ?? 30_000,
    };
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.logger = options.logger;
    this.offline = options.offlineItems ?? OFFLINE_ITEMS;
    this.breaker = new CircuitBreaker({
      failureThreshold: this.o.breakerFailureThreshold,
      openMs: this.o.breakerOpenMs,
      now: this.now,
    });
    this.searchCache = new BoundedCache(this.o.cacheEntries, this.now);
    this.itemCache = new BoundedCache(this.o.cacheEntries, this.now);
  }

  async search(query: string, page: number): Promise<CatalogSearchResult> {
    const q = query.trim();
    const key = `${q.toLowerCase()}|${page}`;
    const cached = this.searchCache.get(key);
    if (cached !== undefined && cached.ageMs < this.o.freshMs) {
      return this.toResult(cached.value, page, false);
    }
    try {
      const value = await this.singleFlight(`search|${key}`, () => this.fetchSearch(q, page, key));
      return this.toResult(value, page, false);
    } catch (error) {
      this.logFallback('search', error);
      if (cached !== undefined && cached.ageMs < this.o.staleMs) {
        return this.toResult(cached.value, page, true);
      }
      return this.toResult(this.searchOffline(q, page), page, true);
    }
  }

  async getItem(sourceId: string): Promise<ItemSnapshot> {
    if (!SOURCE_ID_PATTERN.test(sourceId)) throw itemNotFound();
    const cached = this.itemCache.get(sourceId);
    if (cached !== undefined && cached.ageMs < this.o.freshMs) return cached.value;
    try {
      const item = await this.singleFlight(`item|${sourceId}`, () => this.fetchItem(sourceId));
      if (item === null) throw itemNotFound();
      return item;
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      this.logFallback('item', error);
      if (cached !== undefined && cached.ageMs < this.o.staleMs) return cached.value;
      const offline = this.offline.find((item) => item.sourceId === sourceId);
      if (offline !== undefined) return offline;
      throw new CatalogUnavailableError();
    }
  }

  private async fetchSearch(q: string, page: number, key: string): Promise<SearchValue> {
    const params = new URLSearchParams({
      has_image: '1',
      cc0: '1',
      limit: String(this.o.pageSize),
      skip: String((page - 1) * this.o.pageSize),
      fields: CLEVELAND_FIELDS,
    });
    if (q !== '') params.set('q', q);
    const value = await this.request(`${this.o.baseUrl}/artworks/?${params.toString()}`, (body) =>
      parseSearchResponse(body),
    );
    this.searchCache.set(key, value);
    // O item escolhido na busca costuma ser o mesmo que vira lote: poupa a chamada seguinte.
    for (const item of value.items) this.itemCache.set(item.sourceId, item);
    return value;
  }

  private async fetchItem(sourceId: string): Promise<ItemSnapshot | null> {
    const url = `${this.o.baseUrl}/artworks/${encodeURIComponent(sourceId)}?fields=${CLEVELAND_FIELDS}`;
    try {
      const item = await this.request(url, (body) => {
        const mapped = parseItemResponse(body);
        // Resposta de outro item (ou adulterada) nao pode virar o item pedido.
        if (mapped !== null && mapped.sourceId !== sourceId) {
          throw new UpstreamError('item devolvido difere do pedido', 'payload');
        }
        return mapped;
      });
      if (item !== null) this.itemCache.set(sourceId, item);
      return item;
    } catch (error) {
      if (error instanceof UpstreamNotFound) return null;
      throw error;
    }
  }

  /** Uma chamada ao upstream: breaker -> retry(fetch) -> parse. 404 e resposta valida, nao falha. */
  private async request<T>(url: string, parse: (body: unknown) => T): Promise<T> {
    if (!this.breaker.tryAcquire()) {
      throw new UpstreamError('circuit breaker aberto', 'circuit_open');
    }
    try {
      const body = await withRetry(
        () =>
          fetchJson(url, {
            fetch: this.fetchImpl,
            timeoutMs: this.o.timeoutMs,
            maxBytes: this.o.maxBytes,
            userAgent: 'leilao-verzel/1.0 (teste tecnico)',
          }),
        {
          retries: this.o.retries,
          baseDelayMs: this.o.retryBaseDelayMs,
          sleep: this.sleep,
          random: this.random,
        },
      );
      const parsed = parse(body);
      this.breaker.onSuccess();
      return parsed;
    } catch (error) {
      if (error instanceof UpstreamNotFound) this.breaker.onSuccess();
      else this.breaker.onFailure();
      throw error;
    }
  }

  /** Chamadas simultaneas iguais viram uma so (evita estouro de boiada quando o cache expira). */
  private singleFlight<T>(key: string, factory: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing !== undefined) return existing as Promise<T>;
    const promise = factory().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  private searchOffline(q: string, page: number): SearchValue {
    const needle = q.toLowerCase();
    const matches =
      needle === ''
        ? this.offline
        : this.offline.filter(
            (item) =>
              item.title.toLowerCase().includes(needle) ||
              (item.attributes['Artista'] ?? '').toLowerCase().includes(needle),
          );
    const start = (page - 1) * this.o.pageSize;
    return { items: matches.slice(start, start + this.o.pageSize), total: matches.length };
  }

  private toResult(value: SearchValue, page: number, degraded: boolean): CatalogSearchResult {
    return {
      items: value.items,
      total: value.total,
      page,
      pageSize: this.o.pageSize,
      degraded,
    };
  }

  private logFallback(operation: string, error: unknown): void {
    const kind = error instanceof UpstreamError ? error.kind : 'unexpected';
    const status = error instanceof UpstreamError ? error.status : undefined;
    this.logger?.warn(
      { operation, kind, status, breaker: this.breaker.state },
      'catalogo externo indisponivel; usando cache ou catalogo offline',
    );
  }
}

function itemNotFound(): NotFoundError {
  return new NotFoundError('ITEM_NOT_FOUND', 'Item nao encontrado no catalogo.');
}

import type { Actor, AuctionEvent } from '../../../../application/ports.js';
import type { LotDetailDto } from '../../../../application/usecases/auction-queries.js';
import type { Mac } from '../../../../domain/hash-chain.js';
import { addCents } from '../../../../domain/money.js';
import type { Cents } from '../../../../domain/money.js';
import { publicBidderRef } from '../../../../domain/public-bidder-ref.js';
import { HttpError } from '../http-error.js';

/**
 * Tempo real da sala do lote (Server-Sent Events).
 *
 * O hub nao conhece Express: fala com um `SseSink` abstrato. Assim limites, filtro por lote,
 * corrida snapshot x evento e cliente lento sao testados sem rede.
 *
 * Garantias:
 * - sem perda: assina o barramento ANTES de ler o snapshot e entrega depois os eventos que chegaram
 *   no meio (lance com `seq` ja contido no snapshot e descartado);
 * - privacidade: o licitante vai como referencia anonima; id interno nunca e serializado
 *   (`previousLeaderId` so serve para calcular a flag `outbid` de cada conexao);
 * - recursos: teto total, por lote e por IP; cliente lento e derrubado; vida maxima por conexao.
 */
export interface SseSink {
  /** Escreve os cabecalhos 200 text/event-stream. Chamado uma unica vez, so com o snapshot em maos. */
  open(): void;
  write(chunk: string): boolean;
  readonly writableLength: number;
  end(): void;
  destroy(): void;
}

export interface HubLimits {
  readonly maxConnections: number;
  readonly maxPerLot: number;
  readonly maxPerIp: number;
  /** Acima disso o cliente nao esta lendo: derruba em vez de acumular memoria. */
  readonly maxBufferedBytes: number;
  /** Eventos que podem esperar enquanto o snapshot carrega. */
  readonly maxPendingEvents: number;
  readonly heartbeatMs: number;
  /** O cliente reconecta sozinho (EventSource): renova autenticacao e libera recursos velhos. */
  readonly maxLifetimeMs: number;
  /** Intervalo de reconexao sugerido ao navegador. */
  readonly retryMs: number;
}

export const DEFAULT_HUB_LIMITS: HubLimits = {
  maxConnections: 2_000,
  maxPerLot: 1_000,
  maxPerIp: 20,
  maxBufferedBytes: 64 * 1024,
  maxPendingEvents: 200,
  heartbeatMs: 15_000,
  maxLifetimeMs: 10 * 60_000,
  retryMs: 3_000,
};

export interface HubDeps {
  readonly bus: { subscribe(listener: (event: AuctionEvent) => void): () => void };
  readonly loadSnapshot: (viewer: Actor | null, lotId: string) => Promise<LotDetailDto>;
  readonly mac: Mac;
  readonly now: () => number;
  readonly logger?: { warn(data: Record<string, unknown>, message: string): void };
  readonly limits?: Partial<HubLimits>;
  /** Desligue nos testes para controlar o batimento com `tick()`. */
  readonly autoTick?: boolean;
}

export interface ConnectParams {
  readonly lotId: string;
  readonly viewer: Actor | null;
  readonly ip: string;
  readonly sink: SseSink;
  /** Abortado quando o cliente desconecta, inclusive durante o carregamento do snapshot. */
  readonly signal?: AbortSignal;
}

export type ConnectResult =
  /** Transmissao aberta. `close` libera a vaga (idempotente). */
  | { readonly status: 'streaming'; readonly close: () => void }
  /** Lote ja encerrado/cancelado: nao ha o que transmitir. A rota responde 204 (o EventSource nao reconecta). */
  | { readonly status: 'finished' };

interface Connection {
  readonly lotId: string;
  readonly viewer: Actor | null;
  readonly ip: string;
  readonly sink: SseSink;
  readonly openedAt: number;
  minIncrement: Cents | null;
  lastSeq: number;
  ready: boolean;
  removed: boolean;
  pending: AuctionEvent[];
}

const frame = (event: string, data: unknown): string =>
  // JSON.stringify nunca emite quebra de linha crua: nao ha como injetar outro campo SSE.
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export class LotEventHub {
  private readonly limits: HubLimits;
  private readonly byLot = new Map<string, Set<Connection>>();
  private readonly perIp = new Map<string, number>();
  private total = 0;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: HubDeps) {
    this.limits = { ...DEFAULT_HUB_LIMITS, ...deps.limits };
    this.unsubscribe = deps.bus.subscribe((event) => this.onEvent(event));
  }

  async connect(params: ConnectParams): Promise<ConnectResult> {
    if (this.closed) {
      throw new HttpError(503, 'SHUTTING_DOWN', 'Servidor reiniciando. Tente em instantes.');
    }
    this.assertCapacity(params.lotId, params.ip);

    const conn: Connection = {
      lotId: params.lotId,
      viewer: params.viewer,
      ip: params.ip,
      sink: params.sink,
      openedAt: this.deps.now(),
      minIncrement: null,
      lastSeq: 0,
      ready: false,
      removed: false,
      pending: [],
    };
    this.add(conn);
    const onAbort = () => this.remove(conn);
    params.signal?.addEventListener('abort', onAbort, { once: true });

    let snapshot: LotDetailDto;
    try {
      // A assinatura do barramento ja existe: lances que chegarem agora ficam em `pending`.
      snapshot = await this.deps.loadSnapshot(params.viewer, params.lotId);
    } catch (error) {
      this.remove(conn);
      throw error;
    }

    if (conn.removed || params.signal?.aborted === true) {
      this.remove(conn);
      return { status: 'finished' };
    }
    if (snapshot.phase === 'closed' || snapshot.phase === 'cancelled') {
      this.remove(conn);
      return { status: 'finished' };
    }

    conn.minIncrement = snapshot.minIncrement;
    conn.lastSeq = snapshot.bidCount;
    params.sink.open();
    params.sink.write(`retry: ${this.limits.retryMs}\n\n`);
    params.sink.write(frame('snapshot', { lot: snapshot }));
    conn.ready = true;

    const queued = conn.pending;
    conn.pending = [];
    for (const event of queued) {
      if (conn.removed) break;
      this.deliver(conn, event, undefined);
    }
    return { status: 'streaming', close: () => this.remove(conn) };
  }

  /** Batimento: sincroniza o relogio do cliente, detecta conexao morta e aposenta as muito antigas. */
  tick(): void {
    const now = this.deps.now();
    const beat = frame('tick', { serverNow: new Date(now).toISOString() });
    for (const conn of [...this.connections()]) {
      if (!conn.ready || conn.removed) continue;
      if (now - conn.openedAt >= this.limits.maxLifetimeMs) {
        this.remove(conn);
        conn.sink.end();
        continue;
      }
      this.write(conn, beat);
    }
  }

  stats(): { connections: number; lots: number; ips: number } {
    return { connections: this.total, lots: this.byLot.size, ips: this.perIp.size };
  }

  /** Desligamento ordenado: encerra todas as transmissoes e para de ouvir o barramento. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    for (const conn of [...this.connections()]) {
      this.remove(conn);
      conn.sink.end();
    }
    this.stopTimer();
  }

  // ----- internos -------------------------------------------------------------------------

  private assertCapacity(lotId: string, ip: string): void {
    if (this.total >= this.limits.maxConnections) {
      throw new HttpError(
        503,
        'STREAM_CAPACITY',
        'Muitas pessoas acompanhando agora. Tente em instantes.',
      );
    }
    if ((this.byLot.get(lotId)?.size ?? 0) >= this.limits.maxPerLot) {
      throw new HttpError(
        503,
        'STREAM_CAPACITY',
        'Esta sala esta lotada de espectadores. Tente em instantes.',
      );
    }
    if ((this.perIp.get(ip) ?? 0) >= this.limits.maxPerIp) {
      throw new HttpError(429, 'TOO_MANY_STREAMS', 'Muitas salas abertas neste dispositivo.');
    }
  }

  private add(conn: Connection): void {
    let set = this.byLot.get(conn.lotId);
    if (set === undefined) {
      set = new Set();
      this.byLot.set(conn.lotId, set);
    }
    set.add(conn);
    this.perIp.set(conn.ip, (this.perIp.get(conn.ip) ?? 0) + 1);
    this.total += 1;
    this.ensureTimer();
  }

  private remove(conn: Connection): void {
    if (conn.removed) return;
    conn.removed = true;
    conn.pending = [];
    const set = this.byLot.get(conn.lotId);
    set?.delete(conn);
    if (set !== undefined && set.size === 0) this.byLot.delete(conn.lotId);
    const ipCount = (this.perIp.get(conn.ip) ?? 1) - 1;
    if (ipCount <= 0) this.perIp.delete(conn.ip);
    else this.perIp.set(conn.ip, ipCount);
    this.total -= 1;
    if (this.total === 0) this.stopTimer();
  }

  private *connections(): Iterable<Connection> {
    for (const set of this.byLot.values()) yield* set;
  }

  private ensureTimer(): void {
    if (this.timer !== undefined || this.deps.autoTick === false || this.closed) return;
    this.timer = setInterval(() => this.tick(), this.limits.heartbeatMs);
    this.timer.unref();
  }

  private stopTimer(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private onEvent(event: AuctionEvent): void {
    const set = this.byLot.get(event.lotId);
    if (set === undefined) return;
    const shared =
      event.type === 'bid_placed'
        ? { bidder: publicBidderRef(this.deps.mac, event.bidderId, event.lotId) }
        : undefined;
    for (const conn of [...set]) {
      if (conn.removed) continue;
      if (!conn.ready) {
        if (conn.pending.length >= this.limits.maxPendingEvents) {
          this.drop(conn, 'pending_overflow');
        } else {
          conn.pending.push(event);
        }
        continue;
      }
      this.deliver(conn, event, shared);
    }
  }

  private deliver(
    conn: Connection,
    event: AuctionEvent,
    shared: { bidder: string } | undefined,
  ): void {
    const serverNow = new Date(this.deps.now()).toISOString();
    switch (event.type) {
      case 'bid_placed': {
        // Lance ja refletido no snapshot (ou repetido): nada a dizer.
        if (event.seq <= conn.lastSeq) return;
        conn.lastSeq = event.seq;
        const bidder =
          shared?.bidder ?? publicBidderRef(this.deps.mac, event.bidderId, event.lotId);
        this.write(
          conn,
          frame('bid', {
            seq: event.seq,
            amount: event.amount,
            bidder,
            placedAt: event.placedAt,
            endsAt: event.endsAt,
            extended: event.extended,
            bidCount: event.bidCount,
            minimumNextBid:
              conn.minIncrement === null ? null : addCents(event.amount, conn.minIncrement),
            mine: conn.viewer !== null && conn.viewer.id === event.bidderId,
            outbid:
              conn.viewer !== null &&
              conn.viewer.id === event.previousLeaderId &&
              conn.viewer.id !== event.bidderId,
            serverNow,
          }),
        );
        return;
      }
      case 'lot_closed':
        this.finish(conn, frame('closed', { sold: event.sold, serverNow }));
        return;
      case 'lot_cancelled':
        this.finish(conn, frame('cancelled', { serverNow }));
        return;
    }
  }

  /** Evento final: entrega e encerra. O cliente le o resultado em GET /lots/:id. */
  private finish(conn: Connection, chunk: string): void {
    this.write(conn, chunk);
    if (conn.removed) return;
    this.remove(conn);
    conn.sink.end();
  }

  private write(conn: Connection, chunk: string): void {
    if (conn.removed) return;
    if (conn.sink.writableLength > this.limits.maxBufferedBytes) {
      this.drop(conn, 'slow_consumer');
      return;
    }
    try {
      conn.sink.write(chunk);
    } catch {
      this.drop(conn, 'write_failed');
      return;
    }
    if (conn.sink.writableLength > this.limits.maxBufferedBytes) this.drop(conn, 'slow_consumer');
  }

  private drop(conn: Connection, reason: string): void {
    this.deps.logger?.warn({ reason, lotId: conn.lotId }, 'sse_connection_dropped');
    this.remove(conn);
    try {
      conn.sink.destroy();
    } catch {
      // ja destruido
    }
  }
}

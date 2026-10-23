import { useEffect, useRef, useState } from 'react';
import { lotEventsUrl } from '../../api/endpoints';
import type { BidEventPayload, LotDetail } from '../../api/types';
import { parseBidEvent, parseServerNow, parseSnapshot } from './room-state';

export type StreamStatus = 'off' | 'connecting' | 'live' | 'reconnecting';

/** O que o hook precisa de um EventSource (permite trocar por um falso nos testes). */
export interface EventSourceLike {
  readonly readyState: number;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}

export interface StreamHandlers {
  onSnapshot(lot: LotDetail): void;
  onBid(event: BidEventPayload): void;
  /** Lote encerrado ou cancelado: o resultado oficial vem de GET /lots/:id. */
  onFinished(kind: 'closed' | 'cancelled'): void;
  onServerTime(serverNowIso: string): void;
  /** O navegador desistiu (204 de lote encerrado, 429, 503): a tela confere o estado real. */
  onGiveUp(): void;
}

export interface UseLotStreamOptions {
  lotId: string;
  enabled: boolean;
  /** Muda quando a pessoa entra/sai: a conexao recomeca para o servidor recalcular "mine"/"outbid". */
  viewerKey: string;
  handlers: StreamHandlers;
  createSource?: (url: string) => EventSourceLike;
}

const EVENT_SOURCE_CLOSED = 2;
const BASE_RETRY_MS = 2_000;
const MAX_RETRY_MS = 30_000;

const defaultCreateSource = (url: string): EventSourceLike =>
  new EventSource(url) as unknown as EventSourceLike;

/** Espera exponencial com jitter: muita gente reconectando junto nao derruba o servidor. */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.75 + random() * 0.5));
}

/**
 * Tempo real da sala (Server-Sent Events).
 *
 * - queda de rede: o proprio navegador reconecta (readyState CONNECTING) e o servidor reenvia o
 *   snapshot, que substitui o estado local;
 * - o navegador DESISTE (readyState CLOSED: resposta 204/429/503): a tela confere o lote e, se
 *   ainda estiver de pe, tentamos de novo com espera crescente;
 * - 'closed'/'cancelled': fechamos NOS MESMOS a conexao (o servidor encerra a transmissao e o
 *   EventSource reconectaria a toa).
 */
export function useLotStream(options: UseLotStreamOptions): StreamStatus {
  const { lotId, enabled, viewerKey, createSource = defaultCreateSource } = options;
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const handlersRef = useRef(options.handlers);
  useEffect(() => {
    handlersRef.current = options.handlers;
  });

  useEffect(() => {
    if (!enabled) return;

    let disposed = false;
    let source: EventSourceLike | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const parse = (event: MessageEvent<string>): unknown => {
      try {
        return JSON.parse(event.data) as unknown;
      } catch {
        return null;
      }
    };

    const connect = () => {
      if (disposed) return;
      setStatus(attempt === 0 ? 'connecting' : 'reconnecting');
      const current = createSource(lotEventsUrl(lotId));
      source = current;

      current.addEventListener('snapshot', (event) => {
        const lot = parseSnapshot(parse(event));
        if (lot === null) return;
        attempt = 0;
        setStatus('live');
        handlersRef.current.onServerTime(lot.serverNow);
        handlersRef.current.onSnapshot(lot);
      });

      current.addEventListener('bid', (event) => {
        const raw = parse(event);
        const bid = parseBidEvent(raw);
        if (bid === null) return;
        handlersRef.current.onServerTime(bid.serverNow);
        handlersRef.current.onBid(bid);
      });

      current.addEventListener('tick', (event) => {
        const serverNow = parseServerNow(parse(event));
        if (serverNow !== undefined) handlersRef.current.onServerTime(serverNow);
      });

      const finish = (kind: 'closed' | 'cancelled') => (event: MessageEvent<string>) => {
        const serverNow = parseServerNow(parse(event));
        if (serverNow !== undefined) handlersRef.current.onServerTime(serverNow);
        current.close();
        source = null;
        setStatus('off');
        handlersRef.current.onFinished(kind);
      };
      current.addEventListener('closed', finish('closed'));
      current.addEventListener('cancelled', finish('cancelled'));

      current.onerror = () => {
        if (disposed || source !== current) return;
        if (current.readyState !== EVENT_SOURCE_CLOSED) {
          // O navegador ja esta reconectando sozinho.
          setStatus('reconnecting');
          return;
        }
        current.close();
        source = null;
        setStatus('reconnecting');
        handlersRef.current.onGiveUp();
        attempt += 1;
        retryTimer = setTimeout(connect, retryDelayMs(attempt));
      };
    };

    connect();

    return () => {
      disposed = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      source?.close();
      source = null;
    };
  }, [lotId, enabled, viewerKey, createSource]);

  // Desativado = sem conexao, seja qual for o ultimo estado guardado.
  return enabled ? status : 'off';
}

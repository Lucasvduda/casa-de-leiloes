import { useSyncExternalStore } from 'react';

/**
 * Relogio do SERVIDOR. A contagem regressiva nunca usa o relogio do aparelho sozinho: aparelho
 * adiantado/atrasado mostraria o fim do leilao errado. Toda resposta com `serverNow` (listas, sala,
 * batimento do SSE) recalibra o deslocamento.
 *
 * Nota: a latencia da rede nao e descontada. O erro e de dezenas de ms e sempre para o lado seguro
 * (o relogio local mostra um pouco MAIS tempo restante); quem decide se o lance vale e o servidor.
 */
class ServerClock {
  private offsetMs = 0;
  private readonly listeners = new Set<() => void>();

  /** `receivedAt` existe para teste; em uso real e o instante da chegada da resposta. */
  sync(serverNowIso: string | undefined, receivedAt: number = Date.now()): void {
    if (serverNowIso === undefined) return;
    const server = Date.parse(serverNowIso);
    if (!Number.isFinite(server)) return;
    const next = server - receivedAt;
    if (next === this.offsetMs) return;
    this.offsetMs = next;
    for (const listener of this.listeners) listener();
  }

  now(): number {
    return Date.now() + this.offsetMs;
  }

  get offset(): number {
    return this.offsetMs;
  }

  reset(): void {
    this.offsetMs = 0;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const serverClock = new ServerClock();

// ---------------------------------------------------------------------------------------------
// Um unico intervalo para a tela inteira (a vitrine tem dezenas de contagens regressivas).
// ---------------------------------------------------------------------------------------------

const TICK_MS = 1000;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let snapshot = serverClock.now();

function refresh(): void {
  snapshot = serverClock.now();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === undefined) {
    snapshot = serverClock.now();
    timer = setInterval(refresh, TICK_MS);
  }
  const stopSync = serverClock.subscribe(refresh);
  return () => {
    stopSync();
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** Hora do servidor em ms, atualizada a cada segundo (e na hora em que o relogio e recalibrado). */
export function useServerNow(): number {
  return useSyncExternalStore(subscribe, () => snapshot);
}

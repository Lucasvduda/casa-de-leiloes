import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { iso, makeBid, makeLot } from '../../test/fixtures';
import { retryDelayMs, useLotStream } from './use-lot-stream';
import type { EventSourceLike, StreamHandlers } from './use-lot-stream';

class FakeSource implements EventSourceLike {
  static instances: FakeSource[] = [];
  readyState = 0;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();

  constructor(readonly url: string) {
    FakeSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  emit(type: string, data: unknown, raw = false): void {
    const payload = raw ? String(data) : JSON.stringify(data);
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: payload } as MessageEvent<string>);
    }
  }

  fail(readyState: number): void {
    this.readyState = readyState;
    this.onerror?.(new Event('error'));
  }
}

const createSource = (url: string): EventSourceLike => new FakeSource(url);
const last = (): FakeSource => FakeSource.instances[FakeSource.instances.length - 1] as FakeSource;

function makeHandlers(): StreamHandlers {
  return {
    onSnapshot: vi.fn(),
    onBid: vi.fn(),
    onFinished: vi.fn(),
    onServerTime: vi.fn(),
    onGiveUp: vi.fn(),
  };
}

function setup(overrides: { enabled?: boolean; viewerKey?: string; lotId?: string } = {}) {
  const handlers = makeHandlers();
  const hook = renderHook(
    (props: { enabled: boolean; viewerKey: string; lotId: string }) =>
      useLotStream({ ...props, handlers, createSource }),
    {
      initialProps: {
        enabled: overrides.enabled ?? true,
        viewerKey: overrides.viewerKey ?? 'anon',
        lotId: overrides.lotId ?? 'lot-1',
      },
    },
  );
  return { handlers, ...hook };
}

describe('retryDelayMs', () => {
  it('cresce de forma exponencial, com teto de 30 s e jitter de +-25%', () => {
    const mid = () => 0.5; // jitter neutro (fator 1.0)
    expect(retryDelayMs(1, mid)).toBe(2_000);
    expect(retryDelayMs(2, mid)).toBe(4_000);
    expect(retryDelayMs(3, mid)).toBe(8_000);
    expect(retryDelayMs(4, mid)).toBe(16_000);
    expect(retryDelayMs(5, mid)).toBe(30_000);
    expect(retryDelayMs(50, mid)).toBe(30_000);
    expect(retryDelayMs(1, () => 0)).toBe(1_500);
    expect(retryDelayMs(1, () => 1)).toBe(2_500);
  });
});

describe('useLotStream', () => {
  beforeEach(() => {
    FakeSource.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('conecta na URL da sala e fica "live" depois do snapshot', () => {
    const { result, handlers } = setup({ lotId: 'abc 1' });
    expect(FakeSource.instances).toHaveLength(1);
    expect(last().url).toBe('/api/lots/abc%201/events');
    expect(result.current).toBe('connecting');

    const lot = makeLot({ bidCount: 2 });
    act(() => last().emit('snapshot', { lot }));
    expect(result.current).toBe('live');
    expect(handlers.onSnapshot).toHaveBeenCalledWith(lot);
    expect(handlers.onServerTime).toHaveBeenCalledWith(lot.serverNow);
  });

  it('entrega lances e sincroniza o relogio com o batimento', () => {
    const { handlers } = setup();
    const bid = makeBid({ seq: 4, bidCount: 4 });
    act(() => last().emit('bid', bid));
    expect(handlers.onBid).toHaveBeenCalledWith(
      expect.objectContaining({ seq: 4, amount: 10_000 }),
    );

    act(() => last().emit('tick', { serverNow: iso(15_000) }));
    expect(handlers.onServerTime).toHaveBeenLastCalledWith(iso(15_000));
  });

  it('ignora evento com JSON quebrado ou formato errado, sem derrubar nada', () => {
    const { result, handlers } = setup();
    act(() => {
      last().emit('snapshot', '{quebrado', true);
      last().emit('bid', '<html>', true);
      last().emit('bid', { seq: 'x' });
      last().emit('snapshot', { lot: { id: 1 } });
      last().emit('tick', 'lixo', true);
    });
    expect(handlers.onSnapshot).not.toHaveBeenCalled();
    expect(handlers.onBid).not.toHaveBeenCalled();
    expect(result.current).toBe('connecting');
    expect(last().closed).toBe(false);
  });

  it('closed/cancelled: avisa, fecha a conexao por conta propria e NAO reconecta', () => {
    const { result, handlers } = setup();
    const source = last();
    act(() => source.emit('closed', { sold: true, serverNow: iso(0) }));
    expect(handlers.onFinished).toHaveBeenCalledWith('closed');
    expect(source.closed).toBe(true);
    expect(result.current).toBe('off');

    // O servidor encerra a transmissao: o erro que o navegador dispara depois nao reabre nada.
    act(() => source.fail(0));
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(FakeSource.instances).toHaveLength(1);
  });

  it('cancelled tambem encerra', () => {
    const { handlers } = setup();
    act(() => last().emit('cancelled', { serverNow: iso(0) }));
    expect(handlers.onFinished).toHaveBeenCalledWith('cancelled');
    expect(last().closed).toBe(true);
  });

  it('queda de rede (navegador reconectando): mostra "reconectando" e nao cria outra conexao', () => {
    const { result, handlers } = setup();
    act(() => last().emit('snapshot', { lot: makeLot() }));
    act(() => last().fail(0)); // CONNECTING: o navegador tenta sozinho
    expect(result.current).toBe('reconnecting');
    expect(FakeSource.instances).toHaveLength(1);
    expect(handlers.onGiveUp).not.toHaveBeenCalled();

    // O servidor reenvia o snapshot ao reconectar: volta a ficar ao vivo.
    act(() => last().emit('snapshot', { lot: makeLot({ bidCount: 3 }) }));
    expect(result.current).toBe('live');
  });

  it('navegador desiste (CLOSED): avisa a tela e tenta de novo com espera crescente', () => {
    const { result, handlers } = setup();
    act(() => last().fail(2));
    expect(handlers.onGiveUp).toHaveBeenCalledTimes(1);
    expect(result.current).toBe('reconnecting');
    expect(FakeSource.instances).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(FakeSource.instances).toHaveLength(2);

    act(() => last().fail(2));
    expect(handlers.onGiveUp).toHaveBeenCalledTimes(2);
    // 2a tentativa espera mais (>= 3 s): em 2,9 s ainda nao reconectou.
    act(() => {
      vi.advanceTimersByTime(2_900);
    });
    expect(FakeSource.instances).toHaveLength(2);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(FakeSource.instances).toHaveLength(3);
  });

  it('snapshot depois de reconectar zera a contagem de tentativas', () => {
    setup();
    act(() => last().fail(2));
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    act(() => last().emit('snapshot', { lot: makeLot() }));
    act(() => last().fail(2));
    // Voltou a esperar o tempo da 1a tentativa (<= 2,5 s), nao o da 2a.
    act(() => {
      vi.advanceTimersByTime(2_600);
    });
    expect(FakeSource.instances).toHaveLength(3);
  });

  it('desativado (lote encerrado): nao abre conexao', () => {
    const { result } = setup({ enabled: false });
    expect(FakeSource.instances).toHaveLength(0);
    expect(result.current).toBe('off');
  });

  it('desativar fecha a conexao e cancela a nova tentativa pendente', () => {
    const { rerender } = setup();
    act(() => last().fail(2));
    rerender({ enabled: false, viewerKey: 'anon', lotId: 'lot-1' });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(FakeSource.instances).toHaveLength(1);
  });

  it('desmontar fecha a conexao', () => {
    const { unmount } = setup();
    const source = last();
    unmount();
    expect(source.closed).toBe(true);
  });

  it('entrar/sair da conta reabre a conexao (o servidor recalcula "mine" e "outbid")', () => {
    const { rerender } = setup({ viewerKey: 'anon' });
    const first = last();
    rerender({ enabled: true, viewerKey: 'user-1', lotId: 'lot-1' });
    expect(first.closed).toBe(true);
    expect(FakeSource.instances).toHaveLength(2);
  });

  it('trocar de sala reabre em outra URL', () => {
    const { rerender } = setup({ lotId: 'lot-1' });
    rerender({ enabled: true, viewerKey: 'anon', lotId: 'lot-2' });
    expect(last().url).toBe('/api/lots/lot-2/events');
    expect(FakeSource.instances).toHaveLength(2);
  });

  it('re-renderizar com os mesmos parametros nao reconecta', () => {
    const { rerender } = setup();
    rerender({ enabled: true, viewerKey: 'anon', lotId: 'lot-1' });
    rerender({ enabled: true, viewerKey: 'anon', lotId: 'lot-1' });
    expect(FakeSource.instances).toHaveLength(1);
  });

  it('erro depois de desmontar e ignorado', () => {
    const { handlers, unmount } = setup();
    const source = last();
    unmount();
    expect(() => source.fail(2)).not.toThrow();
    expect(handlers.onGiveUp).not.toHaveBeenCalled();
  });
});

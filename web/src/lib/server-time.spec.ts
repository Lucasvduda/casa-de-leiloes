import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serverClock, useServerNow } from './server-time';

describe('serverClock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-23T12:00:00.000Z'));
    serverClock.reset();
  });
  afterEach(() => {
    vi.useRealTimers();
    serverClock.reset();
  });

  it('sem sincronizar, usa o relogio do aparelho', () => {
    expect(serverClock.now()).toBe(Date.now());
  });

  it('aparelho ATRASADO: o relogio corrigido segue o servidor', () => {
    // O servidor diz 12:05, o aparelho marca 12:00.
    serverClock.sync('2026-10-23T12:05:00.000Z');
    expect(serverClock.now()).toBe(Date.parse('2026-10-23T12:05:00.000Z'));
    vi.advanceTimersByTime(10_000);
    expect(serverClock.now()).toBe(Date.parse('2026-10-23T12:05:10.000Z'));
  });

  it('aparelho ADIANTADO: o relogio corrigido volta para o servidor', () => {
    serverClock.sync('2026-10-23T11:50:00.000Z');
    expect(serverClock.now()).toBe(Date.parse('2026-10-23T11:50:00.000Z'));
  });

  it('ignora data invalida ou ausente', () => {
    serverClock.sync('2026-10-23T12:05:00.000Z');
    const before = serverClock.offset;
    serverClock.sync('lixo');
    serverClock.sync(undefined);
    serverClock.sync('');
    expect(serverClock.offset).toBe(before);
  });

  it('avisa quem escuta so quando o deslocamento muda', () => {
    const listener = vi.fn();
    const stop = serverClock.subscribe(listener);
    serverClock.sync('2026-10-23T12:00:05.000Z');
    expect(listener).toHaveBeenCalledTimes(1);
    serverClock.sync('2026-10-23T12:00:05.000Z'); // mesmo deslocamento
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    serverClock.sync('2026-10-23T12:10:00.000Z');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('useServerNow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-23T12:00:00.000Z'));
    serverClock.reset();
  });
  afterEach(() => {
    vi.useRealTimers();
    serverClock.reset();
  });

  it('atualiza a cada segundo', () => {
    const { result } = renderHook(() => useServerNow());
    const first = result.current;
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current - first).toBe(3000);
  });

  it('atualiza na hora quando o relogio e recalibrado', () => {
    const { result } = renderHook(() => useServerNow());
    act(() => {
      serverClock.sync('2026-10-23T12:30:00.000Z');
    });
    expect(result.current).toBe(Date.parse('2026-10-23T12:30:00.000Z'));
  });

  it('varios componentes dividem UM unico intervalo, e ele para quando ninguem usa', () => {
    const a = renderHook(() => useServerNow());
    const b = renderHook(() => useServerNow());
    const c = renderHook(() => useServerNow());
    expect(vi.getTimerCount()).toBe(1);
    a.unmount();
    b.unmount();
    expect(vi.getTimerCount()).toBe(1);
    c.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

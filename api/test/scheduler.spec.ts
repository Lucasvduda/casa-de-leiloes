import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Scheduler, purgeSessionsTask, settleDueTask } from '../src/infrastructure/scheduler.js';
import type { ScheduledTask, Timers } from '../src/infrastructure/scheduler.js';

const logger = () => ({ error: vi.fn() });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const task = (
  name: string,
  everyMs: number,
  run: () => Promise<unknown>,
  extra: Partial<ScheduledTask> = {},
): ScheduledTask => ({
  name,
  everyMs,
  run,
  ...extra,
});

describe('Scheduler: ritmo', () => {
  it('roda ao iniciar e depois a cada intervalo', async () => {
    const run = vi.fn(async () => undefined);
    const scheduler = new Scheduler([task('a', 1_000, run)], logger());
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(run).toHaveBeenCalledTimes(5);
    await scheduler.stop();
  });

  it('runOnStart:false espera o primeiro intervalo', async () => {
    const run = vi.fn(async () => undefined);
    const scheduler = new Scheduler([task('a', 1_000, run, { runOnStart: false })], logger());
    scheduler.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });

  it('start() repetido nao duplica o agendamento', async () => {
    const run = vi.fn(async () => undefined);
    const scheduler = new Scheduler([task('a', 1_000, run)], logger());
    scheduler.start();
    scheduler.start();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(run).toHaveBeenCalledTimes(3); // 0s, 1s, 2s
    await scheduler.stop();
  });

  it('tarefas independentes seguem cada uma o seu intervalo', async () => {
    const fast = vi.fn(async () => undefined);
    const slow = vi.fn(async () => undefined);
    const scheduler = new Scheduler(
      [
        task('fast', 100, fast, { runOnStart: false }),
        task('slow', 1_000, slow, { runOnStart: false }),
      ],
      logger(),
    );
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fast).toHaveBeenCalledTimes(10);
    expect(slow).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });
});

describe('Scheduler: sem sobreposicao', () => {
  it('tarefa mais lenta que o intervalo nunca roda em paralelo consigo mesma', async () => {
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    const slow = async () => {
      runs += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      active -= 1;
    };
    const scheduler = new Scheduler([task('slow', 1_000, slow)], logger());
    scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(maxActive).toBe(1);
    // 5s de execucao + 1s de espera: ~5 ciclos em 30s (e nao 30).
    expect(runs).toBeGreaterThanOrEqual(4);
    expect(runs).toBeLessThanOrEqual(6);
    // stop() espera a execucao em curso: o tempo precisa seguir andando para ela terminar.
    const stopping = scheduler.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    await stopping;
    expect(active).toBe(0);
  });
});

describe('Scheduler: isolamento de falhas', () => {
  it('erro e logado com o nome da tarefa e o laco continua', async () => {
    const log = logger();
    let n = 0;
    const flaky = vi.fn(async () => {
      n += 1;
      if (n <= 2) throw new Error('banco indisponivel');
    });
    const scheduler = new Scheduler([task('flaky', 1_000, flaky)], log);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(flaky).toHaveBeenCalledTimes(4);
    expect(log.error).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'flaky', err: expect.any(Error) }),
      'scheduled_task_failed',
    );
    await scheduler.stop();
  });

  it('uma tarefa que sempre falha nao afeta as outras', async () => {
    const broken = vi.fn(async () => {
      throw new Error('x');
    });
    const healthy = vi.fn(async () => undefined);
    const scheduler = new Scheduler(
      [task('broken', 500, broken), task('healthy', 500, healthy)],
      logger(),
    );
    scheduler.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(healthy).toHaveBeenCalledTimes(5);
    expect(broken).toHaveBeenCalledTimes(5);
    await scheduler.stop();
  });

  it('falha NAO vira unhandledRejection (o processo nao cai)', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => seen.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const scheduler = new Scheduler(
        [
          task('x', 100, async () => {
            throw new Error('boom');
          }),
        ],
        logger(),
      );
      scheduler.start();
      await vi.advanceTimersByTimeAsync(500);
      await scheduler.stop();
      await Promise.resolve();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(seen).toEqual([]);
  });

  it('um logger que lanca nao derruba o processo nem para o laco', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => seen.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const run = vi.fn(async () => {
      throw new Error('x');
    });
    try {
      const scheduler = new Scheduler([task('a', 100, run)], {
        error: () => {
          throw new Error('log quebrado');
        },
      });
      scheduler.start();
      await vi.advanceTimersByTimeAsync(500);
      await scheduler.stop();
      await Promise.resolve();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(seen).toEqual([]);
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(5); // continuou rodando apesar do log quebrado
  });
});

describe('Scheduler: desligamento ordenado', () => {
  it('stop() cancela os proximos ciclos e ESPERA a execucao em andamento', async () => {
    let finished = false;
    const long = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      finished = true;
    });
    const scheduler = new Scheduler([task('long', 1_000, long)], logger());
    scheduler.start();
    await vi.advanceTimersByTimeAsync(500); // em execucao
    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stopped).toBe(false); // ainda esperando a tarefa
    await vi.advanceTimersByTimeAsync(1_000);
    await stopping;
    expect(finished).toBe(true);
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(long).toHaveBeenCalledTimes(1); // nenhum ciclo novo
  });

  it('stop() sem nada rodando cancela o timer pendente', async () => {
    const run = vi.fn(async () => undefined);
    const scheduler = new Scheduler([task('a', 1_000, run, { runOnStart: false })], logger());
    scheduler.start();
    await scheduler.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop() e idempotente e start() depois de stop() nao ressuscita', async () => {
    const run = vi.fn(async () => undefined);
    const scheduler = new Scheduler([task('a', 100, run)], logger());
    scheduler.start();
    await scheduler.stop();
    await scheduler.stop();
    const before = run.mock.calls.length;
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(before);
  });

  it('o timer nao segura o processo vivo (unref)', async () => {
    const unref = vi.fn();
    const timers: Timers = {
      setTimeout: () => ({ unref }),
      clearTimeout: () => undefined,
    };
    const scheduler = new Scheduler([task('a', 1_000, async () => undefined)], logger(), timers);
    scheduler.start();
    expect(unref).toHaveBeenCalled();
    await scheduler.stop();
  });
});

describe('Scheduler: configuracao invalida falha cedo', () => {
  it('nomes duplicados', () => {
    expect(
      () =>
        new Scheduler(
          [task('a', 1, async () => undefined), task('a', 2, async () => undefined)],
          logger(),
        ),
    ).toThrow(/duplicad/);
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])('intervalo invalido (%s)', (everyMs) => {
    expect(() => new Scheduler([task('a', everyMs, async () => undefined)], logger())).toThrow(
      /Intervalo invalido/,
    );
  });
});

describe('settleDueTask', () => {
  const settler = (results: { settled: number; failed: { lotId: string; error: unknown }[] }[]) => {
    const queue = [...results];
    return { settleDue: vi.fn(async () => queue.shift() ?? { settled: 0, failed: [] }) };
  };

  it('uma varredura quando a fila nao enche o lote', async () => {
    const s = settler([{ settled: 3, failed: [] }]);
    await settleDueTask(s, logger(), { batchSize: 50 }).run();
    expect(s.settleDue).toHaveBeenCalledTimes(1);
    expect(s.settleDue).toHaveBeenCalledWith(50);
  });

  it('repete enquanto o lote vem cheio (recupera atraso) e para quando sobra espaco', async () => {
    const s = settler([
      { settled: 50, failed: [] },
      { settled: 50, failed: [] },
      { settled: 7, failed: [] },
    ]);
    await settleDueTask(s, logger(), { batchSize: 50 }).run();
    expect(s.settleDue).toHaveBeenCalledTimes(3);
  });

  it('tem teto de lotes por ciclo (nao monopoliza o banco)', async () => {
    const s = { settleDue: vi.fn(async () => ({ settled: 50, failed: [] })) };
    await settleDueTask(s, logger(), { batchSize: 50, maxBatchesPerRun: 4 }).run();
    expect(s.settleDue).toHaveBeenCalledTimes(4);
  });

  it('falhas contam como "lote cheio", sao logadas por lote e nao viram excecao', async () => {
    const log = logger();
    const boom = new Error('integridade');
    const s = settler([
      {
        settled: 1,
        failed: [
          { lotId: 'a', error: boom },
          { lotId: 'b', error: boom },
        ],
      },
      { settled: 0, failed: [] },
    ]);
    await expect(settleDueTask(s, log, { batchSize: 3 }).run()).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledWith({ lotId: 'a', err: boom }, 'settle_due_lot_failed');
    expect(s.settleDue).toHaveBeenCalledTimes(2);
  });

  it('erro de infraestrutura propaga (o Scheduler registra e tenta no proximo ciclo)', async () => {
    const s = { settleDue: vi.fn(async () => Promise.reject(new Error('db caiu'))) };
    await expect(settleDueTask(s, logger()).run()).rejects.toThrow('db caiu');
  });

  it('padrao: a cada 3s', () => {
    expect(
      settleDueTask({ settleDue: async () => ({ settled: 0, failed: [] }) }, logger()).everyMs,
    ).toBe(3_000);
  });
});

describe('purgeSessionsTask', () => {
  it('delega a limpeza e devolve a contagem', async () => {
    const purger = { purgeExpired: vi.fn(async () => 7) };
    const t = purgeSessionsTask(purger);
    await expect(t.run()).resolves.toBe(7);
    expect(t.everyMs).toBe(10 * 60_000);
    expect(t.name).toBe('purge-expired-sessions');
  });
});

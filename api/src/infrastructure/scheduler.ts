/**
 * Agendador de tarefas periodicas em processo.
 *
 * - Sem sobreposicao: o proximo ciclo so e marcado quando o anterior TERMINA (setTimeout em cadeia,
 *   nao setInterval), entao uma tarefa lenta nunca roda duas vezes ao mesmo tempo.
 * - Isolamento: erro de uma tarefa e logado e o laco continua; nunca derruba o processo nem as outras.
 * - Desligamento ordenado: `stop()` cancela os timers e ESPERA a execucao em andamento.
 *
 * Com varias instancias as tarefas podem rodar em paralelo, e isso e seguro: a liquidacao e
 * idempotente (trava a linha do lote) e a limpeza de sessoes e um DELETE por data.
 */
export interface ScheduledTask {
  readonly name: string;
  readonly everyMs: number;
  /** Roda uma vez ao iniciar (recupera o atraso de quando o servidor esteve fora). Padrao: true. */
  readonly runOnStart?: boolean;
  run(): Promise<unknown>;
}

export interface SchedulerLogger {
  error(data: Record<string, unknown>, message: string): void;
}

interface TimerHandle {
  unref?(): unknown;
}

export interface Timers {
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

const realTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

interface Slot {
  timer: TimerHandle | undefined;
  running: Promise<void> | undefined;
}

export class Scheduler {
  private readonly slots = new Map<string, Slot>();
  private started = false;
  private stopped = false;

  constructor(
    private readonly tasks: readonly ScheduledTask[],
    private readonly logger: SchedulerLogger,
    private readonly timers: Timers = realTimers,
  ) {
    const names = new Set(tasks.map((task) => task.name));
    if (names.size !== tasks.length) throw new Error('Nomes de tarefa duplicados no agendador.');
    for (const task of tasks) {
      if (!Number.isFinite(task.everyMs) || task.everyMs < 1) {
        throw new Error(`Intervalo invalido para a tarefa ${task.name}.`);
      }
    }
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    for (const task of this.tasks) {
      this.slots.set(task.name, { timer: undefined, running: undefined });
      this.schedule(task, task.runOnStart === false ? task.everyMs : 0);
    }
  }

  /** Cancela os proximos ciclos e espera o que estiver rodando terminar. Idempotente. */
  async stop(): Promise<void> {
    this.stopped = true;
    const running: Promise<void>[] = [];
    for (const slot of this.slots.values()) {
      if (slot.timer !== undefined) this.timers.clearTimeout(slot.timer);
      slot.timer = undefined;
      if (slot.running !== undefined) running.push(slot.running);
    }
    await Promise.all(running);
  }

  private schedule(task: ScheduledTask, delayMs: number): void {
    const slot = this.slots.get(task.name);
    if (slot === undefined || this.stopped) return;
    const timer = this.timers.setTimeout(() => {
      slot.timer = undefined;
      slot.running = this.execute(task, slot);
    }, delayMs);
    // O processo nao deve ficar vivo so por causa do agendador (o servidor HTTP o mantem de pe).
    timer.unref?.();
    slot.timer = timer;
  }

  private async execute(task: ScheduledTask, slot: Slot): Promise<void> {
    try {
      await task.run();
    } catch (error) {
      try {
        this.logger.error({ task: task.name, err: error }, 'scheduled_task_failed');
      } catch {
        // Log com defeito nao pode derrubar o processo (rejeicao sem tratamento) nem parar o laco.
      }
    } finally {
      slot.running = undefined;
      this.schedule(task, task.everyMs);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Tarefas do leilao
// ---------------------------------------------------------------------------------------------

export interface DueSettler {
  settleDue(
    limit?: number,
  ): Promise<{ settled: number; failed: { lotId: string; error: unknown }[] }>;
}

export interface SessionPurger {
  purgeExpired(): Promise<number>;
}

/**
 * Liquida os lotes vencidos. Repete em lotes enquanto a fila vier cheia (recupera atraso depois de
 * uma parada longa), com teto por ciclo para nao monopolizar o banco.
 */
export function settleDueTask(
  settler: DueSettler,
  logger: SchedulerLogger,
  options: { everyMs?: number; batchSize?: number; maxBatchesPerRun?: number } = {},
): ScheduledTask {
  const batchSize = options.batchSize ?? 50;
  const maxBatches = options.maxBatchesPerRun ?? 20;
  return {
    name: 'settle-due-lots',
    everyMs: options.everyMs ?? 3_000,
    async run() {
      for (let batch = 0; batch < maxBatches; batch++) {
        const { settled, failed } = await settler.settleDue(batchSize);
        for (const { lotId, error } of failed) {
          // A quarentena do caso de uso garante que cada lote aparece aqui uma vez por periodo.
          logger.error({ lotId, err: error }, 'settle_due_lot_failed');
        }
        if (settled + failed.length < batchSize) return;
      }
    },
  };
}

/** Sessoes vencidas ja nao autenticam (a consulta checa a data); isto so mantem a tabela enxuta. */
export function purgeSessionsTask(
  purger: SessionPurger,
  options: { everyMs?: number } = {},
): ScheduledTask {
  return {
    name: 'purge-expired-sessions',
    everyMs: options.everyMs ?? 10 * 60_000,
    run: () => purger.purgeExpired(),
  };
}

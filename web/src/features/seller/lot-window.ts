/**
 * Janela do lote (inicio e fim) a partir do que o leiloeiro escolheu no formulario.
 * Mesmas regras do servidor (create-lot.ts): inicio nao pode estar no passado (tolerancia de 1 min
 * para "comecar agora"), no maximo 1 ano a frente, duracao de 1 minuto a 30 dias.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const START_SKEW_MS = MINUTE;
export const MIN_DURATION_MS = MINUTE;
export const MAX_DURATION_MS = 30 * DAY;
export const MAX_SCHEDULE_AHEAD_MS = 365 * DAY;

export const DURATIONS = [
  { id: '15m', label: '15 minutos', ms: 15 * MINUTE },
  { id: '1h', label: '1 hora', ms: HOUR },
  { id: '6h', label: '6 horas', ms: 6 * HOUR },
  { id: '24h', label: '24 horas', ms: DAY },
  { id: '3d', label: '3 dias', ms: 3 * DAY },
  { id: '7d', label: '7 dias', ms: 7 * DAY },
  { id: 'custom', label: 'Escolher data de término', ms: 0 },
] as const;

export type DurationId = (typeof DURATIONS)[number]['id'];
export type StartMode = 'now' | 'schedule';

export interface WindowInput {
  startMode: StartMode;
  /** Valor de <input type="datetime-local">: "2026-10-24T10:30" (horario local, sem fuso). */
  startLocal: string;
  duration: DurationId;
  endLocal: string;
  nowMs: number;
}

export interface WindowResult {
  startsAt: string | null;
  endsAt: string | null;
  errors: { start?: string; end?: string };
}

const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** "2026-10-24T10:30" no horario do aparelho -> ms, ou null se invalido. */
export function parseLocalDateTime(value: string): number | null {
  if (!LOCAL_DATETIME.test(value)) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** ms -> valor de <input type="datetime-local"> no horario do aparelho. */
export function toLocalInputValue(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function computeWindow(input: WindowInput): WindowResult {
  const errors: WindowResult['errors'] = {};

  let startMs: number | null;
  if (input.startMode === 'now') {
    startMs = input.nowMs;
  } else {
    startMs = parseLocalDateTime(input.startLocal);
    if (startMs === null) errors.start = 'Informe a data e a hora de início.';
    else if (startMs < input.nowMs - START_SKEW_MS)
      errors.start = 'O início não pode estar no passado.';
    else if (startMs > input.nowMs + MAX_SCHEDULE_AHEAD_MS) {
      errors.start = 'O início não pode estar a mais de 1 ano.';
    }
  }

  let endMs: number | null = null;
  if (input.duration === 'custom') {
    endMs = parseLocalDateTime(input.endLocal);
    if (endMs === null) errors.end = 'Informe a data e a hora de término.';
  } else {
    const preset = DURATIONS.find((d) => d.id === input.duration);
    if (startMs !== null && preset !== undefined) endMs = startMs + preset.ms;
  }

  if (
    startMs !== null &&
    endMs !== null &&
    errors.start === undefined &&
    errors.end === undefined
  ) {
    const duration = endMs - startMs;
    if (duration < MIN_DURATION_MS) errors.end = 'O lote precisa durar pelo menos 1 minuto.';
    else if (duration > MAX_DURATION_MS) errors.end = 'O lote pode durar no máximo 30 dias.';
  }

  const valid = errors.start === undefined && errors.end === undefined;
  return {
    startsAt: valid && startMs !== null ? new Date(startMs).toISOString() : null,
    endsAt: valid && endMs !== null ? new Date(endMs).toISOString() : null,
    errors,
  };
}

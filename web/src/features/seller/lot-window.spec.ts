import { describe, expect, it } from 'vitest';
import { DURATIONS, computeWindow, parseLocalDateTime, toLocalInputValue } from './lot-window';
import type { WindowInput } from './lot-window';

const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const base: WindowInput = {
  startMode: 'now',
  startLocal: '',
  duration: '1h',
  endLocal: '',
  nowMs: NOW,
};

const local = (ms: number) => toLocalInputValue(ms);

describe('computeWindow: comecar agora', () => {
  it('usa a hora do servidor e soma a duracao escolhida', () => {
    const result = computeWindow(base);
    expect(result.errors).toEqual({});
    expect(result.startsAt).toBe(new Date(NOW).toISOString());
    expect(result.endsAt).toBe(new Date(NOW + HOUR).toISOString());
  });

  it.each(DURATIONS.filter((d) => d.id !== 'custom'))('duracao %j soma corretamente', (d) => {
    const result = computeWindow({ ...base, duration: d.id });
    expect(Date.parse(result.endsAt as string) - NOW).toBe(d.ms);
  });
});

describe('computeWindow: agendar', () => {
  it('aceita inicio futuro e calcula o fim a partir dele', () => {
    const start = NOW + 2 * DAY;
    const result = computeWindow({
      ...base,
      startMode: 'schedule',
      startLocal: local(start),
      duration: '24h',
    });
    expect(result.errors).toEqual({});
    // O input so tem precisao de minuto: compara o que foi lido.
    const parsed = parseLocalDateTime(local(start)) as number;
    expect(result.startsAt).toBe(new Date(parsed).toISOString());
    expect(Date.parse(result.endsAt as string) - parsed).toBe(DAY);
  });

  it('recusa inicio vazio, malformado ou no passado', () => {
    expect(computeWindow({ ...base, startMode: 'schedule', startLocal: '' }).errors.start).toMatch(
      /Informe/,
    );
    expect(
      computeWindow({ ...base, startMode: 'schedule', startLocal: 'amanha' }).errors.start,
    ).toMatch(/Informe/);
    const past = computeWindow({
      ...base,
      startMode: 'schedule',
      startLocal: local(NOW - 2 * HOUR),
    });
    expect(past.errors.start).toBe('O início não pode estar no passado.');
    expect(past.startsAt).toBeNull();
    expect(past.endsAt).toBeNull();
  });

  it('recusa inicio a mais de 1 ano', () => {
    const far = computeWindow({
      ...base,
      startMode: 'schedule',
      startLocal: local(NOW + 400 * DAY),
    });
    expect(far.errors.start).toBe('O início não pode estar a mais de 1 ano.');
  });
});

describe('computeWindow: termino personalizado', () => {
  it('aceita fim valido', () => {
    const result = computeWindow({ ...base, duration: 'custom', endLocal: local(NOW + 3 * HOUR) });
    expect(result.errors).toEqual({});
    expect(result.endsAt).not.toBeNull();
  });

  it('recusa fim vazio ou malformado', () => {
    expect(computeWindow({ ...base, duration: 'custom', endLocal: '' }).errors.end).toMatch(
      /Informe/,
    );
    expect(
      computeWindow({ ...base, duration: 'custom', endLocal: '2026-13-45T99:99' }).errors.end,
    ).toMatch(/Informe/);
  });

  it('recusa fim antes do inicio ou com menos de 1 minuto', () => {
    expect(
      computeWindow({ ...base, duration: 'custom', endLocal: local(NOW - HOUR) }).errors.end,
    ).toBe('O lote precisa durar pelo menos 1 minuto.');
    expect(
      computeWindow({ ...base, duration: 'custom', endLocal: local(NOW + 20_000) }).errors.end,
    ).toBe('O lote precisa durar pelo menos 1 minuto.');
  });

  it('recusa duracao acima de 30 dias', () => {
    const result = computeWindow({ ...base, duration: 'custom', endLocal: local(NOW + 31 * DAY) });
    expect(result.errors.end).toBe('O lote pode durar no máximo 30 dias.');
  });

  it('exatamente 30 dias ainda passa', () => {
    const start = parseLocalDateTime(local(NOW + HOUR)) as number;
    const result = computeWindow({
      ...base,
      startMode: 'schedule',
      startLocal: local(start),
      duration: 'custom',
      endLocal: local(start + 30 * DAY),
    });
    expect(result.errors).toEqual({});
  });
});

describe('parseLocalDateTime / toLocalInputValue', () => {
  it('ida e volta no horario do aparelho', () => {
    const value = '2026-10-24T10:30';
    const ms = parseLocalDateTime(value) as number;
    expect(toLocalInputValue(ms)).toBe(value);
  });

  it.each(['', 'x', '2026-10-24', '2026-10-24 10:30', '2026-10-24T10:30:00', '24/10/2026 10:30'])(
    'recusa %j',
    (value) => {
      expect(parseLocalDateTime(value)).toBeNull();
    },
  );
});

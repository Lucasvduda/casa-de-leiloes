import { describe, expect, it } from 'vitest';
import {
  describeRemaining,
  formatCountdown,
  formatDateTime,
  safeHttpUrl,
  shortHash,
} from './format';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('formatCountdown', () => {
  it('mostra HH:MM:SS abaixo de 1 dia', () => {
    expect(formatCountdown(59 * SECOND)).toBe('00:00:59');
    expect(formatCountdown(2 * MINUTE + 5 * SECOND)).toBe('00:02:05');
    expect(formatCountdown(3 * HOUR + 12 * MINUTE + 9 * SECOND)).toBe('03:12:09');
    expect(formatCountdown(23 * HOUR + 59 * MINUTE + 59 * SECOND)).toBe('23:59:59');
  });

  it('a partir de 1 dia mostra dias, horas e minutos', () => {
    expect(formatCountdown(DAY)).toBe('1d 00h 00m');
    // Com dias, os segundos nao aparecem (truncados): 12 min 30 s -> "12m".
    expect(formatCountdown(2 * DAY + 3 * HOUR + 12 * MINUTE + 30 * SECOND)).toBe('2d 03h 12m');
  });

  it('arredonda para cima: so zera quando de fato zerou', () => {
    expect(formatCountdown(1)).toBe('00:00:01');
    expect(formatCountdown(999)).toBe('00:00:01');
    expect(formatCountdown(1000)).toBe('00:00:01');
    expect(formatCountdown(1001)).toBe('00:00:02');
  });

  it('nunca negativo nem NaN', () => {
    expect(formatCountdown(0)).toBe('00:00:00');
    expect(formatCountdown(-5000)).toBe('00:00:00');
    expect(formatCountdown(Number.NaN)).toBe('00:00:00');
    expect(formatCountdown(Number.POSITIVE_INFINITY)).toBe('00:00:00');
  });
});

describe('describeRemaining (leitor de tela)', () => {
  it('fala em portugues com singular e plural', () => {
    expect(describeRemaining(1 * SECOND)).toBe('1 segundo');
    expect(describeRemaining(30 * SECOND)).toBe('30 segundos');
    expect(describeRemaining(1 * MINUTE)).toBe('1 minuto');
    expect(describeRemaining(5 * MINUTE)).toBe('5 minutos');
    expect(describeRemaining(HOUR + 5 * MINUTE)).toBe('1 hora e 5 minutos');
    expect(describeRemaining(2 * DAY + 3 * HOUR)).toBe('2 dias e 3 horas');
  });

  it('encerrado quando acabou', () => {
    expect(describeRemaining(0)).toBe('encerrado');
    expect(describeRemaining(-1)).toBe('encerrado');
  });
});

describe('shortHash', () => {
  it('abrevia hash longo e preserva o curto', () => {
    const hash = 'a'.repeat(20) + 'b'.repeat(44);
    expect(shortHash(hash)).toBe('aaaaaaaa…bbbb');
    expect(shortHash('abc')).toBe('abc');
  });
});

describe('safeHttpUrl', () => {
  it('aceita so http e https', () => {
    expect(safeHttpUrl('https://openaccess-cdn.clevelandart.org/a.jpg')).toBe(
      'https://openaccess-cdn.clevelandart.org/a.jpg',
    );
    expect(safeHttpUrl('http://exemplo.com/x')).toBe('http://exemplo.com/x');
  });

  it.each([
    ['javascript:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['file:///etc/passwd'],
    ['ftp://x.com'],
    ['//sem-protocolo.com'],
    ['not a url'],
    [''],
  ])('recusa %j', (value) => {
    expect(safeHttpUrl(value)).toBeNull();
  });

  it('null e undefined viram null', () => {
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
  });
});

describe('formatDateTime', () => {
  it('data invalida nao quebra a tela', () => {
    expect(formatDateTime('isso nao e data')).toBe('—');
  });
});

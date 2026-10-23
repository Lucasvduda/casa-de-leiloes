import { describe, expect, it } from 'vitest';
import { formatBRL, formatBRLPlain, parseBRLToCents } from './money';

// Espacos do Intl (U+00A0) variam por versao do ICU: compara sem depender deles.
const norm = (text: string) => text.replace(/\s/g, ' ');

describe('formatBRL', () => {
  it('formata centavos inteiros em reais', () => {
    expect(norm(formatBRL(123456))).toBe('R$ 1.234,56');
    expect(norm(formatBRL(0))).toBe('R$ 0,00');
    expect(norm(formatBRL(5))).toBe('R$ 0,05');
    expect(norm(formatBRL(100))).toBe('R$ 1,00');
    expect(norm(formatBRL(1_000_000_00))).toBe('R$ 1.000.000,00');
  });

  it('nunca mostra NaN ou Infinity', () => {
    expect(formatBRL(Number.NaN)).toBe('—');
    expect(formatBRL(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('versao sem simbolo para campos de texto', () => {
    expect(formatBRLPlain(123456)).toBe('1.234,56');
    expect(formatBRLPlain(5000)).toBe('50,00');
  });
});

describe('parseBRLToCents', () => {
  it.each([
    ['1.234,56', 123456],
    ['1234,56', 123456],
    ['R$ 1.234,56', 123456],
    ['r$1.234,56', 123456],
    ['1234', 123400],
    ['50', 5000],
    ['0,01', 1],
    ['0,5', 50],
    ['12,5', 1250],
    ['12.5', 1250],
    ['12.50', 1250],
    ['1.234', 123400], // ponto com 3 digitos = milhar brasileiro
    ['12.345.678', 1_234_567_800],
    ['  75,00  ', 7500],
    ['10\u00A0000,00', 1_000_000],
  ])('aceita %j -> %i centavos', (input, expected) => {
    expect(parseBRLToCents(input)).toBe(expected);
  });

  it.each([
    [''],
    ['   '],
    ['abc'],
    ['0'],
    ['0,00'],
    ['-5'],
    ['-5,00'],
    ['1,234,56'], // duas virgulas
    ['1,234'], // 3 casas decimais
    ['12,345'],
    ['1.23.4'], // pontos mal agrupados
    ['1.2345,00'],
    ['12.345'.concat('x')],
    ['1e3'],
    ['R$'],
    [','],
    ['.'],
    [',50'], // sem parte inteira
    ['99999999999999'], // inteiro grande demais
    ['1.000.000.000.000.000,00'],
  ])('recusa %j', (input) => {
    expect(parseBRLToCents(input)).toBeNull();
  });

  it('nunca produz centavo fracionado nem numero inseguro', () => {
    for (const input of ['0,29', '19,99', '1,15', '4,35', '0,07', '1.000,10']) {
      const value = parseBRLToCents(input);
      expect(Number.isInteger(value)).toBe(true);
    }
    // casos classicos em que 0,29 * 100 em float da 28.999999
    expect(parseBRLToCents('0,29')).toBe(29);
    expect(parseBRLToCents('4,35')).toBe(435);
    expect(parseBRLToCents('1,15')).toBe(115);
  });

  it('ida e volta: formatar e ler devolve o mesmo valor', () => {
    for (const cents of [1, 99, 100, 101, 123456, 99_999_99, 10_000_000_00]) {
      expect(parseBRLToCents(formatBRLPlain(cents))).toBe(cents);
    }
  });
});

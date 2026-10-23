/**
 * Dinheiro no front: SEMPRE inteiro em centavos (igual ao servidor). Nada de ponto flutuante
 * na entrada do usuario: o texto digitado e convertido por aritmetica de string.
 */

/** Espelham os limites do servidor (domain/wallet.ts). O servidor continua sendo a autoridade. */
export const MAX_SINGLE_DEPOSIT_CENTS = 100_000_00;
export const MAX_WALLET_BALANCE_CENTS = 10_000_000_00;

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

/** 123456 -> "R$ 1.234,56". Valor invalido nunca vira "NaN" na tela. */
export function formatBRL(valueInCents: number): string {
  if (!Number.isFinite(valueInCents)) return '—';
  // Centavos inteiros divididos por 100 tem no maximo 2 casas: o Intl arredonda sem erro visivel.
  return brl.format(valueInCents / 100);
}

/** Versao sem simbolo, para campos de texto: 123456 -> "1.234,56". */
export function formatBRLPlain(valueInCents: number): string {
  return formatBRL(valueInCents)
    .replace(/[^\d.,-]/g, '')
    .trim();
}

/**
 * Converte o que a pessoa digitou em centavos, ou `null` se nao for um valor valido (> 0).
 *
 * Aceita "1.234,56", "1234,56", "R$ 1.234,56", "1234", "12.5" e "12,5".
 * Regra do ponto (sem virgula): "1.234" e "12.345.678" sao milhares (padrao brasileiro);
 * "12.5" e "12.50" sao decimais. No maximo 2 casas decimais.
 */
export function parseBRLToCents(input: string): number | null {
  const text = input
    .replace(/R\$/gi, '')
    .replace(/[\s\u00A0]/g, '')
    .trim();
  if (text === '' || !/^[\d.,]+$/.test(text)) return null;

  let whole: string;
  let fraction = '';

  if (text.includes(',')) {
    const parts = text.split(',');
    if (parts.length !== 2) return null;
    const [left = '', right = ''] = parts;
    // Pontos so valem como separador de milhar, bem agrupados (1.234.567).
    if (left.includes('.') && !/^\d{1,3}(\.\d{3})+$/.test(left)) return null;
    whole = left.replaceAll('.', '');
    fraction = right;
  } else if (/^\d{1,3}(\.\d{3})+$/.test(text)) {
    whole = text.replaceAll('.', '');
  } else if (/^\d+\.\d{1,2}$/.test(text)) {
    const [left = '', right = ''] = text.split('.');
    whole = left;
    fraction = right;
  } else if (/^\d+$/.test(text)) {
    whole = text;
  } else {
    return null;
  }

  if (whole === '' || !/^\d+$/.test(whole)) return null;
  if (fraction !== '' && !/^\d{1,2}$/.test(fraction)) return null;

  // Limite de seguranca antes de qualquer conta: bem acima do teto de carteira (R$ 10 milhoes).
  if (whole.length > 12) return null;
  const total = Number(whole) * 100 + Number(fraction.padEnd(2, '0') || '0');
  if (!Number.isSafeInteger(total) || total <= 0) return null;
  return total;
}

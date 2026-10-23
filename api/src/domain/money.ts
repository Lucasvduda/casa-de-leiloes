import { InvalidMoneyError } from './errors.js';

/**
 * Dinheiro e sempre inteiro em centavos. Nunca float: 0.1 + 0.2 !== 0.3.
 * O tipo "brandado" impede passar um number qualquer onde se espera dinheiro validado.
 */
export type Cents = number & { readonly __brand: 'Cents' };

export function cents(value: number): Cents {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidMoneyError(value);
  }
  return value as Cents;
}

export function addCents(a: Cents, b: Cents): Cents {
  return cents(a + b);
}

/** Subtracao que nunca fica negativa: estourar aqui indica bug de regra, nao de entrada. */
export function subCents(a: Cents, b: Cents): Cents {
  return cents(a - b);
}

export const ZERO: Cents = 0 as Cents;

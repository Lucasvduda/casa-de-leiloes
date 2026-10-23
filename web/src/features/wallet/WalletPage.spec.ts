import { describe, expect, it } from 'vitest';
import { MAX_SINGLE_DEPOSIT_CENTS, MAX_WALLET_BALANCE_CENTS } from '../../lib/money';
import { checkDeposit } from './WalletPage';

describe('checkDeposit', () => {
  it('valor valido', () => {
    expect(checkDeposit('500,00', 0)).toEqual({ amount: 50_000, error: undefined });
    expect(checkDeposit('1.500,50', 0)).toEqual({ amount: 150_050, error: undefined });
  });

  it.each(['', '   ', 'abc', '0', '0,00', '-5', '1,234', '10,5,5'])('rejeita %j', (text) => {
    const result = checkDeposit(text, 0);
    expect(result.amount).toBeNull();
    expect(result.error).toMatch(/valor válido/);
  });

  it('limite por deposito: aceita no limite, recusa 1 centavo acima', () => {
    expect(checkDeposit('100.000,00', 0).error).toBeUndefined();
    const over = checkDeposit('100.000,01', 0);
    expect(over.amount).toBe(MAX_SINGLE_DEPOSIT_CENTS + 1);
    expect(over.error).toMatch(/limite por depósito/);
  });

  it('teto da carteira considera o saldo atual', () => {
    const room = MAX_WALLET_BALANCE_CENTS - 50_000;
    expect(checkDeposit('500,00', room).error).toBeUndefined();
    expect(checkDeposit('500,01', room).error).toMatch(/não pode passar/);
  });
});

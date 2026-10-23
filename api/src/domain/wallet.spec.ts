import { describe, expect, it } from 'vitest';
import { WalletInvariantError } from './errors.js';
import { cents } from './money.js';
import {
  MAX_SINGLE_DEPOSIT_CENTS,
  MAX_WALLET_BALANCE_CENTS,
  availableOf,
  credit,
  deposit,
  hold,
  release,
  settleDebit,
} from './wallet.js';
import type { Wallet } from './wallet.js';

const wallet = (total: number, committed = 0): Wallet => ({
  userId: 'u1',
  total: cents(total),
  committed: cents(committed),
});

describe('availableOf', () => {
  it('disponivel = total - comprometido', () => {
    expect(availableOf(wallet(10_000, 3_000))).toBe(7_000);
  });
});

describe('deposit', () => {
  it('soma ao total sem mexer no comprometido', () => {
    expect(deposit(wallet(1_000, 200), cents(500))).toEqual(wallet(1_500, 200));
  });

  it('nao muta a carteira original', () => {
    const w = wallet(1_000);
    deposit(w, cents(500));
    expect(w.total).toBe(1_000);
  });

  it('recusa deposito zero', () => {
    expect(() => deposit(wallet(0), cents(0))).toThrowError(WalletInvariantError);
  });

  it('recusa deposito acima do teto por operacao', () => {
    expect(() => deposit(wallet(0), cents(MAX_SINGLE_DEPOSIT_CENTS + 1))).toThrowError(
      expect.objectContaining({ code: 'DEPOSIT_TOO_LARGE' }),
    );
  });

  it('aceita deposito exatamente no teto por operacao', () => {
    expect(deposit(wallet(0), cents(MAX_SINGLE_DEPOSIT_CENTS)).total).toBe(
      MAX_SINGLE_DEPOSIT_CENTS,
    );
  });

  it('recusa quando o saldo total passaria do teto da carteira', () => {
    expect(() => deposit(wallet(MAX_WALLET_BALANCE_CENTS - 100), cents(101))).toThrowError(
      expect.objectContaining({ code: 'WALLET_LIMIT_EXCEEDED' }),
    );
  });
});

describe('hold (compromete ao liderar)', () => {
  it('reduz o disponivel e aumenta o comprometido', () => {
    const w = hold(wallet(10_000), cents(4_000));
    expect(w.committed).toBe(4_000);
    expect(availableOf(w)).toBe(6_000);
  });

  it('aceita comprometer exatamente o disponivel', () => {
    expect(availableOf(hold(wallet(10_000, 2_000), cents(8_000)))).toBe(0);
  });

  it('recusa comprometer mais que o disponivel', () => {
    expect(() => hold(wallet(10_000, 2_000), cents(8_001))).toThrowError(
      expect.objectContaining({ code: 'INSUFFICIENT_FUNDS' }),
    );
  });
});

describe('release (volta ao disponivel ao ser superado)', () => {
  it('devolve o valor ao disponivel', () => {
    const w = release(wallet(10_000, 4_000), cents(4_000));
    expect(w.committed).toBe(0);
    expect(availableOf(w)).toBe(10_000);
  });

  it('recusa liberar mais do que esta comprometido', () => {
    expect(() => release(wallet(10_000, 100), cents(101))).toThrowError(
      expect.objectContaining({ code: 'RELEASE_EXCEEDS_COMMITTED' }),
    );
  });
});

describe('settleDebit (liquidacao do vencedor)', () => {
  it('baixa total e comprometido pelo mesmo valor', () => {
    const w = settleDebit(wallet(10_000, 4_000), cents(4_000));
    expect(w.total).toBe(6_000);
    expect(w.committed).toBe(0);
  });

  it('recusa debitar mais do que esta comprometido', () => {
    expect(() => settleDebit(wallet(10_000, 3_999), cents(4_000))).toThrowError(
      expect.objectContaining({ code: 'RELEASE_EXCEEDS_COMMITTED' }),
    );
  });
});

describe('credit (leiloeiro recebe)', () => {
  it('soma ao total', () => {
    expect(credit(wallet(0), cents(4_000)).total).toBe(4_000);
  });
});

describe('invariante ao longo de um ciclo completo', () => {
  it('disponivel + comprometido == total em todos os passos', () => {
    const check = (w: Wallet) => expect(availableOf(w) + w.committed).toBe(w.total);
    let w = wallet(0);
    check((w = deposit(w, cents(50_000))));
    check((w = hold(w, cents(20_000))));
    check((w = release(w, cents(20_000))));
    check((w = hold(w, cents(30_000))));
    check((w = settleDebit(w, cents(30_000))));
    expect(w).toEqual(wallet(20_000));
  });
});

import { WalletInvariantError } from './errors.js';
import type { Cents } from './money.js';
import { addCents, subCents } from './money.js';

/** Deposito e simulado: tetos evitam valores absurdos e estouro numerico. */
export const MAX_SINGLE_DEPOSIT_CENTS = 100_000_00; // R$ 100.000,00 por operacao
export const MAX_WALLET_BALANCE_CENTS = 10_000_000_00; // R$ 10.000.000,00 no total

export interface Wallet {
  readonly userId: string;
  readonly total: Cents;
  /** Valor preso nos lotes em que o usuario lidera hoje. */
  readonly committed: Cents;
}

export function availableOf(wallet: Wallet): Cents {
  return subCents(wallet.total, wallet.committed);
}

/** Todas as operacoes devolvem uma nova carteira: nada e mutado, facil de testar e de raciocinar. */
export function deposit(wallet: Wallet, amount: Cents): Wallet {
  if (amount <= 0) {
    throw new WalletInvariantError('INVALID_DEPOSIT', 'O deposito deve ser maior que zero.');
  }
  if (amount > MAX_SINGLE_DEPOSIT_CENTS) {
    throw new WalletInvariantError('DEPOSIT_TOO_LARGE', 'Valor acima do limite por deposito.');
  }
  const total = addCents(wallet.total, amount);
  if (total > MAX_WALLET_BALANCE_CENTS) {
    throw new WalletInvariantError(
      'WALLET_LIMIT_EXCEEDED',
      'Limite de saldo da carteira excedido.',
    );
  }
  return { ...wallet, total };
}

/** Compromete ao liderar. So cabe no disponivel. */
export function hold(wallet: Wallet, amount: Cents): Wallet {
  if (amount > availableOf(wallet)) {
    throw new WalletInvariantError('INSUFFICIENT_FUNDS', 'Saldo disponivel insuficiente.');
  }
  return { ...wallet, committed: addCents(wallet.committed, amount) };
}

/** Libera ao ser superado (ou quando o lote e cancelado). */
export function release(wallet: Wallet, amount: Cents): Wallet {
  if (amount > wallet.committed) {
    throw new WalletInvariantError(
      'RELEASE_EXCEEDS_COMMITTED',
      'Nao ha tanto valor comprometido para liberar.',
    );
  }
  return { ...wallet, committed: subCents(wallet.committed, amount) };
}

/** Liquidacao do vencedor: o valor comprometido vira debito real. */
export function settleDebit(wallet: Wallet, amount: Cents): Wallet {
  if (amount > wallet.committed) {
    throw new WalletInvariantError(
      'RELEASE_EXCEEDS_COMMITTED',
      'Nao ha tanto valor comprometido para debitar.',
    );
  }
  return {
    ...wallet,
    total: subCents(wallet.total, amount),
    committed: subCents(wallet.committed, amount),
  };
}

/** Credito do leiloeiro na liquidacao. */
export function credit(wallet: Wallet, amount: Cents): Wallet {
  return { ...wallet, total: addCents(wallet.total, amount) };
}

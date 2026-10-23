import { availableOf, deposit } from '../../domain/wallet.js';
import type { Wallet } from '../../domain/wallet.js';
import type { Cents } from '../../domain/money.js';
import { ConflictError, ForbiddenError } from '../errors.js';
import type { Actor, UnitOfWork } from '../ports.js';
import { parseAmountCents, parseIdempotencyKey } from '../validation.js';

export interface WalletView {
  readonly total: Cents;
  readonly committed: Cents;
  readonly available: Cents;
}

export interface DepositResult extends WalletView {
  /** true quando a mesma Idempotency-Key ja tinha feito este deposito (nada foi somado de novo). */
  readonly replayed: boolean;
}

export class Deposit {
  constructor(private readonly deps: { uow: UnitOfWork }) {}

  /** Deposito simulado. Idempotente por chave: duplo clique ou retry de rede nao duplica saldo. */
  async execute(
    actor: Actor,
    input: { amount: unknown; idempotencyKey?: unknown },
  ): Promise<DepositResult> {
    if (actor.role !== 'bidder') {
      throw new ForbiddenError('ONLY_BIDDERS_CAN_DEPOSIT', 'Apenas licitantes depositam saldo.');
    }
    const amount = parseAmountCents(input.amount);
    const key = parseIdempotencyKey(input.idempotencyKey);

    return this.deps.uow.run(async (repos) => {
      const wallet = await repos.wallets.lock(actor.id);
      if (key !== null) {
        const previous = await repos.wallets.findLedgerByKey(actor.id, key);
        if (previous !== null) {
          if (previous.kind !== 'deposit' || previous.amount !== amount) {
            throw new ConflictError(
              'IDEMPOTENCY_KEY_REUSED',
              'Esta Idempotency-Key ja foi usada com outro valor.',
            );
          }
          return { ...view(wallet), replayed: true };
        }
      }
      const after = deposit(wallet, amount);
      await repos.wallets.save(after);
      await repos.wallets.appendLedger({
        userId: actor.id,
        kind: 'deposit',
        amount,
        totalAfter: after.total,
        committedAfter: after.committed,
        lotId: null,
        bidId: null,
        idempotencyKey: key,
      });
      return { ...view(after), replayed: false };
    });
  }
}

function view(wallet: Wallet): WalletView {
  return { total: wallet.total, committed: wallet.committed, available: availableOf(wallet) };
}

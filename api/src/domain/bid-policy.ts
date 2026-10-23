import type { LeadingBid, LotState } from './lot.js';
import { lotPhase } from './lot.js';
import type { Cents } from './money.js';
import { addCents } from './money.js';

/** Anti-sniping: lance nos ultimos 2 min leva o fim para (instante do lance + 2 min). */
export const ANTI_SNIPING_WINDOW_MS = 2 * 60 * 1000;
export const ANTI_SNIPING_EXTENSION_MS = 2 * 60 * 1000;

export type BidRejectionReason =
  | 'LOT_CANCELLED'
  | 'LOT_NOT_STARTED'
  | 'LOT_ENDED'
  | 'SELLER_CANNOT_BID'
  | 'ALREADY_LEADING'
  | 'BELOW_MINIMUM'
  | 'INSUFFICIENT_FUNDS';

export interface BidInput {
  readonly lot: LotState;
  readonly now: Date;
  readonly bidderId: string;
  readonly amount: Cents;
  /** Lance lider atual, ou null se o lote ainda nao recebeu lances. */
  readonly leading: LeadingBid | null;
  /** Saldo total menos comprometido do licitante, lido dentro da mesma transacao. */
  readonly availableBalance: Cents;
}

export type BidDecision =
  | { readonly accepted: true; readonly newEndsAt: Date; readonly extended: boolean }
  | {
      readonly accepted: false;
      readonly reason: BidRejectionReason;
      readonly minimumRequired?: Cents;
      readonly available?: Cents;
    };

/** Menor lance valido hoje: o inicial no primeiro lance, depois atual + incremento. */
export function minimumAcceptableBid(lot: LotState, leading: LeadingBid | null): Cents {
  return leading === null ? lot.startingBid : addCents(leading.amount, lot.minIncrement);
}

/**
 * Funcao pura: decide se um lance e aceito, sem tocar em banco, relogio ou rede.
 * A ordem das verificacoes define qual mensagem o usuario recebe quando varias falham:
 * janela do lote, papel, lider, valor minimo e por ultimo saldo.
 */
export function evaluateBid(input: BidInput): BidDecision {
  const { lot, now, bidderId, amount, leading, availableBalance } = input;

  const phase = lotPhase(lot, now);
  if (phase === 'cancelled') return { accepted: false, reason: 'LOT_CANCELLED' };
  if (phase === 'scheduled') return { accepted: false, reason: 'LOT_NOT_STARTED' };
  if (phase === 'ended' || phase === 'closed') return { accepted: false, reason: 'LOT_ENDED' };

  if (bidderId === lot.sellerId) return { accepted: false, reason: 'SELLER_CANNOT_BID' };
  if (leading !== null && leading.bidderId === bidderId) {
    return { accepted: false, reason: 'ALREADY_LEADING' };
  }

  const minimumRequired = minimumAcceptableBid(lot, leading);
  if (amount < minimumRequired) {
    return { accepted: false, reason: 'BELOW_MINIMUM', minimumRequired };
  }

  if (amount > availableBalance) {
    return { accepted: false, reason: 'INSUFFICIENT_FUNDS', available: availableBalance };
  }

  const remainingMs = lot.endsAt.getTime() - now.getTime();
  if (remainingMs <= ANTI_SNIPING_WINDOW_MS) {
    const extendedEnd = new Date(now.getTime() + ANTI_SNIPING_EXTENSION_MS);
    if (extendedEnd.getTime() > lot.endsAt.getTime()) {
      return { accepted: true, newEndsAt: extendedEnd, extended: true };
    }
  }
  return { accepted: true, newEndsAt: lot.endsAt, extended: false };
}

import type { Cents } from './money.js';

/** Estado persistido do lote. Agendado/ao vivo/encerrado sao derivados do relogio (`lotPhase`). */
export type LotStatus = 'open' | 'closed' | 'cancelled';

/** O que a vitrine e a sala mostram. `ended` = passou do fim, liquidacao ainda nao rodou. */
export type LotPhase = 'scheduled' | 'live' | 'ended' | 'closed' | 'cancelled';

export interface LotState {
  readonly id: string;
  readonly sellerId: string;
  readonly startingBid: Cents;
  readonly minIncrement: Cents;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly status: LotStatus;
}

export interface LeadingBid {
  readonly bidderId: string;
  readonly amount: Cents;
}

/**
 * Fases por intervalo semiaberto: ao vivo em [startsAt, endsAt).
 * No instante exato do fim o lote ja nao aceita lances.
 */
export function lotPhase(lot: LotState, now: Date): LotPhase {
  if (lot.status === 'cancelled') return 'cancelled';
  if (lot.status === 'closed') return 'closed';
  const t = now.getTime();
  if (t < lot.startsAt.getTime()) return 'scheduled';
  if (t < lot.endsAt.getTime()) return 'live';
  return 'ended';
}

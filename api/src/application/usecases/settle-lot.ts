import { verifyChain } from '../../domain/hash-chain.js';
import type { Mac } from '../../domain/hash-chain.js';
import { credit, settleDebit } from '../../domain/wallet.js';
import { computeReceiptSignature } from '../../domain/receipt.js';
import { IntegrityError, NotFoundError } from '../errors.js';
import { assertLotId } from '../validation.js';
import { lotTermsOf } from '../integrity.js';
import type {
  Clock,
  EventPublisher,
  IdGenerator,
  LotRecord,
  Repositories,
  StoredReceipt,
  UnitOfWork,
} from '../ports.js';

export type SettleOutcome =
  | { readonly kind: 'not_due' }
  | { readonly kind: 'already_final'; readonly status: 'closed' | 'cancelled' }
  | { readonly kind: 'closed_no_winner' }
  | { readonly kind: 'sold'; readonly receipt: StoredReceipt };

export interface SettleDeps {
  readonly mac: Mac;
  readonly ids: IdGenerator;
}

/**
 * Liquida um lote que ja passou do fim. PRECONDICAO: o lote foi lido com `lockById` na mesma
 * transacao, esta `open` e `now >= endsAt`. Reaproveitada por quem encontrar o lote vencido
 * (agendador, lance tardio, leitura), entao o resultado e correto mesmo se o processo dormiu.
 *
 * Antes de mexer em dinheiro, REFAZ a cadeia inteira: se o historico foi adulterado,
 * recusa liquidar (IntegrityError) em vez de pagar em cima de dado suspeito.
 */
export async function settleLocked(
  repos: Repositories,
  deps: SettleDeps,
  lot: LotRecord,
  now: Date,
): Promise<SettleOutcome> {
  if (lot.bidCount === 0) {
    await repos.lots.markClosed(lot.id, now);
    return { kind: 'closed_no_winner' };
  }

  const bids = await repos.bids.listByLot(lot.id);
  const verification = verifyChain(deps.mac, lotTermsOf(lot), bids, lot.seal);
  if (!verification.intact) {
    throw new IntegrityError('Historico de lances adulterado: liquidacao recusada.');
  }

  const winnerId = lot.leaderId;
  const amount = lot.currentAmount;
  if (winnerId === null || amount === null) {
    throw new IntegrityError('Lote com lances mas sem lider: estado inconsistente.');
  }

  if (winnerId === lot.sellerId) {
    throw new IntegrityError('Leiloeiro nao pode ser o vencedor do proprio lote.');
  }

  // Ordem fixa de lock (id crescente) evita deadlock com outros fluxos que travam carteiras.
  const [firstId, secondId] = [winnerId, lot.sellerId].sort() as [string, string];
  const first = await repos.wallets.lock(firstId);
  const second = await repos.wallets.lock(secondId);
  const winnerWallet = first.userId === winnerId ? first : second;
  const sellerWallet = first.userId === lot.sellerId ? first : second;

  const winnerAfter = settleDebit(winnerWallet, amount);
  const sellerAfter = credit(sellerWallet, amount);
  await repos.wallets.save(winnerAfter);
  await repos.wallets.save(sellerAfter);
  await repos.wallets.appendLedger({
    userId: winnerId,
    kind: 'settle_debit',
    amount,
    totalAfter: winnerAfter.total,
    committedAfter: winnerAfter.committed,
    lotId: lot.id,
    bidId: null,
    idempotencyKey: null,
  });
  await repos.wallets.appendLedger({
    userId: lot.sellerId,
    kind: 'settle_credit',
    amount,
    totalAfter: sellerAfter.total,
    committedAfter: sellerAfter.committed,
    lotId: lot.id,
    bidId: null,
    idempotencyKey: null,
  });

  const facts = {
    code: deps.ids.receiptCode(),
    lotId: lot.id,
    sellerId: lot.sellerId,
    winnerId,
    amount,
    bidCount: lot.bidCount,
    finalHeadHash: lot.seal.headHash,
    issuedAt: now,
  };
  const receipt: StoredReceipt = { ...facts, signature: computeReceiptSignature(deps.mac, facts) };
  await repos.receipts.insert(receipt);
  await repos.lots.markClosed(lot.id, now);
  return { kind: 'sold', receipt };
}

/** Liquidacao idempotente de um lote: chamar N vezes tem o mesmo efeito de chamar 1. */
const DEFAULT_COOLDOWN_MS = 5 * 60_000;
/** Teto da lista em memoria: se tudo falhar ao mesmo tempo, volta a tentar em vez de crescer sem fim. */
const MAX_QUARANTINED = 1_000;

export class SettleLot {
  /** lotId -> instante (ms) em que volta a ser elegivel. Em memoria: reiniciar o processo zera. */
  private readonly quarantine = new Map<string, number>();

  constructor(
    private readonly deps: {
      uow: UnitOfWork;
      clock: Clock;
      events: EventPublisher;
      failureCooldownMs?: number;
      /** Teto da quarentena em memoria (padrao 1000). */
      maxQuarantined?: number;
    } & SettleDeps,
  ) {}

  async execute(rawLotId: string): Promise<SettleOutcome> {
    const lotId = assertLotId(rawLotId);
    const outcome = await this.deps.uow.run(async (repos) => {
      const lot = await repos.lots.lockById(lotId);
      if (lot === null) throw new NotFoundError('LOT_NOT_FOUND', 'Lote nao encontrado.');
      if (lot.status !== 'open') return { kind: 'already_final', status: lot.status } as const;
      const now = this.deps.clock.now();
      if (now.getTime() < lot.endsAt.getTime()) return { kind: 'not_due' } as const;
      return settleLocked(repos, this.deps, lot, now);
    });

    if (outcome.kind === 'sold' || outcome.kind === 'closed_no_winner') {
      this.deps.events.publish({ type: 'lot_closed', lotId, sold: outcome.kind === 'sold' });
    }
    return outcome;
  }

  /**
   * Varredura do agendador: liquida todo lote vencido, isolando falha por lote.
   *
   * Lote que FALHOU (ex.: historico adulterado) entra em quarentena por `failureCooldownMs`: nao e
   * reprocessado nem logado a cada varredura, e nao ocupa a fila do lote de `limit` (um punhado de
   * lotes envenenados nao pode atrasar a liquidacao dos demais). Passada a quarentena, tenta de novo.
   */
  async settleDue(
    limit = 50,
  ): Promise<{ settled: number; failed: { lotId: string; error: unknown }[] }> {
    const now = this.deps.clock.now();
    const nowMs = now.getTime();
    for (const [lotId, retryAt] of this.quarantine) {
      if (retryAt <= nowMs) this.quarantine.delete(lotId);
    }
    const candidates = await this.deps.uow.run((repos) =>
      repos.lots.findDueIds(now, limit + this.quarantine.size),
    );
    const ids = candidates.filter((id) => !this.quarantine.has(id)).slice(0, limit);
    let settled = 0;
    const failed: { lotId: string; error: unknown }[] = [];
    for (const lotId of ids) {
      try {
        const out = await this.execute(lotId);
        if (out.kind === 'sold' || out.kind === 'closed_no_winner') settled += 1;
      } catch (error) {
        failed.push({ lotId, error });
        if (this.quarantine.size < (this.deps.maxQuarantined ?? MAX_QUARANTINED)) {
          this.quarantine.set(lotId, nowMs + (this.deps.failureCooldownMs ?? DEFAULT_COOLDOWN_MS));
        }
      }
    }
    return { settled, failed };
  }
}

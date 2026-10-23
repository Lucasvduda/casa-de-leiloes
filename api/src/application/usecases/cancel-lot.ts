import type { Mac } from '../../domain/hash-chain.js';
import { release } from '../../domain/wallet.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../errors.js';
import type { Actor, Clock, EventPublisher, IdGenerator, UnitOfWork } from '../ports.js';
import { assertLotId } from '../validation.js';
import { settleLocked } from './settle-lot.js';

export type CancelResult =
  | { readonly cancelled: true; readonly refunded: boolean }
  | { readonly cancelled: false; readonly reason: 'LOT_ENDED' };

export class CancelLot {
  constructor(
    private readonly deps: {
      uow: UnitOfWork;
      clock: Clock;
      mac: Mac;
      ids: IdGenerator;
      events: EventPublisher;
    },
  ) {}

  /**
   * Cancela um lote do proprio leiloeiro. Se ja houver lider, o valor comprometido dele e
   * estornado automaticamente (volta ao disponivel) na mesma transacao.
   * Lote que ja passou do fim nao pode mais ser cancelado: e liquidado.
   */
  async execute(actor: Actor, rawLotId: string): Promise<CancelResult> {
    const lotId = assertLotId(rawLotId);
    const { uow, clock, mac, ids } = this.deps;

    const outcome = await uow.run(async (repos) => {
      const lot = await repos.lots.lockById(lotId);
      if (lot === null) throw new NotFoundError('LOT_NOT_FOUND', 'Lote nao encontrado.');
      if (lot.sellerId !== actor.id) {
        // 404 e nao 403: nao confirmamos a existencia de lote alheio para quem nao e o dono.
        throw new NotFoundError('LOT_NOT_FOUND', 'Lote nao encontrado.');
      }
      if (actor.role !== 'seller') {
        throw new ForbiddenError('ONLY_SELLERS_CAN_CANCEL', 'Apenas leiloeiros cancelam lotes.');
      }
      if (lot.status === 'cancelled') {
        throw new ConflictError('LOT_ALREADY_CANCELLED', 'O lote ja foi cancelado.');
      }
      if (lot.status === 'closed') {
        throw new ConflictError('LOT_ALREADY_CLOSED', 'O lote ja foi encerrado.');
      }

      const now = clock.now();
      if (now.getTime() >= lot.endsAt.getTime()) {
        const settled = await settleLocked(repos, { mac, ids }, lot, now);
        return { kind: 'ended' as const, sold: settled.kind === 'sold' };
      }

      let refunded = false;
      if (lot.leaderId !== null && lot.currentAmount !== null) {
        const wallet = await repos.wallets.lock(lot.leaderId);
        const released = release(wallet, lot.currentAmount);
        await repos.wallets.save(released);
        await repos.wallets.appendLedger({
          userId: lot.leaderId,
          kind: 'release',
          amount: lot.currentAmount,
          totalAfter: released.total,
          committedAfter: released.committed,
          lotId: lot.id,
          bidId: null,
          idempotencyKey: null,
        });
        refunded = true;
      }
      await repos.lots.markCancelled(lot.id, now);
      return { kind: 'cancelled' as const, refunded };
    });

    if (outcome.kind === 'ended') {
      this.deps.events.publish({ type: 'lot_closed', lotId, sold: outcome.sold });
      return { cancelled: false, reason: 'LOT_ENDED' };
    }
    this.deps.events.publish({ type: 'lot_cancelled', lotId });
    return { cancelled: true, refunded: outcome.refunded };
  }
}

import { evaluateBid } from '../../domain/bid-policy.js';
import type { BidRejectionReason } from '../../domain/bid-policy.js';
import { appendBid, sealFor } from '../../domain/hash-chain.js';
import type { Mac } from '../../domain/hash-chain.js';
import type { Cents } from '../../domain/money.js';
import { availableOf, hold, release } from '../../domain/wallet.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { assertSealedHead, lotTermsOf } from '../integrity.js';
import type { Actor, Clock, EventPublisher, IdGenerator, StoredBid, UnitOfWork } from '../ports.js';
import { assertLotId, parseAmountCents, parseIdempotencyKey } from '../validation.js';
import { settleLocked } from './settle-lot.js';

export interface PlaceBidCommand {
  readonly actor: Actor;
  readonly lotId: string;
  readonly amount: unknown;
  readonly idempotencyKey?: unknown;
}

export type PlaceBidResult =
  | {
      readonly accepted: true;
      /** true quando a mesma Idempotency-Key ja tinha criado este lance (nada novo foi gravado). */
      readonly replayed: boolean;
      readonly bid: { id: string; seq: number; amount: Cents; placedAt: Date; hash: string };
      readonly endsAt: Date;
      readonly extended: boolean;
      readonly bidCount: number;
    }
  | {
      readonly accepted: false;
      readonly reason: BidRejectionReason;
      readonly minimumRequired?: Cents;
      readonly available?: Cents;
    };

type PublishedEvent = Parameters<EventPublisher['publish']>[0];

type TxOutcome =
  | { kind: 'rejected'; result: Extract<PlaceBidResult, { accepted: false }> }
  /** O lote ja tinha vencido: foi liquidado agora e o lance e recusado como LOT_ENDED. */
  | { kind: 'settled_late'; event: PublishedEvent }
  | {
      kind: 'accepted';
      result: Extract<PlaceBidResult, { accepted: true }>;
      event?: PublishedEvent;
    };

export class PlaceBid {
  constructor(
    private readonly deps: {
      uow: UnitOfWork;
      clock: Clock;
      mac: Mac;
      ids: IdGenerator;
      events: EventPublisher;
    },
  ) {}

  async execute(cmd: PlaceBidCommand): Promise<PlaceBidResult> {
    const lotId = assertLotId(cmd.lotId);
    const amount = parseAmountCents(cmd.amount);
    const idempotencyKey = parseIdempotencyKey(cmd.idempotencyKey);
    const { actor } = cmd;

    // Leiloeiro nunca da lance (em nenhum lote, nao so no proprio).
    if (actor.role !== 'bidder') return { accepted: false, reason: 'SELLER_CANNOT_BID' };

    const { uow, clock, mac, ids } = this.deps;

    const outcome = await uow.run(async (repos): Promise<TxOutcome> => {
      // 1) Trava o lote: a partir daqui todo lance deste lote e processado um por vez.
      const lot = await repos.lots.lockById(lotId);
      if (lot === null) throw new NotFoundError('LOT_NOT_FOUND', 'Lote nao encontrado.');

      // O relogio e lido DEPOIS do lock: assim a ordem dos instantes acompanha a ordem do `seq`.
      const now = clock.now();

      // 2) Idempotencia (apos o lock, entao duas requisicoes com a mesma chave serializam).
      if (idempotencyKey !== null) {
        const previous = await repos.bids.findByIdempotencyKey(actor.id, idempotencyKey);
        if (previous !== null) {
          if (previous.lotId !== lot.id || previous.amount !== amount) {
            throw new ConflictError(
              'IDEMPOTENCY_KEY_REUSED',
              'Esta Idempotency-Key ja foi usada com outro lote ou valor.',
            );
          }
          return {
            kind: 'accepted',
            result: {
              accepted: true,
              replayed: true,
              bid: toView(previous),
              endsAt: lot.endsAt,
              extended: false,
              bidCount: lot.bidCount,
            },
          };
        }
      }

      // 3) Lote vencido mas ainda aberto: liquida agora (leitura preguicosa) e recusa o lance.
      if (lot.status === 'open' && now.getTime() >= lot.endsAt.getTime()) {
        const settled = await settleLocked(repos, { mac, ids }, lot, now);
        return {
          kind: 'settled_late',
          event: { type: 'lot_closed', lotId: lot.id, sold: settled.kind === 'sold' },
        };
      }

      // 4) Nao empilha lance sobre historico adulterado.
      const last = await repos.bids.last(lot.id);
      assertSealedHead(mac, lot, last);

      const leading =
        lot.leaderId !== null && lot.currentAmount !== null
          ? { bidderId: lot.leaderId, amount: lot.currentAmount }
          : null;

      // 5) Trava as carteiras envolvidas em ordem fixa (id crescente): sem deadlock.
      const walletIds = [...new Set([actor.id, ...(leading ? [leading.bidderId] : [])])].sort();
      const wallets = new Map<string, Awaited<ReturnType<typeof repos.wallets.lock>>>();
      for (const id of walletIds) wallets.set(id, await repos.wallets.lock(id));
      const bidderWallet = wallets.get(actor.id);
      if (bidderWallet === undefined) throw new Error('carteira do licitante nao foi carregada');

      // 6) Decisao pura do dominio.
      const decision = evaluateBid({
        lot,
        now,
        bidderId: actor.id,
        amount,
        leading,
        availableBalance: availableOf(bidderWallet),
      });
      if (!decision.accepted) {
        return {
          kind: 'rejected',
          result: {
            accepted: false,
            reason: decision.reason,
            ...(decision.minimumRequired !== undefined
              ? { minimumRequired: decision.minimumRequired }
              : {}),
            ...(decision.available !== undefined ? { available: decision.available } : {}),
          },
        };
      }

      // 7) Novo elo da cadeia + selo do lote.
      const terms = lotTermsOf(lot);
      const chained = appendBid(mac, terms, last, { bidderId: actor.id, amount, placedAt: now });
      const stored: StoredBid = {
        ...chained,
        id: ids.uuid(),
        lotId: lot.id,
        idempotencyKey,
      };
      const seal = sealFor(mac, terms, chained);
      await repos.bids.insert(stored);

      // 8) Carteiras: libera o lider anterior e compromete o novo lider, na mesma transacao.
      if (leading !== null) {
        const previousWallet = wallets.get(leading.bidderId);
        if (previousWallet === undefined) throw new Error('carteira do lider nao foi carregada');
        const released = release(previousWallet, leading.amount);
        await repos.wallets.save(released);
        await repos.wallets.appendLedger({
          userId: leading.bidderId,
          kind: 'release',
          amount: leading.amount,
          totalAfter: released.total,
          committedAfter: released.committed,
          lotId: lot.id,
          bidId: null,
          idempotencyKey: null,
        });
      }
      const held = hold(bidderWallet, amount);
      await repos.wallets.save(held);
      await repos.wallets.appendLedger({
        userId: actor.id,
        kind: 'hold',
        amount,
        totalAfter: held.total,
        committedAfter: held.committed,
        lotId: lot.id,
        bidId: stored.id,
        idempotencyKey: null,
      });

      // 9) Lote: novo lider, valor, selo e (se for o caso) novo fim por anti-sniping.
      const bidCount = lot.bidCount + 1;
      await repos.lots.applyBid({
        lotId: lot.id,
        currentAmount: amount,
        leaderId: actor.id,
        bidCount,
        seal,
        endsAt: decision.newEndsAt,
        extensionCount: lot.extensionCount + (decision.extended ? 1 : 0),
      });

      return {
        kind: 'accepted',
        result: {
          accepted: true,
          replayed: false,
          bid: toView(stored),
          endsAt: decision.newEndsAt,
          extended: decision.extended,
          bidCount,
        },
        event: {
          type: 'bid_placed',
          lotId: lot.id,
          seq: stored.seq,
          amount,
          bidderId: actor.id,
          previousLeaderId: leading?.bidderId ?? null,
          placedAt: now,
          endsAt: decision.newEndsAt,
          extended: decision.extended,
          bidCount,
        },
      };
    });

    // Publica so depois do COMMIT: nenhum cliente ve um lance que depois sofreria rollback.
    switch (outcome.kind) {
      case 'settled_late':
        this.deps.events.publish(outcome.event);
        return { accepted: false, reason: 'LOT_ENDED' };
      case 'accepted':
        if (outcome.event !== undefined) this.deps.events.publish(outcome.event);
        return outcome.result;
      case 'rejected':
        return outcome.result;
    }
  }
}

function toView(bid: StoredBid) {
  return { id: bid.id, seq: bid.seq, amount: bid.amount, placedAt: bid.placedAt, hash: bid.hash };
}

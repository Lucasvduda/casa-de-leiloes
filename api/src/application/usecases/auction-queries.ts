import { z } from 'zod';
import { minimumAcceptableBid } from '../../domain/bid-policy.js';
import type { Mac } from '../../domain/hash-chain.js';
import { lotPhase } from '../../domain/lot.js';
import type { LotPhase, LotStatus } from '../../domain/lot.js';
import type { Cents } from '../../domain/money.js';
import { cents, subCents } from '../../domain/money.js';
import { publicBidderRef } from '../../domain/public-bidder-ref.js';
import { verifyReceiptSignature } from '../../domain/receipt.js';
import { IntegrityError, NotFoundError } from '../errors.js';
import type {
  Actor,
  AuctionReadModel,
  Clock,
  ItemSnapshot,
  LedgerView,
  LotListQuery,
  LotListRow,
  LotRecord,
  StoredBid,
  StoredReceipt,
  UnitOfWork,
} from '../ports.js';
import { assertLotId, parseWith } from '../validation.js';
import type { SettleLot } from './settle-lot.js';

/** Quantos lances recentes a sala mostra. O historico COMPLETO e verificavel na auditoria. */
const RECENT_BIDS_IN_ROOM = 50;
const RECEIPT_CODE = /^[A-Za-z0-9_-]{16,64}$/;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

const searchText = z
  .string()
  .transform((s) => s.replace(CONTROL_CHARS, ' ').trim())
  .pipe(z.string().max(100))
  .transform((s) => (s === '' ? null : s))
  .optional()
  .transform((s) => s ?? null);

const listQuerySchema = z.object({
  phase: z.enum(['live', 'scheduled', 'finished', 'cancelled', 'all']).optional(),
  q: searchText,
  sort: z.enum(['ending', 'newest', 'price_asc', 'price_desc']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(12),
});

const ledgerQuerySchema = z.object({
  before: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export interface ViewerFlags {
  readonly isSeller: boolean;
  readonly isLeading: boolean;
}

export interface LotSummaryDto {
  readonly id: string;
  readonly title: string;
  readonly imageUrl: string | null;
  readonly startingBid: Cents;
  readonly minIncrement: Cents;
  readonly currentAmount: Cents | null;
  /** Menor lance aceito agora (inicial no primeiro lance, depois atual + incremento). */
  readonly minimumNextBid: Cents;
  readonly bidCount: number;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly status: LotStatus;
  readonly phase: LotPhase;
  readonly sellerName: string;
  readonly receiptCode: string | null;
  readonly viewer: ViewerFlags | null;
}

export interface Paged<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
  /** Relogio do servidor: os cards calculam a contagem regressiva pelo deslocamento, nao pelo relogio do navegador. */
  readonly serverNow: Date;
}

export interface PublicBidDto {
  readonly seq: number;
  /** Referencia anonima por lote. Nunca nome, e-mail ou id interno. */
  readonly bidder: string;
  /** true quando o lance e de quem esta vendo (a pessoa logada). */
  readonly mine: boolean;
  readonly amount: Cents;
  readonly placedAt: Date;
}

export interface LotDetailDto extends LotSummaryDto {
  readonly item: ItemSnapshot;
  readonly bids: readonly PublicBidDto[];
  /** Hora do servidor: o relogio da sala usa a diferenca, nao o relogio do aparelho. */
  readonly serverNow: Date;
  readonly result:
    | {
        readonly outcome: 'sold';
        readonly amount: Cents;
        readonly winner: string;
        readonly receiptCode: string;
      }
    | { readonly outcome: 'no_winner' }
    | { readonly outcome: 'cancelled' }
    | null;
  readonly viewerDetail: {
    /** Como esta pessoa aparece nos lances deste lote (para marcar "voce" nos eventos em tempo real). */
    readonly ref: string;
  } | null;
}

export interface WalletDto {
  readonly total: Cents;
  readonly committed: Cents;
  readonly available: Cents;
  readonly ledger: readonly LedgerView[];
  readonly nextCursor: number | null;
}

export interface ReceiptDto {
  readonly code: string;
  readonly lot: { readonly id: string; readonly title: string; readonly imageUrl: string | null };
  readonly amount: Cents;
  readonly bidCount: number;
  readonly issuedAt: Date;
  readonly sellerName: string;
  readonly winner: string;
  readonly signatureValid: boolean;
}

export interface AuctionQueriesDeps {
  readonly uow: UnitOfWork;
  readonly readModel: AuctionReadModel;
  readonly clock: Clock;
  readonly mac: Mac;
  readonly settle: SettleLot;
}

export class AuctionQueries {
  constructor(private readonly deps: AuctionQueriesDeps) {}

  /** Vitrine publica. Se houver sessao, cada card informa se a pessoa esta liderando. */
  listLots(viewer: Actor | null, rawQuery: unknown): Promise<Paged<LotSummaryDto>> {
    const q = parseWith(listQuerySchema, rawQuery);
    const phase = q.phase ?? 'live';
    return this.list(viewer, {
      phase,
      search: q.q,
      sort: q.sort ?? (phase === 'live' || phase === 'scheduled' ? 'ending' : 'newest'),
      page: q.page,
      pageSize: q.pageSize,
    });
  }

  /** Painel do leiloeiro: todos os lotes dele, com o resultado de cada um e o total recebido. */
  async myLots(
    actor: Actor,
    rawQuery: unknown,
  ): Promise<Paged<LotSummaryDto> & { totals: { received: Cents; soldCount: number } }> {
    const q = parseWith(listQuerySchema, rawQuery);
    const [page, totals] = await Promise.all([
      this.list(actor, {
        phase: q.phase ?? 'all',
        search: q.q,
        sort: q.sort ?? 'newest',
        page: q.page,
        pageSize: q.pageSize,
        sellerId: actor.id,
      }),
      this.deps.readModel.sellerTotals(actor.id),
    ]);
    return { ...page, totals };
  }

  /** Lotes em que a pessoa deu lance (lider ou nao). */
  myBids(actor: Actor, rawQuery: unknown): Promise<Paged<LotSummaryDto>> {
    const q = parseWith(listQuerySchema, rawQuery);
    return this.list(actor, {
      phase: q.phase ?? 'all',
      search: q.q,
      sort: q.sort ?? 'newest',
      page: q.page,
      pageSize: q.pageSize,
      bidderId: actor.id,
    });
  }

  /** Arremates da pessoa, com o codigo do comprovante. */
  myWins(actor: Actor, rawQuery: unknown): Promise<Paged<LotSummaryDto>> {
    const q = parseWith(listQuerySchema, rawQuery);
    return this.list(actor, {
      phase: 'all',
      search: q.q,
      sort: 'newest',
      page: q.page,
      pageSize: q.pageSize,
      wonBy: actor.id,
    });
  }

  async wallet(actor: Actor, rawQuery: unknown): Promise<WalletDto> {
    const q = parseWith(ledgerQuerySchema, rawQuery);
    const { readModel } = this.deps;
    const [summary, rows] = await Promise.all([
      readModel.walletSummary(actor.id),
      readModel.ledger(actor.id, q.limit + 1, q.before ?? null),
    ]);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      total: summary.total,
      committed: summary.committed,
      available: subCents(summary.total, summary.committed),
      ledger: page,
      nextCursor: rows.length > q.limit && last !== undefined ? last.id : null,
    };
  }

  /** Sala do lote. Lote vencido e liquidado na hora (nao depende do agendador estar de pe). */
  async getLot(viewer: Actor | null, rawLotId: unknown): Promise<LotDetailDto> {
    const lotId = assertLotId(rawLotId);
    let snapshot = await this.loadRoom(lotId);

    const now = this.deps.clock.now();
    if (snapshot.lot.status === 'open' && now.getTime() >= snapshot.lot.endsAt.getTime()) {
      try {
        await this.deps.settle.execute(lotId);
      } catch (error) {
        // Historico adulterado: a liquidacao se recusa, mas a sala continua visivel (e a auditoria
        // publica mostra o problema). Qualquer outro erro e real e sobe.
        if (!(error instanceof IntegrityError)) throw error;
      }
      snapshot = await this.loadRoom(lotId);
    }

    const { lot, sellerName, bids, receipt } = snapshot;
    const { mac } = this.deps;
    const serverNow = this.deps.clock.now();
    const recent = [...bids]
      .sort((a, b) => b.seq - a.seq)
      .slice(0, RECENT_BIDS_IN_ROOM)
      .map((bid): PublicBidDto => ({
        seq: bid.seq,
        bidder: publicBidderRef(mac, bid.bidderId, lot.id),
        mine: viewer !== null && bid.bidderId === viewer.id,
        amount: bid.amount,
        placedAt: bid.placedAt,
      }));

    return {
      ...this.toSummary(lot, sellerName, receipt?.code ?? null, viewer, serverNow),
      item: lot.item,
      bids: recent,
      serverNow,
      result: this.resultOf(lot, receipt),
      viewerDetail: viewer === null ? null : { ref: publicBidderRef(mac, viewer.id, lot.id) },
    };
  }

  /** Comprovante publico: o codigo (128 bits) e o segredo do link. Nao revela ninguem. */
  async receipt(rawCode: unknown): Promise<ReceiptDto> {
    const notFound = () => new NotFoundError('RECEIPT_NOT_FOUND', 'Comprovante nao encontrado.');
    if (typeof rawCode !== 'string' || !RECEIPT_CODE.test(rawCode)) throw notFound();

    const found = await this.deps.uow.readSnapshot(async (repos) => {
      const receipt = await repos.receipts.findByCode(rawCode);
      if (receipt === null) return null;
      const lot = await repos.lots.findById(receipt.lotId);
      const seller = await repos.users.findById(receipt.sellerId);
      return lot === null || seller === null ? null : { receipt, lot, seller };
    });
    if (found === null) throw notFound();

    const { receipt, lot, seller } = found;
    return {
      code: receipt.code,
      lot: { id: lot.id, title: lot.title, imageUrl: lot.item.imageUrl },
      amount: receipt.amount,
      bidCount: receipt.bidCount,
      issuedAt: receipt.issuedAt,
      sellerName: seller.displayName,
      winner: publicBidderRef(this.deps.mac, receipt.winnerId, lot.id),
      signatureValid: verifyReceiptSignature(this.deps.mac, receipt, receipt.signature),
    };
  }

  private async list(
    viewer: Actor | null,
    query: Omit<LotListQuery, 'now'>,
  ): Promise<Paged<LotSummaryDto>> {
    const now = this.deps.clock.now();
    const { rows, total } = await this.deps.readModel.listLots({ ...query, now });
    return {
      items: rows.map((row: LotListRow) =>
        this.toSummary(row.lot, row.sellerName, row.receiptCode, viewer, now),
      ),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      serverNow: now,
    };
  }

  private async loadRoom(lotId: string): Promise<{
    lot: LotRecord;
    sellerName: string;
    bids: StoredBid[];
    receipt: StoredReceipt | null;
  }> {
    const loaded = await this.deps.uow.readSnapshot(async (repos) => {
      const lot = await repos.lots.findById(lotId);
      if (lot === null) return null;
      const seller = await repos.users.findById(lot.sellerId);
      const bids = await repos.bids.listByLot(lotId);
      const receipt = await repos.receipts.findByLot(lotId);
      return { lot, sellerName: seller?.displayName ?? 'Leiloeiro', bids, receipt };
    });
    if (loaded === null) throw new NotFoundError('LOT_NOT_FOUND', 'Lote nao encontrado.');
    return loaded;
  }

  private resultOf(lot: LotRecord, receipt: StoredReceipt | null): LotDetailDto['result'] {
    if (lot.status === 'cancelled') return { outcome: 'cancelled' };
    if (lot.status !== 'closed') return null;
    if (receipt === null) return { outcome: 'no_winner' };
    return {
      outcome: 'sold',
      amount: receipt.amount,
      winner: publicBidderRef(this.deps.mac, receipt.winnerId, lot.id),
      receiptCode: receipt.code,
    };
  }

  private toSummary(
    lot: LotRecord,
    sellerName: string,
    receiptCode: string | null,
    viewer: Actor | null,
    now: Date,
  ): LotSummaryDto {
    const leading =
      lot.leaderId !== null && lot.currentAmount !== null
        ? { bidderId: lot.leaderId, amount: lot.currentAmount }
        : null;
    return {
      id: lot.id,
      title: lot.title,
      imageUrl: lot.item.imageUrl,
      startingBid: lot.startingBid,
      minIncrement: lot.minIncrement,
      currentAmount: lot.currentAmount,
      minimumNextBid: cents(minimumAcceptableBid(lot, leading)),
      bidCount: lot.bidCount,
      startsAt: lot.startsAt,
      endsAt: lot.endsAt,
      status: lot.status,
      phase: lotPhase(lot, now),
      sellerName,
      receiptCode,
      viewer:
        viewer === null
          ? null
          : { isSeller: lot.sellerId === viewer.id, isLeading: lot.leaderId === viewer.id },
    };
  }
}

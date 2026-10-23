import type { ChainedBid, LotSeal } from '../domain/hash-chain.js';
import type { LotState } from '../domain/lot.js';
import type { Cents } from '../domain/money.js';
import type { Wallet } from '../domain/wallet.js';

export type Role = 'seller' | 'bidder';

export interface Actor {
  readonly id: string;
  readonly role: Role;
}

/**
 * Copia do item da API externa, feita NA CRIACAO do lote. Vitrine, sala, auditoria e comprovante
 * leem so isto: a API externa pode cair sem afetar nada alem da busca do leiloeiro.
 */
export interface ItemSnapshot {
  readonly source: string;
  readonly sourceId: string;
  readonly sourceUrl: string | null;
  readonly title: string;
  readonly imageUrl: string | null;
  readonly attributes: Readonly<Record<string, string>>;
}

export interface LotRecord extends LotState {
  readonly title: string;
  readonly item: ItemSnapshot;
  readonly currentAmount: Cents | null;
  readonly leaderId: string | null;
  readonly bidCount: number;
  readonly seal: LotSeal;
  readonly extensionCount: number;
  readonly createdAt: Date;
  readonly closedAt: Date | null;
  readonly cancelledAt: Date | null;
}

export interface StoredBid extends ChainedBid {
  readonly id: string;
  readonly lotId: string;
  readonly idempotencyKey: string | null;
}

export type LedgerKind = 'deposit' | 'hold' | 'release' | 'settle_debit' | 'settle_credit';

export interface LedgerEntry {
  readonly userId: string;
  readonly kind: LedgerKind;
  readonly amount: Cents;
  readonly totalAfter: Cents;
  readonly committedAfter: Cents;
  readonly lotId: string | null;
  readonly bidId: string | null;
  readonly idempotencyKey: string | null;
}

export interface StoredReceipt {
  readonly code: string;
  readonly lotId: string;
  readonly winnerId: string;
  readonly sellerId: string;
  readonly amount: Cents;
  readonly bidCount: number;
  readonly finalHeadHash: string;
  readonly issuedAt: Date;
  readonly signature: string;
}

export interface BidApplied {
  readonly lotId: string;
  readonly currentAmount: Cents;
  readonly leaderId: string;
  readonly bidCount: number;
  readonly seal: LotSeal;
  readonly endsAt: Date;
  readonly extensionCount: number;
}

export interface LotRepository {
  /** SELECT ... FOR UPDATE. Serializa todo lance, liquidacao e cancelamento do mesmo lote. */
  lockById(id: string): Promise<LotRecord | null>;
  findById(id: string): Promise<LotRecord | null>;
  /** Ids de lotes ainda abertos cujo fim ja passou (candidatos a liquidacao). Sem lock. */
  findDueIds(now: Date, limit: number): Promise<string[]>;
  insert(lot: LotRecord): Promise<void>;
  applyBid(update: BidApplied): Promise<void>;
  markClosed(lotId: string, at: Date): Promise<void>;
  markCancelled(lotId: string, at: Date): Promise<void>;
}

export interface BidRepository {
  last(lotId: string): Promise<StoredBid | null>;
  insert(bid: StoredBid): Promise<void>;
  listByLot(lotId: string): Promise<StoredBid[]>;
  findByIdempotencyKey(bidderId: string, key: string): Promise<StoredBid | null>;
}

export interface WalletRepository {
  /** Garante que a carteira existe e a trava (FOR UPDATE) ate o fim da transacao. */
  lock(userId: string): Promise<Wallet>;
  save(wallet: Wallet): Promise<void>;
  appendLedger(entry: LedgerEntry): Promise<void>;
  findLedgerByKey(userId: string, key: string): Promise<LedgerEntry | null>;
  ledgerByLot(lotId: string): Promise<(LedgerEntry & { id: number })[]>;
}

export interface ReceiptRepository {
  insert(receipt: StoredReceipt): Promise<void>;
  findByLot(lotId: string): Promise<StoredReceipt | null>;
  findByCode(code: string): Promise<StoredReceipt | null>;
}

export interface Repositories {
  readonly lots: LotRepository;
  readonly bids: BidRepository;
  readonly wallets: WalletRepository;
  readonly receipts: ReceiptRepository;
}

export interface UnitOfWork {
  /** Transacao de escrita (COMMIT ao resolver, ROLLBACK ao lancar). Faz retry em deadlock. */
  run<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
  /** Leitura consistente (snapshot unico): lote, lances e extrato do mesmo instante. */
  readSnapshot<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  uuid(): string;
  /** Codigo publico e nao adivinhavel do comprovante (link de compartilhamento). */
  receiptCode(): string;
}

/** Eventos para o tempo real. Publicados SOMENTE depois do COMMIT. */
export type AuctionEvent =
  | {
      readonly type: 'bid_placed';
      readonly lotId: string;
      readonly seq: number;
      readonly amount: Cents;
      readonly bidderId: string;
      readonly previousLeaderId: string | null;
      readonly placedAt: Date;
      readonly endsAt: Date;
      readonly extended: boolean;
      readonly bidCount: number;
    }
  | { readonly type: 'lot_closed'; readonly lotId: string; readonly sold: boolean }
  | { readonly type: 'lot_cancelled'; readonly lotId: string };

export interface EventPublisher {
  publish(event: AuctionEvent): void;
}

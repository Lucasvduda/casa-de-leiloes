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

export interface StoredUser {
  readonly id: string;
  /** Sempre minusculo e aparado. */
  readonly email: string;
  readonly displayName: string;
  /** Hash argon2id (PHC). Nunca sai da camada de aplicacao. */
  readonly passwordHash: string;
  readonly role: Role;
  readonly createdAt: Date;
}

export interface UserRepository {
  insert(user: StoredUser): Promise<void>;
  findByEmail(email: string): Promise<StoredUser | null>;
  findById(id: string): Promise<StoredUser | null>;
}

export interface StoredSession {
  /** SHA-256 (hex) do token do cookie. O token em si nunca e persistido. */
  readonly idHash: string;
  readonly userId: string;
  readonly csrfToken: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface SessionRepository {
  insert(session: StoredSession): Promise<void>;
  /** So devolve sessao ainda valida (`expiresAt > now`), junto com o usuario dono dela. */
  findValid(
    idHash: string,
    now: Date,
  ): Promise<{ session: StoredSession; user: StoredUser } | null>;
  delete(idHash: string): Promise<void>;
  /** Mantem so as `keep` sessoes mais recentes do usuario (limita acumulo por login repetido). */
  trimToNewest(userId: string, keep: number): Promise<void>;
  deleteExpired(now: Date): Promise<number>;
}

export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  /** Nunca lanca por hash malformado: devolve false. */
  verify(hash: string, plain: string): Promise<boolean>;
}

export interface Repositories {
  readonly lots: LotRepository;
  readonly bids: BidRepository;
  readonly wallets: WalletRepository;
  readonly receipts: ReceiptRepository;
  readonly users: UserRepository;
  readonly sessions: SessionRepository;
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

// ---------------------------------------------------------------------------------------------
// Leitura (vitrine, paineis, extrato). Consultas que cruzam tabelas ficam fora dos repositorios
// de escrita, que existem para proteger invariantes dentro da transacao.
// ---------------------------------------------------------------------------------------------

export type LotPhaseFilter = 'live' | 'scheduled' | 'finished' | 'cancelled' | 'all';
export type LotSort = 'ending' | 'newest' | 'price_asc' | 'price_desc';

export interface LotListQuery {
  readonly phase: LotPhaseFilter;
  readonly search: string | null;
  readonly sort: LotSort;
  readonly page: number;
  readonly pageSize: number;
  readonly now: Date;
  /** Lotes deste leiloeiro. */
  readonly sellerId?: string;
  /** Lotes em que esta pessoa deu pelo menos um lance. */
  readonly bidderId?: string;
  /** Lotes arrematados por esta pessoa (comprovante emitido). */
  readonly wonBy?: string;
}

export interface LotListRow {
  readonly lot: LotRecord;
  readonly sellerName: string;
  readonly receiptCode: string | null;
}

export interface LedgerView {
  readonly id: number;
  readonly kind: LedgerKind;
  readonly amount: Cents;
  readonly totalAfter: Cents;
  readonly committedAfter: Cents;
  readonly lotId: string | null;
  readonly lotTitle: string | null;
  readonly createdAt: Date;
}

export interface AuctionReadModel {
  listLots(query: LotListQuery): Promise<{ rows: LotListRow[]; total: number }>;
  walletSummary(userId: string): Promise<{ total: Cents; committed: Cents }>;
  /** Extrato do mais novo para o mais antigo. eforeId pagina por cursor (estavel mesmo com novas linhas). */
  ledger(userId: string, limit: number, beforeId: number | null): Promise<LedgerView[]>;
  sellerTotals(sellerId: string): Promise<{ received: Cents; soldCount: number }>;
}

// ---------------------------------------------------------------------------------------------
// Catalogo externo (API publica de itens). So a BUSCA do leiloeiro depende dele.
// ---------------------------------------------------------------------------------------------

export interface CatalogSearchResult {
  readonly items: readonly ItemSnapshot[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  /** true quando veio do cache vencido ou do catalogo offline porque a API externa falhou. */
  readonly degraded: boolean;
}

export interface Catalog {
  search(query: string, page: number): Promise<CatalogSearchResult>;
  /** Item completo para virar snapshot do lote. 404 se nao existe; 503 se o catalogo esta fora. */
  getItem(sourceId: string): Promise<ItemSnapshot>;
}

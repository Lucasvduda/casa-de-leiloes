/**
 * Contrato da API (espelha os DTOs do servidor). Datas chegam como string ISO 8601; dinheiro,
 * como inteiro em centavos.
 */

export type Role = 'seller' | 'bidder';

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: Role;
}

export interface SessionPayload {
  user: User;
  csrfToken: string;
}

export type LotStatus = 'open' | 'closed' | 'cancelled';
export type LotPhase = 'scheduled' | 'live' | 'ended' | 'closed' | 'cancelled';

export interface ViewerFlags {
  isSeller: boolean;
  isLeading: boolean;
}

export interface LotSummary {
  id: string;
  title: string;
  imageUrl: string | null;
  startingBid: number;
  minIncrement: number;
  currentAmount: number | null;
  minimumNextBid: number;
  bidCount: number;
  startsAt: string;
  endsAt: string;
  status: LotStatus;
  phase: LotPhase;
  sellerName: string;
  receiptCode: string | null;
  viewer: ViewerFlags | null;
}

export interface Paged<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  serverNow: string;
}

export interface SellerLots extends Paged<LotSummary> {
  totals: { received: number; soldCount: number };
}

export interface ItemSnapshot {
  source: string;
  sourceId: string;
  sourceUrl: string | null;
  title: string;
  imageUrl: string | null;
  attributes: Record<string, string>;
}

export interface PublicBid {
  seq: number;
  bidder: string;
  mine: boolean;
  amount: number;
  placedAt: string;
}

export type LotResult =
  | { outcome: 'sold'; amount: number; winner: string; receiptCode: string }
  | { outcome: 'no_winner' }
  | { outcome: 'cancelled' }
  | null;

export interface LotDetail extends LotSummary {
  item: ItemSnapshot;
  bids: PublicBid[];
  serverNow: string;
  result: LotResult;
  viewerDetail: { ref: string } | null;
}

export type LedgerKind = 'deposit' | 'hold' | 'release' | 'settle_debit' | 'settle_credit';

export interface LedgerEntry {
  id: number;
  kind: LedgerKind;
  amount: number;
  totalAfter: number;
  committedAfter: number;
  lotId: string | null;
  lotTitle: string | null;
  createdAt: string;
}

export interface Wallet {
  total: number;
  committed: number;
  available: number;
  ledger: LedgerEntry[];
  nextCursor: number | null;
}

export interface DepositResult {
  replayed: boolean;
  [key: string]: unknown;
}

export interface BidAccepted {
  replayed: boolean;
  bid: { seq: number; amount: number; placedAt: string };
  endsAt: string;
  extended: boolean;
  bidCount: number;
}

export interface CatalogPage {
  items: ItemSnapshot[];
  total: number;
  page: number;
  pageSize: number;
  degraded: boolean;
}

export interface Receipt {
  code: string;
  lot: { id: string; title: string; imageUrl: string | null };
  amount: number;
  bidCount: number;
  issuedAt: string;
  sellerName: string;
  winner: string;
  signatureValid: boolean;
}

export type AuditIssueCode =
  | 'SEQ_DUPLICATE'
  | 'SEQ_GAP'
  | 'PREV_HASH_MISMATCH'
  | 'HASH_MISMATCH'
  | 'SEAL_INVALID'
  | 'HEAD_MISMATCH'
  | 'SUMMARY_MISMATCH'
  | 'LEDGER_MISMATCH'
  | 'RECEIPT_MISSING'
  | 'RECEIPT_MISMATCH';

export interface AuditIssue {
  code: AuditIssueCode;
  seq?: number;
}

export interface AuditReport {
  lot: {
    id: string;
    title: string;
    imageUrl: string | null;
    status: LotStatus;
    startingBid: number;
    minIncrement: number;
    startsAt: string;
    endsAt: string;
  };
  bidCount: number;
  headHash: string;
  bids: {
    seq: number;
    bidder: string;
    amount: number;
    placedAt: string;
    prevHash: string;
    hash: string;
  }[];
  integrity: { intact: boolean; issues: AuditIssue[] };
  receipt: {
    code: string;
    amount: number;
    issuedAt: string;
    winner: string;
    signatureValid: boolean;
  } | null;
}

// ---- Parametros de consulta ----------------------------------------------------------------

export type PhaseFilter = 'live' | 'scheduled' | 'finished' | 'cancelled' | 'all';
export type LotSort = 'ending' | 'newest' | 'price_asc' | 'price_desc';

export interface LotListParams {
  phase?: PhaseFilter | undefined;
  q?: string | undefined;
  sort?: LotSort | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

export interface CreateLotInput {
  sourceId: string;
  startingBid: number;
  minIncrement: number;
  startsAt: string;
  endsAt: string;
}

// ---- Eventos do tempo real (SSE) -----------------------------------------------------------

export interface BidEventPayload {
  seq: number;
  amount: number;
  bidder: string;
  placedAt: string;
  endsAt: string;
  extended: boolean;
  bidCount: number;
  minimumNextBid: number | null;
  mine: boolean;
  outbid: boolean;
  serverNow: string;
}

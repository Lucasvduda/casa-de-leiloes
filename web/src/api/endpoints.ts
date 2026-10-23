import { http } from './http';
import type {
  AuditReport,
  BidAccepted,
  CatalogPage,
  CreateLotInput,
  DepositResult,
  LotDetail,
  LotListParams,
  LotSummary,
  Paged,
  Receipt,
  Role,
  SellerLots,
  SessionPayload,
  Wallet,
} from './types';

const lotQuery = (p: LotListParams) => ({
  phase: p.phase,
  q: p.q,
  sort: p.sort,
  page: p.page,
  pageSize: p.pageSize,
});

/** Uma funcao por rota da API. Nenhuma tela monta URL na mao. */
export const api = {
  // ---- sessao ----
  me: (signal?: AbortSignal) => http.get<SessionPayload>('/auth/me', { signal }),
  login: (input: { email: string; password: string }) =>
    http.post<SessionPayload>('/auth/login', input),
  register: (input: { email: string; displayName: string; password: string; role: Role }) =>
    http.post<SessionPayload>('/auth/register', input),
  logout: () => http.post<void>('/auth/logout'),

  // ---- vitrine e sala ----
  listLots: (params: LotListParams, signal?: AbortSignal) =>
    http.get<Paged<LotSummary>>('/lots', { query: lotQuery(params), signal }),
  getLot: (id: string, signal?: AbortSignal) =>
    http.get<{ lot: LotDetail }>(`/lots/${encodeURIComponent(id)}`, { signal }).then((r) => r.lot),
  placeBid: (lotId: string, amount: number, idempotencyKey: string) =>
    http.post<BidAccepted>(
      `/lots/${encodeURIComponent(lotId)}/bids`,
      { amount },
      { idempotencyKey },
    ),
  audit: (lotId: string, signal?: AbortSignal) =>
    http.get<AuditReport>(`/lots/${encodeURIComponent(lotId)}/audit`, { signal }),
  receipt: (code: string, signal?: AbortSignal) =>
    http
      .get<{ receipt: Receipt }>(`/receipts/${encodeURIComponent(code)}`, { signal })
      .then((r) => r.receipt),

  // ---- carteira e paineis ----
  wallet: (params: { before?: number | undefined } = {}, signal?: AbortSignal) =>
    http.get<Wallet>('/wallet', { query: { before: params.before, limit: 20 }, signal }),
  deposit: (amount: number, idempotencyKey: string) =>
    http.post<DepositResult>('/wallet/deposits', { amount }, { idempotencyKey }),
  myBids: (params: LotListParams, signal?: AbortSignal) =>
    http.get<Paged<LotSummary>>('/me/bids', { query: lotQuery(params), signal }),
  myWins: (params: LotListParams, signal?: AbortSignal) =>
    http.get<Paged<LotSummary>>('/me/wins', { query: lotQuery(params), signal }),
  myLots: (params: LotListParams, signal?: AbortSignal) =>
    http.get<SellerLots>('/me/lots', { query: lotQuery(params), signal }),

  // ---- leiloeiro ----
  catalogSearch: (q: string, page: number, signal?: AbortSignal) =>
    http.get<CatalogPage>('/catalog/search', { query: { q, page }, signal }),
  createLot: (input: CreateLotInput) =>
    http.post<{ lot: LotDetail }>('/lots', input).then((r) => r.lot),
  cancelLot: (lotId: string) =>
    http.post<{ cancelled: true; refunded: boolean }>(`/lots/${encodeURIComponent(lotId)}/cancel`),
};

export const lotEventsUrl = (lotId: string): string =>
  `/api/lots/${encodeURIComponent(lotId)}/events`;

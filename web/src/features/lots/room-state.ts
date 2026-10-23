import type {
  BidAccepted,
  BidEventPayload,
  LotDetail,
  LotPhase,
  LotSummary,
} from '../../api/types';

/** Quantos lances a sala guarda (igual ao servidor). O historico completo esta na auditoria. */
export const MAX_BIDS_IN_ROOM = 50;

type PhaseInput = Pick<LotSummary, 'status' | 'startsAt' | 'endsAt'>;

/**
 * Fase do lote AGORA, pelo relogio do servidor. O estado salvo (`status`) so diz aberto/encerrado/
 * cancelado; "agendado", "ao vivo" e "aguardando encerramento" dependem da hora.
 * Mesmo intervalo semiaberto do servidor: ao vivo em [inicio, fim).
 */
export function phaseAt(lot: PhaseInput, nowMs: number): LotPhase {
  if (lot.status === 'cancelled') return 'cancelled';
  if (lot.status === 'closed') return 'closed';
  if (nowMs < Date.parse(lot.startsAt)) return 'scheduled';
  if (nowMs < Date.parse(lot.endsAt)) return 'live';
  return 'ended';
}

export type ViewerStatus = 'anonymous' | 'seller' | 'leading' | 'outbid' | 'none';

/** Como a pessoa esta no lote: liderando, superada (ja deu lance e perdeu a lideranca) ou fora. */
export function viewerStatus(lot: LotDetail): ViewerStatus {
  if (lot.viewer === null) return 'anonymous';
  if (lot.viewer.isSeller) return 'seller';
  if (lot.viewer.isLeading) return 'leading';
  // O servidor informa se a pessoa ja deu lance (mesmo que o lance dela tenha saido da janela de 50).
  const hasBid = lot.viewerDetail?.hasBid === true || lot.bids.some((bid) => bid.mine);
  return hasBid ? 'outbid' : 'none';
}

/**
 * Posicao da pessoa entre os licitantes (1 = liderando), ou null se nao deu lance / nao da para saber.
 * O valor so cresce com o numero do lance, entao a ordem dos licitantes e a ordem em que aparecem do
 * lance mais novo para o mais antigo. Se o lance dela saiu da janela, usa a posicao do servidor
 * (que pode ter ficado velha: nesse caso o applyBid zera, e a tela nao mostra posicao).
 */
export function viewerPosition(lot: LotDetail): number | null {
  const status = viewerStatus(lot);
  if (status === 'leading') return 1;
  if (status !== 'outbid') return null;
  const fromWindow = positionInWindow(lot.bids);
  return fromWindow ?? lot.viewerDetail?.position ?? null;
}

function positionInWindow(bids: LotDetail['bids']): number | null {
  const seen = new Set<string>();
  for (const bid of bids) {
    if (bid.mine) return seen.size + 1;
    seen.add(bid.bidder);
  }
  return null;
}

/** Evento que chegou com numero de ordem alem do proximo esperado: perdemos algo, hora de recarregar. */
export function hasGap(lot: LotDetail, event: BidEventPayload): boolean {
  return event.seq > lot.bidCount + 1;
}

/** Aplica um lance (evento do SSE ou resposta do POST). Idempotente: lance ja visto e ignorado. */
export function applyBid(lot: LotDetail, event: BidEventPayload): LotDetail {
  if (event.seq <= lot.bidCount) return lot;
  const entry = {
    seq: event.seq,
    bidder: event.bidder,
    mine: event.mine,
    amount: event.amount,
    placedAt: event.placedAt,
  };
  const bids = [entry, ...lot.bids].slice(0, MAX_BIDS_IN_ROOM);
  return {
    ...lot,
    currentAmount: event.amount,
    bidCount: event.bidCount,
    endsAt: event.endsAt,
    minimumNextBid: event.minimumNextBid ?? event.amount + lot.minIncrement,
    bids,
    viewerDetail: nextViewerDetail(lot, bids, event.mine),
    viewer: lot.viewer === null ? null : { ...lot.viewer, isLeading: event.mine },
    serverNow: event.serverNow,
  };
}

/** Depois de um lance: quem deu o lance e o lider; os demais so sabem a posicao se o lance deles esta na janela. */
function nextViewerDetail(
  lot: LotDetail,
  bids: LotDetail['bids'],
  mine: boolean,
): LotDetail['viewerDetail'] {
  const detail = lot.viewerDetail;
  if (detail === null) return null;
  if (mine) return { ...detail, hasBid: true, position: 1 };
  if (!detail.hasBid) return detail;
  return { ...detail, position: positionInWindow(bids) };
}

/** A resposta do POST de lance, no mesmo formato dos eventos (para a tela nao depender so do SSE). */
export function bidAcceptedToEvent(lot: LotDetail, accepted: BidAccepted): BidEventPayload {
  return {
    seq: accepted.bid.seq,
    amount: accepted.bid.amount,
    bidder: lot.viewerDetail?.ref ?? '',
    placedAt: accepted.bid.placedAt,
    endsAt: accepted.endsAt,
    extended: accepted.extended,
    bidCount: accepted.bidCount,
    minimumNextBid: null,
    mine: true,
    outbid: false,
    serverNow: accepted.bid.placedAt,
  };
}

const isTerminal = (lot: LotDetail): boolean => lot.status !== 'open';

/**
 * Junta o que ja esta na tela com um estado vindo do servidor (GET ou snapshot do SSE).
 * So avanca: uma resposta ATRASADA (pedida antes de um lance, chegada depois) nao desfaz o que o
 * tempo real ja mostrou.
 */
export function mergeLot(current: LotDetail | undefined, incoming: LotDetail): LotDetail {
  if (current === undefined) return incoming;
  if (current.id !== incoming.id) return incoming;
  if (incoming.bidCount < current.bidCount) return current;
  if (isTerminal(current) && !isTerminal(incoming)) return current;
  return incoming;
}

// ---- Lance: sugestoes e travas contra erro de digitacao ------------------------------------

/** Atalhos de valor: o minimo e alguns degraus acima (sem repetir). */
export function bidSuggestions(minimumNextBid: number, minIncrement: number): number[] {
  const steps = [0, 1, 5, 10];
  return [...new Set(steps.map((n) => minimumNextBid + n * minIncrement))];
}

/**
 * Lance "fora do normal" (provavel zero a mais): muito acima do minimo exige uma segunda confirmacao.
 * Lance e compromisso financeiro; confirmar custa um clique, errar custa dinheiro.
 */
export function isUnusualBid(
  amount: number,
  minimumNextBid: number,
  minIncrement: number,
): boolean {
  return amount >= minimumNextBid * 3 || amount - minimumNextBid >= minIncrement * 20;
}

// ---- Leitura defensiva do que chega pelo SSE -----------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isInt = (value: unknown): value is number => Number.isSafeInteger(value);

/** `null` = lixo (ignorado). Nunca lanca: um evento estranho nao pode derrubar a sala. */
export function parseBidEvent(raw: unknown): BidEventPayload | null {
  if (!isRecord(raw)) return null;
  const { seq, amount, bidder, placedAt, endsAt, extended, bidCount, minimumNextBid } = raw;
  if (!isInt(seq) || !isInt(amount) || !isInt(bidCount)) return null;
  if (typeof bidder !== 'string' || typeof placedAt !== 'string' || typeof endsAt !== 'string') {
    return null;
  }
  if (!Number.isFinite(Date.parse(placedAt)) || !Number.isFinite(Date.parse(endsAt))) return null;
  return {
    seq,
    amount,
    bidder,
    placedAt,
    endsAt,
    extended: extended === true,
    bidCount,
    minimumNextBid: isInt(minimumNextBid) ? minimumNextBid : null,
    mine: raw.mine === true,
    outbid: raw.outbid === true,
    serverNow: typeof raw.serverNow === 'string' ? raw.serverNow : placedAt,
  };
}

export function parseSnapshot(raw: unknown): LotDetail | null {
  if (!isRecord(raw) || !isRecord(raw.lot)) return null;
  const lot = raw.lot;
  if (typeof lot.id !== 'string' || !Array.isArray(lot.bids) || !isInt(lot.bidCount)) return null;
  if (typeof lot.endsAt !== 'string' || typeof lot.startsAt !== 'string') return null;
  return lot as unknown as LotDetail;
}

export function parseServerNow(raw: unknown): string | undefined {
  return isRecord(raw) && typeof raw.serverNow === 'string' ? raw.serverNow : undefined;
}

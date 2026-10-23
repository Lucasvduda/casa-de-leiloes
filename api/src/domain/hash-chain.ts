import type { Cents } from './money.js';

/**
 * Historico de lances a prova de adulteracao.
 *
 * Tecnica: cadeia de HMAC-SHA256.
 *  - Cada lance guarda `seq` contiguo, `prevHash` e `hash = HMAC(chave, campos canonicos + prevHash)`.
 *  - O lote guarda um selo (`headSeq`, `headHash`, `seal`) atualizado na mesma transacao do lance.
 *  - A chave (HMAC) vive fora do banco. Quem so alcanca o banco nao consegue recalcular hashes
 *    validos depois de editar, apagar ou inserir linhas.
 *
 * Este modulo e puro: recebe a funcao `Mac` pronta (o adapter injeta o HMAC real).
 */
export type Mac = (message: string) => string;

export interface LotTerms {
  readonly lotId: string;
  readonly sellerId: string;
  readonly startingBid: Cents;
  readonly minIncrement: Cents;
}

export interface BidPayload {
  readonly seq: number;
  readonly bidderId: string;
  readonly amount: Cents;
  readonly placedAt: Date;
}

export interface ChainedBid extends BidPayload {
  readonly prevHash: string;
  readonly hash: string;
}

export interface LotSeal {
  readonly headSeq: number;
  readonly headHash: string;
  readonly seal: string;
}

export type ChainIssueCode =
  | 'SEQ_GAP'
  | 'SEQ_DUPLICATE'
  | 'PREV_HASH_MISMATCH'
  | 'HASH_MISMATCH'
  | 'HEAD_MISMATCH'
  | 'SEAL_INVALID';

export interface ChainIssue {
  readonly code: ChainIssueCode;
  readonly seq?: number;
}

export interface ChainVerification {
  readonly intact: boolean;
  readonly issues: readonly ChainIssue[];
}

/**
 * Serializacao canonica: array JSON com etiqueta de dominio no inicio.
 * JSON nao tem ambiguidade de fronteira entre campos ("ab"+"c" vs "a"+"bc"),
 * e a etiqueta impede reaproveitar o MAC de um tipo de mensagem como outro.
 */
export function canonical(
  tag: 'genesis' | 'bid' | 'seal' | 'bidder' | 'receipt',
  ...fields: (string | number)[]
): string {
  return JSON.stringify([tag, ...fields]);
}

export function computeGenesisHash(mac: Mac, terms: LotTerms): string {
  return mac(
    canonical('genesis', terms.lotId, terms.sellerId, terms.startingBid, terms.minIncrement),
  );
}

export function computeBidHash(mac: Mac, lotId: string, bid: BidPayload, prevHash: string): string {
  return mac(
    canonical(
      'bid',
      lotId,
      bid.seq,
      bid.bidderId,
      bid.amount,
      bid.placedAt.toISOString(),
      prevHash,
    ),
  );
}

export function computeSeal(mac: Mac, lotId: string, headSeq: number, headHash: string): string {
  return mac(canonical('seal', lotId, headSeq, headHash));
}

/** Etiqueta publica do licitante em um lote. Ver `public-bidder-ref.ts`. */
export function computeBidderTag(mac: Mac, userId: string, lotId: string): string {
  return mac(canonical('bidder', userId, lotId));
}

/** Gera o proximo elo da cadeia a partir do anterior (ou do genesis, se nao houver). */
export function appendBid(
  mac: Mac,
  terms: LotTerms,
  previous: ChainedBid | null,
  input: Omit<BidPayload, 'seq'>,
): ChainedBid {
  const seq = previous === null ? 1 : previous.seq + 1;
  const prevHash = previous === null ? computeGenesisHash(mac, terms) : previous.hash;
  const payload: BidPayload = { seq, ...input };
  return { ...payload, prevHash, hash: computeBidHash(mac, terms.lotId, payload, prevHash) };
}

export function emptySeal(mac: Mac, terms: LotTerms): LotSeal {
  const headHash = computeGenesisHash(mac, terms);
  return { headSeq: 0, headHash, seal: computeSeal(mac, terms.lotId, 0, headHash) };
}

export function sealFor(mac: Mac, terms: LotTerms, head: ChainedBid | null): LotSeal {
  if (head === null) return emptySeal(mac, terms);
  return {
    headSeq: head.seq,
    headHash: head.hash,
    seal: computeSeal(mac, terms.lotId, head.seq, head.hash),
  };
}

/**
 * Refaz a cadeia inteira a partir das linhas lidas do banco e compara com o selo do lote.
 * Nao confia na ordem recebida, nem em nenhum hash armazenado: tudo e recalculado.
 *
 * Detecta: edicao (HASH_MISMATCH), remocao no meio (SEQ_GAP + PREV_HASH_MISMATCH),
 * insercao (SEQ_DUPLICATE / HASH_MISMATCH), truncamento ou acrescimo na cauda (HEAD_MISMATCH)
 * e edicao do proprio selo (SEAL_INVALID).
 */
export function verifyChain(
  mac: Mac,
  terms: LotTerms,
  bids: readonly ChainedBid[],
  storedSeal: LotSeal,
): ChainVerification {
  const issues: ChainIssue[] = [];
  const ordered = [...bids].sort((a, b) => a.seq - b.seq);

  let expectedSeq = 1;
  let expectedPrev = computeGenesisHash(mac, terms);
  let previousSeq: number | null = null;

  for (const bid of ordered) {
    if (previousSeq !== null && bid.seq === previousSeq) {
      issues.push({ code: 'SEQ_DUPLICATE', seq: bid.seq });
    } else if (bid.seq !== expectedSeq) {
      issues.push({ code: 'SEQ_GAP', seq: bid.seq });
    }
    if (bid.prevHash !== expectedPrev) {
      issues.push({ code: 'PREV_HASH_MISMATCH', seq: bid.seq });
    }
    const recomputed = computeBidHash(mac, terms.lotId, bid, bid.prevHash);
    if (recomputed !== bid.hash) {
      issues.push({ code: 'HASH_MISMATCH', seq: bid.seq });
    }
    // Continua a partir do hash armazenado para localizar o ponto exato da quebra.
    expectedPrev = bid.hash;
    expectedSeq = bid.seq + 1;
    previousSeq = bid.seq;
  }

  const sealOk =
    computeSeal(mac, terms.lotId, storedSeal.headSeq, storedSeal.headHash) === storedSeal.seal;
  if (!sealOk) issues.push({ code: 'SEAL_INVALID' });

  const last = ordered[ordered.length - 1];
  const actualHeadSeq = last === undefined ? 0 : last.seq;
  const actualHeadHash = last === undefined ? computeGenesisHash(mac, terms) : last.hash;
  if (storedSeal.headSeq !== actualHeadSeq || storedSeal.headHash !== actualHeadHash) {
    issues.push({ code: 'HEAD_MISMATCH' });
  }

  return { intact: issues.length === 0, issues };
}

import { computeSeal } from '../domain/hash-chain.js';
import type { LotTerms, Mac } from '../domain/hash-chain.js';
import type { LotRecord, StoredBid } from './ports.js';
import { IntegrityError } from './errors.js';

export function lotTermsOf(lot: LotRecord): LotTerms {
  return {
    lotId: lot.id,
    sellerId: lot.sellerId,
    startingBid: lot.startingBid,
    minIncrement: lot.minIncrement,
  };
}

/**
 * Checagem O(1) antes de construir um novo elo: o selo do lote tem que ser valido (HMAC com a
 * nossa chave) e apontar exatamente para o ultimo lance gravado. Se nao bater, o historico foi
 * mexido por fora da aplicacao e NAO empilhamos mais lances em cima dele.
 */
export function assertSealedHead(mac: Mac, lot: LotRecord, last: StoredBid | null): void {
  const { headSeq, headHash, seal } = lot.seal;
  if (computeSeal(mac, lot.id, headSeq, headHash) !== seal) {
    throw new IntegrityError('Selo do lote invalido: historico de lances comprometido.');
  }
  const actualSeq = last === null ? 0 : last.seq;
  const actualHash = last === null ? headHash : last.hash;
  // Lote sem lances: o selo vazio aponta para o genesis; conferimos o seq e a contagem.
  if (
    headSeq !== actualSeq ||
    (last !== null && headHash !== actualHash) ||
    lot.bidCount !== actualSeq
  ) {
    throw new IntegrityError('Historico de lances nao confere com o selo do lote.');
  }
}

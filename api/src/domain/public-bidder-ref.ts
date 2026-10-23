import { computeBidderTag } from './hash-chain.js';
import type { Mac } from './hash-chain.js';

/**
 * Identificacao publica do licitante na auditoria e no comprovante.
 * HMAC por (usuario, lote): consistente dentro do lote, mas nao correlacionavel entre lotes
 * e irreversivel sem a chave do servidor. Nenhum nome, e-mail ou id interno aparece.
 */
export function publicBidderRef(mac: Mac, userId: string, lotId: string): string {
  return `Licitante #${computeBidderTag(mac, userId, lotId).slice(0, 8)}`;
}

import { canonical } from './hash-chain.js';
import type { Mac } from './hash-chain.js';
import type { Cents } from './money.js';

/**
 * Fatos assinados no comprovante de arremate. A assinatura (HMAC) amarra o resultado ao hash final
 * da cadeia de lances: se o historico for truncado ou reescrito depois do encerramento,
 * a cadeia deixa de bater com o `finalHeadHash` registrado aqui.
 */
export interface ReceiptFacts {
  readonly code: string;
  readonly lotId: string;
  readonly sellerId: string;
  readonly winnerId: string;
  readonly amount: Cents;
  readonly bidCount: number;
  readonly finalHeadHash: string;
  readonly issuedAt: Date;
}

export function computeReceiptSignature(mac: Mac, f: ReceiptFacts): string {
  return mac(
    canonical(
      'receipt',
      f.code,
      f.lotId,
      f.sellerId,
      f.winnerId,
      f.amount,
      f.bidCount,
      f.finalHeadHash,
      f.issuedAt.toISOString(),
    ),
  );
}

export function verifyReceiptSignature(mac: Mac, f: ReceiptFacts, signature: string): boolean {
  return computeReceiptSignature(mac, f) === signature;
}

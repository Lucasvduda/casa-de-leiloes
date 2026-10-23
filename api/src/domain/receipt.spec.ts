import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Mac } from './hash-chain.js';
import { cents } from './money.js';
import { computeReceiptSignature, verifyReceiptSignature } from './receipt.js';
import type { ReceiptFacts } from './receipt.js';

const mac =
  (secret: string): Mac =>
  (m) =>
    createHmac('sha256', secret).update(m).digest('hex');

const KEY = mac('segredo');

const FACTS: ReceiptFacts = {
  code: 'abc123',
  lotId: 'lot-1',
  sellerId: 'seller-1',
  winnerId: 'bidder-1',
  amount: cents(25_000),
  bidCount: 7,
  finalHeadHash: 'h'.repeat(64),
  issuedAt: new Date('2026-11-01T13:00:00.000Z'),
};

describe('comprovante assinado', () => {
  it('assinatura valida confere', () => {
    const sig = computeReceiptSignature(KEY, FACTS);
    expect(verifyReceiptSignature(KEY, FACTS, sig)).toBe(true);
  });

  it('e deterministico', () => {
    expect(computeReceiptSignature(KEY, FACTS)).toBe(computeReceiptSignature(KEY, FACTS));
  });

  it.each([
    ['code', { code: 'outro' }],
    ['lotId', { lotId: 'lot-2' }],
    ['sellerId', { sellerId: 'seller-2' }],
    ['winnerId', { winnerId: 'bidder-2' }],
    ['amount', { amount: cents(25_001) }],
    ['bidCount', { bidCount: 8 }],
    ['finalHeadHash', { finalHeadHash: 'x'.repeat(64) }],
    ['issuedAt', { issuedAt: new Date('2026-11-01T13:00:00.001Z') }],
  ] as const)('alterar %s invalida a assinatura', (_name, change) => {
    const sig = computeReceiptSignature(KEY, FACTS);
    expect(verifyReceiptSignature(KEY, { ...FACTS, ...change }, sig)).toBe(false);
  });

  it('assinatura feita com outra chave nao confere', () => {
    const forged = computeReceiptSignature(mac('atacante'), FACTS);
    expect(verifyReceiptSignature(KEY, FACTS, forged)).toBe(false);
  });

  it('assinatura de tamanho errado ou vazia nao confere (sem lancar excecao)', () => {
    expect(verifyReceiptSignature(KEY, FACTS, '')).toBe(false);
    expect(verifyReceiptSignature(KEY, FACTS, 'curta')).toBe(false);
  });
});

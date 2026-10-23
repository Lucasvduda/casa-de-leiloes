import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Mac } from './hash-chain.js';
import { publicBidderRef } from './public-bidder-ref.js';

const mac =
  (secret: string): Mac =>
  (m) =>
    createHmac('sha256', secret).update(m).digest('hex');

describe('publicBidderRef', () => {
  const key = mac('segredo');

  it('formato legivel e sem dado pessoal', () => {
    expect(publicBidderRef(key, 'user-1', 'lot-1')).toMatch(/^Licitante #[0-9a-f]{8}$/);
  });

  it('e estavel dentro do mesmo lote', () => {
    expect(publicBidderRef(key, 'user-1', 'lot-1')).toBe(publicBidderRef(key, 'user-1', 'lot-1'));
  });

  it('pessoas diferentes tem referencias diferentes no mesmo lote', () => {
    expect(publicBidderRef(key, 'user-1', 'lot-1')).not.toBe(
      publicBidderRef(key, 'user-2', 'lot-1'),
    );
  });

  it('a mesma pessoa NAO e correlacionavel entre lotes', () => {
    expect(publicBidderRef(key, 'user-1', 'lot-1')).not.toBe(
      publicBidderRef(key, 'user-1', 'lot-2'),
    );
  });

  it('nao permite descobrir o id sem a chave (outra chave, outra referencia)', () => {
    expect(publicBidderRef(key, 'user-1', 'lot-1')).not.toBe(
      publicBidderRef(mac('outra'), 'user-1', 'lot-1'),
    );
  });

  it('nao vaza o id do usuario na referencia', () => {
    expect(publicBidderRef(key, 'user-1', 'lot-1')).not.toContain('user-1');
  });
});

import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  appendBid,
  computeBidHash,
  computeGenesisHash,
  computeSeal,
  emptySeal,
  sealFor,
  verifyChain,
} from './hash-chain.js';
import type { ChainedBid, LotSeal, LotTerms, Mac } from './hash-chain.js';
import { cents } from './money.js';

const mac =
  (secret: string): Mac =>
  (message) =>
    createHmac('sha256', secret).update(message).digest('hex');

const KEY = mac('segredo-do-servidor');

const TERMS: LotTerms = {
  lotId: 'lot-1',
  sellerId: 'seller-1',
  startingBid: cents(10_000),
  minIncrement: cents(500),
};

const T0 = new Date('2026-11-01T12:10:00.000Z');

function buildChain(n: number): { bids: ChainedBid[]; seal: LotSeal } {
  const bids: ChainedBid[] = [];
  let previous: ChainedBid | null = null;
  for (let i = 0; i < n; i++) {
    const bid = appendBid(KEY, TERMS, previous, {
      bidderId: i % 2 === 0 ? 'bidder-a' : 'bidder-b',
      amount: cents(10_000 + i * 500),
      placedAt: new Date(T0.getTime() + i * 1000),
    });
    bids.push(bid);
    previous = bid;
  }
  return { bids, seal: sealFor(KEY, TERMS, previous) };
}

const clone = <T>(v: T): T => structuredClone(v);

describe('construcao da cadeia', () => {
  it('primeiro lance aponta para o genesis e tem seq 1', () => {
    const { bids } = buildChain(1);
    expect(bids[0]?.seq).toBe(1);
    expect(bids[0]?.prevHash).toBe(computeGenesisHash(KEY, TERMS));
  });

  it('cada lance aponta para o hash do anterior', () => {
    const { bids } = buildChain(4);
    for (let i = 1; i < bids.length; i++) {
      expect(bids[i]?.prevHash).toBe(bids[i - 1]?.hash);
      expect(bids[i]?.seq).toBe(i + 1);
    }
  });

  it('e deterministico: mesma entrada, mesmo hash', () => {
    expect(buildChain(3).bids.map((b) => b.hash)).toEqual(buildChain(3).bids.map((b) => b.hash));
  });

  it('chave diferente produz hash diferente', () => {
    const a = computeGenesisHash(KEY, TERMS);
    const b = computeGenesisHash(mac('outra-chave'), TERMS);
    expect(a).not.toBe(b);
  });

  it('qualquer campo do lance altera o hash', () => {
    const base = { seq: 1, bidderId: 'a', amount: cents(100), placedAt: T0 };
    const h = (o: Partial<typeof base>) => computeBidHash(KEY, 'lot-1', { ...base, ...o }, 'prev');
    const original = h({});
    expect(h({ seq: 2 })).not.toBe(original);
    expect(h({ bidderId: 'b' })).not.toBe(original);
    expect(h({ amount: cents(101) })).not.toBe(original);
    expect(h({ placedAt: new Date(T0.getTime() + 1) })).not.toBe(original);
    expect(computeBidHash(KEY, 'lot-2', base, 'prev')).not.toBe(original);
    expect(computeBidHash(KEY, 'lot-1', base, 'outro')).not.toBe(original);
  });

  it('serializacao canonica nao e ambigua entre campos vizinhos', () => {
    const a = computeBidHash(
      KEY,
      'lot-1',
      { seq: 1, bidderId: 'ab', amount: cents(1), placedAt: T0 },
      'x',
    );
    const b = computeBidHash(
      KEY,
      'lot-1',
      { seq: 1, bidderId: 'a', amount: cents(1), placedAt: T0 },
      'bx',
    );
    expect(a).not.toBe(b);
  });

  it('selo de lote sem lances parte do genesis', () => {
    expect(sealFor(KEY, TERMS, null)).toEqual(emptySeal(KEY, TERMS));
    expect(emptySeal(KEY, TERMS).headSeq).toBe(0);
    expect(emptySeal(KEY, TERMS).headHash).toBe(computeGenesisHash(KEY, TERMS));
  });
});

describe('verifyChain: cadeia integra', () => {
  it('lote sem lances e integro', () => {
    expect(verifyChain(KEY, TERMS, [], emptySeal(KEY, TERMS))).toEqual({
      intact: true,
      issues: [],
    });
  });

  it('cadeia com varios lances e integra', () => {
    const { bids, seal } = buildChain(25);
    expect(verifyChain(KEY, TERMS, bids, seal)).toEqual({ intact: true, issues: [] });
  });

  it('nao depende da ordem em que as linhas chegam do banco', () => {
    const { bids, seal } = buildChain(10);
    expect(verifyChain(KEY, TERMS, [...bids].reverse(), seal).intact).toBe(true);
  });
});

describe('verifyChain: adulteracao detectada', () => {
  let bids: ChainedBid[];
  let seal: LotSeal;
  beforeEach(() => {
    ({ bids, seal } = buildChain(6));
  });

  const codes = (b: ChainedBid[], s: LotSeal, terms = TERMS) =>
    verifyChain(KEY, terms, b, s).issues.map((i) => i.code);

  it('EDICAO do valor de um lance', () => {
    const tampered = clone(bids);
    tampered[2] = { ...tampered[2]!, amount: cents(1) };
    const r = verifyChain(KEY, TERMS, tampered, seal);
    expect(r.intact).toBe(false);
    expect(r.issues).toContainEqual({ code: 'HASH_MISMATCH', seq: 3 });
  });

  it('EDICAO do licitante de um lance', () => {
    const tampered = clone(bids);
    tampered[1] = { ...tampered[1]!, bidderId: 'intruso' };
    expect(codes(tampered, seal)).toContain('HASH_MISMATCH');
  });

  it('EDICAO do instante de um lance', () => {
    const tampered = clone(bids);
    tampered[4] = { ...tampered[4]!, placedAt: new Date(T0.getTime() - 5000) };
    expect(codes(tampered, seal)).toContain('HASH_MISMATCH');
  });

  it('EDICAO do ultimo lance (valor do vencedor)', () => {
    const tampered = clone(bids);
    tampered[5] = { ...tampered[5]!, amount: cents(1) };
    expect(codes(tampered, seal)).toContain('HASH_MISMATCH');
  });

  it('REMOCAO de um lance do meio', () => {
    const tampered = bids.filter((b) => b.seq !== 3);
    const c = codes(tampered, seal);
    expect(c).toContain('SEQ_GAP');
    expect(c).toContain('PREV_HASH_MISMATCH');
  });

  it('REMOCAO do primeiro lance', () => {
    const tampered = bids.filter((b) => b.seq !== 1);
    expect(codes(tampered, seal)).toContain('SEQ_GAP');
  });

  it('REMOCAO do ultimo lance (truncamento da cauda) e pega pelo selo', () => {
    const tampered = bids.slice(0, -1);
    expect(codes(tampered, seal)).toContain('HEAD_MISMATCH');
  });

  it('REMOCAO de todos os lances', () => {
    expect(codes([], seal)).toContain('HEAD_MISMATCH');
  });

  it('INSERCAO no meio, com hash inventado', () => {
    const forged: ChainedBid = {
      seq: 3,
      bidderId: 'intruso',
      amount: cents(999_999),
      placedAt: T0,
      prevHash: bids[1]!.hash,
      hash: 'f'.repeat(64),
    };
    const tampered = [...bids.slice(0, 2), forged, ...bids.slice(2)];
    const c = codes(tampered, seal);
    expect(c).toContain('SEQ_DUPLICATE');
    expect(c).toContain('HASH_MISMATCH');
  });

  it('INSERCAO no fim, com hash inventado, e pega pelo selo', () => {
    const last = bids[bids.length - 1]!;
    const forged: ChainedBid = {
      seq: last.seq + 1,
      bidderId: 'intruso',
      amount: cents(999_999),
      placedAt: T0,
      prevHash: last.hash,
      hash: 'a'.repeat(64),
    };
    const c = codes([...bids, forged], seal);
    expect(c).toContain('HASH_MISMATCH');
    expect(c).toContain('HEAD_MISMATCH');
  });

  it('INSERCAO calculada com OUTRA chave nao engana a auditoria', () => {
    const attackerKey = mac('chave-do-atacante');
    const last = bids[bids.length - 1]!;
    const forged = appendBid(attackerKey, TERMS, last, {
      bidderId: 'intruso',
      amount: cents(999_999),
      placedAt: T0,
    });
    expect(codes([...bids, forged], seal)).toContain('HASH_MISMATCH');
  });

  it('REESCRITA INTEIRA da cadeia com outra chave e detectada', () => {
    const attackerKey = mac('chave-do-atacante');
    const rewritten: ChainedBid[] = [];
    let prev: ChainedBid | null = null;
    for (const b of bids) {
      const nb = appendBid(attackerKey, TERMS, prev, {
        bidderId: b.bidderId,
        amount: cents(1),
        placedAt: b.placedAt,
      });
      rewritten.push(nb);
      prev = nb;
    }
    const r = verifyChain(KEY, TERMS, rewritten, sealFor(attackerKey, TERMS, prev));
    expect(r.intact).toBe(false);
  });

  it('REORDENACAO de seq entre dois lances', () => {
    const tampered = clone(bids);
    tampered[1] = { ...tampered[1]!, seq: 3 };
    tampered[2] = { ...tampered[2]!, seq: 2 };
    expect(verifyChain(KEY, TERMS, tampered, seal).intact).toBe(false);
  });

  it('EDICAO do selo guardado no lote (head_hash trocado)', () => {
    const forgedSeal = { ...seal, headHash: 'b'.repeat(64) };
    const c = codes(bids, forgedSeal);
    expect(c).toContain('SEAL_INVALID');
  });

  it('EDICAO do selo guardado no lote (head_seq trocado)', () => {
    const forgedSeal = { ...seal, headSeq: seal.headSeq - 1 };
    expect(verifyChain(KEY, TERMS, bids, forgedSeal).intact).toBe(false);
  });

  it('SELO recalculado com outra chave e invalido', () => {
    const attackerSeal: LotSeal = {
      headSeq: seal.headSeq,
      headHash: seal.headHash,
      seal: computeSeal(mac('chave-do-atacante'), TERMS.lotId, seal.headSeq, seal.headHash),
    };
    expect(codes(bids, attackerSeal)).toContain('SEAL_INVALID');
  });

  it('TERMOS do lote alterados (lance inicial) quebram desde o genesis', () => {
    const changed = { ...TERMS, startingBid: cents(1) };
    expect(codes(bids, seal, changed)).toContain('PREV_HASH_MISMATCH');
  });

  it('cadeia de OUTRO lote colada neste lote e detectada', () => {
    const other = { ...TERMS, lotId: 'lot-2' };
    const foreign = buildChainFor(other, 6);
    expect(verifyChain(KEY, TERMS, foreign.bids, foreign.seal).intact).toBe(false);
  });
});

function buildChainFor(terms: LotTerms, n: number) {
  const bids: ChainedBid[] = [];
  let previous: ChainedBid | null = null;
  for (let i = 0; i < n; i++) {
    const bid = appendBid(KEY, terms, previous, {
      bidderId: 'x',
      amount: cents(10_000 + i * 500),
      placedAt: new Date(T0.getTime() + i * 1000),
    });
    bids.push(bid);
    previous = bid;
  }
  return { bids, seal: sealFor(KEY, terms, previous) };
}

describe('appendBid: sequenciamento', () => {
  it('incrementa o seq a partir do anterior', () => {
    const { bids } = buildChain(3);
    expect(bids.map((b) => b.seq)).toEqual([1, 2, 3]);
  });
});

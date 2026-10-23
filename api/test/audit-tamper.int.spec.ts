import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeBidHash, computeSeal } from '../src/domain/hash-chain.js';
import { cents } from '../src/domain/money.js';
import { computeReceiptSignature } from '../src/domain/receipt.js';
import { createMac } from '../src/adapters/outbound/system.js';
import type { AuditIssueCode } from '../src/application/usecases/audit-lot.js';
import { HOUR, createHarness, reais } from './support/harness.js';
import type { Harness } from './support/harness.js';
import { createTestDb } from './support/test-db.js';
import type { TestDb } from './support/test-db.js';

/**
 * Matriz de adulteracao. Aqui o atacante e um superusuario do Postgres: desliga os triggers
 * (`session_replication_role = replica`) e mexe direto nas tabelas. O que se prova e que a
 * auditoria publica (cadeia de HMAC + resumo + extrato + comprovante) enxerga CADA ataque, e que
 * nenhum ataque e "silencioso". Antes de cada ataque, a auditoria precisa estar integra: assim,
 * a deteccao so pode ser consequencia da adulteracao.
 *
 * Os lotes adulterados NAO sao restaurados (cada caso usa lote proprio), por isso esta suite nao
 * roda `assertInvariants`: ela corromperia de proposito o extrato e as cadeias.
 */

let db: TestDb;
let h: Harness;
let raw: pg.Client;

beforeAll(async () => {
  db = await createTestDb();
  h = createHarness(db);
  raw = await db.rawClient();
  await raw.query(`SET session_replication_role = replica`);
});

afterAll(async () => {
  await db.close();
});

interface Ctx {
  lotId: string;
  sellerId: string;
  aliceId: string;
  bobId: string;
  /** ids dos lances por seq (1..n). */
  bidIds: Record<number, string>;
}

type Expected = { code: AuditIssueCode; seq?: number };

/** Lote com 4 lances alternados (alice 100, bob 105, alice 110, bob 115). Lider: bob. */
async function openLot(): Promise<Ctx> {
  const seller = await h.seedUser('seller');
  const alice = await h.seedUser('bidder', 'alice');
  const bob = await h.seedUser('bidder', 'bob');
  await h.fund(alice, reais(10_000));
  await h.fund(bob, reais(10_000));
  const lot = await h.newLot(seller);
  const amounts = [100, 105, 110, 115];
  for (const [i, value] of amounts.entries()) {
    const r = await h.placeBid.execute({
      actor: i % 2 === 0 ? alice : bob,
      lotId: lot.id,
      amount: reais(value),
    });
    expect(r.accepted).toBe(true);
    h.clock.advance(1_000);
  }
  const { rows } = await db.pool.query<{ id: string; seq: number }>(
    `SELECT id, seq FROM bids WHERE lot_id = $1`,
    [lot.id],
  );
  const bidIds = Object.fromEntries(rows.map((r) => [r.seq, r.id]));
  return { lotId: lot.id, sellerId: seller.id, aliceId: alice.id, bobId: bob.id, bidIds };
}

/** Lote encerrado e liquidado (2 lances), com comprovante emitido. */
async function closedLot(): Promise<Ctx> {
  const ctx = await openLot();
  h.clock.advance(2 * HOUR);
  const out = await h.settleLot.execute(ctx.lotId);
  expect(out.kind).toBe('sold');
  return ctx;
}

async function expectIntactNow(lotId: string): Promise<void> {
  const report = await h.audit.execute(lotId);
  expect(report.integrity.issues, 'antes do ataque a auditoria precisa estar integra').toEqual([]);
}

async function expectDetected(lotId: string, expected: Expected[]): Promise<void> {
  const report = await h.audit.execute(lotId);
  expect(report.integrity.intact, 'adulteracao silenciosa: a auditoria nao viu nada').toBe(false);
  for (const e of expected) {
    expect(report.integrity.issues).toContainEqual(e.seq === undefined ? { code: e.code } : e);
  }
}

describe('controle: sem adulteracao nao ha falso positivo', () => {
  it('lote aberto, encerrado, cancelado e sem lances: todos integros', async () => {
    const open = await openLot();
    const closed = await closedLot();
    const cancelled = await openLot();
    await h.cancelLot.execute({ id: cancelled.sellerId, role: 'seller' }, cancelled.lotId);
    const empty = await h.newLot(await h.seedUser('seller'));

    for (const id of [open.lotId, closed.lotId, cancelled.lotId, empty.id]) {
      const report = await h.audit.execute(id);
      expect(report.integrity, id).toEqual({ intact: true, issues: [] });
    }
  });
});

interface Attack {
  name: string;
  kind?: 'open' | 'closed';
  run: (c: Ctx) => Promise<void>;
  expected: Expected[];
}

const q = async (sql: string, params: unknown[] = []): Promise<void> => {
  await raw.query(sql, params);
};

const bidAttacks: Attack[] = [
  {
    name: 'editar o valor de um lance do meio',
    run: (c) => q(`UPDATE bids SET amount_cents = $2 WHERE id = $1`, [c.bidIds[2], reais(1)]),
    expected: [
      { code: 'HASH_MISMATCH', seq: 2 },
      { code: 'LEDGER_MISMATCH', seq: 2 },
    ],
  },
  {
    name: 'trocar quem deu o lance',
    run: (c) => q(`UPDATE bids SET bidder_id = $2 WHERE id = $1`, [c.bidIds[2], c.aliceId]),
    expected: [
      { code: 'HASH_MISMATCH', seq: 2 },
      { code: 'LEDGER_MISMATCH', seq: 2 },
    ],
  },
  {
    name: 'mudar o instante do lance',
    run: (c) =>
      q(`UPDATE bids SET placed_at = placed_at + interval '1 second' WHERE id = $1`, [c.bidIds[2]]),
    expected: [{ code: 'HASH_MISMATCH', seq: 2 }],
  },
  {
    name: 'editar o valor do ultimo lance (o vencedor)',
    run: (c) => q(`UPDATE bids SET amount_cents = $2 WHERE id = $1`, [c.bidIds[4], reais(999)]),
    expected: [{ code: 'HASH_MISMATCH', seq: 4 }, { code: 'SUMMARY_MISMATCH' }],
  },
  {
    name: 'editar o prev_hash para "costurar" a cadeia',
    run: (c) => q(`UPDATE bids SET prev_hash = repeat('a', 64) WHERE id = $1`, [c.bidIds[3]]),
    expected: [
      { code: 'PREV_HASH_MISMATCH', seq: 3 },
      { code: 'HASH_MISMATCH', seq: 3 },
    ],
  },
  {
    name: 'trocar os valores de dois lances',
    run: async (c) => {
      await q(`UPDATE bids SET amount_cents = $2 WHERE id = $1`, [c.bidIds[2], reais(110)]);
      await q(`UPDATE bids SET amount_cents = $2 WHERE id = $1`, [c.bidIds[3], reais(105)]);
    },
    expected: [
      { code: 'HASH_MISMATCH', seq: 2 },
      { code: 'HASH_MISMATCH', seq: 3 },
    ],
  },
  {
    name: 'apagar um lance do meio',
    run: (c) => q(`DELETE FROM bids WHERE id = $1`, [c.bidIds[2]]),
    expected: [
      { code: 'SEQ_GAP', seq: 3 },
      { code: 'PREV_HASH_MISMATCH', seq: 3 },
      { code: 'SUMMARY_MISMATCH' },
      { code: 'LEDGER_MISMATCH' },
    ],
  },
  {
    name: 'apagar o primeiro lance',
    run: (c) => q(`DELETE FROM bids WHERE id = $1`, [c.bidIds[1]]),
    expected: [
      { code: 'SEQ_GAP', seq: 2 },
      { code: 'PREV_HASH_MISMATCH', seq: 2 },
    ],
  },
  {
    name: 'apagar o ultimo lance (truncar a cauda)',
    run: (c) => q(`DELETE FROM bids WHERE id = $1`, [c.bidIds[4]]),
    expected: [
      { code: 'HEAD_MISMATCH' },
      { code: 'SUMMARY_MISMATCH' },
      { code: 'LEDGER_MISMATCH' },
    ],
  },
  {
    name: 'apagar todos os lances do lote',
    run: (c) => q(`DELETE FROM bids WHERE lot_id = $1`, [c.lotId]),
    expected: [{ code: 'HEAD_MISMATCH' }, { code: 'SUMMARY_MISMATCH' }],
  },
  {
    name: 'inserir um lance falso no fim com hash inventado',
    run: (c) =>
      q(
        `INSERT INTO bids (id, lot_id, seq, bidder_id, amount_cents, placed_at, prev_hash, hash)
         SELECT $1, $2, 5, $3, $4, now(), (SELECT hash FROM bids WHERE id = $5), repeat('f', 64)`,
        [randomUUID(), c.lotId, c.aliceId, reais(500), c.bidIds[4]],
      ),
    expected: [
      { code: 'HASH_MISMATCH', seq: 5 },
      { code: 'HEAD_MISMATCH' },
      { code: 'SUMMARY_MISMATCH' },
    ],
  },
];

const summaryAndSealAttacks: Attack[] = [
  {
    name: 'editar o valor atual no resumo do lote',
    run: (c) => q(`UPDATE lots SET current_amount_cents = $2 WHERE id = $1`, [c.lotId, reais(1)]),
    expected: [{ code: 'SUMMARY_MISMATCH' }],
  },
  {
    name: 'trocar o lider no resumo do lote',
    run: (c) => q(`UPDATE lots SET leader_id = $2 WHERE id = $1`, [c.lotId, c.aliceId]),
    expected: [{ code: 'SUMMARY_MISMATCH' }],
  },
  {
    name: 'editar a contagem de lances do lote',
    run: (c) => q(`UPDATE lots SET bid_count = 9 WHERE id = $1`, [c.lotId]),
    expected: [{ code: 'SUMMARY_MISMATCH' }],
  },
  {
    name: 'editar o selo do lote',
    run: (c) => q(`UPDATE lots SET seal = repeat('0', 64) WHERE id = $1`, [c.lotId]),
    expected: [{ code: 'SEAL_INVALID' }],
  },
  {
    name: 'editar o hash da cabeca do lote',
    run: (c) => q(`UPDATE lots SET head_hash = repeat('0', 64) WHERE id = $1`, [c.lotId]),
    expected: [{ code: 'SEAL_INVALID' }, { code: 'HEAD_MISMATCH' }],
  },
  {
    name: 'editar o seq da cabeca do lote',
    run: (c) => q(`UPDATE lots SET head_seq = 1 WHERE id = $1`, [c.lotId]),
    expected: [{ code: 'SEAL_INVALID' }, { code: 'HEAD_MISMATCH' }],
  },
  {
    name: 'editar o lance inicial (termo do genesis)',
    run: (c) =>
      q(`UPDATE lots SET starting_bid_cents = starting_bid_cents + 100 WHERE id = $1`, [c.lotId]),
    expected: [{ code: 'PREV_HASH_MISMATCH', seq: 1 }],
  },
  {
    name: 'editar o incremento minimo (termo do genesis)',
    run: (c) =>
      q(`UPDATE lots SET min_increment_cents = min_increment_cents + 100 WHERE id = $1`, [c.lotId]),
    expected: [{ code: 'PREV_HASH_MISMATCH', seq: 1 }],
  },
  {
    name: 'trocar o leiloeiro do lote (termo do genesis)',
    run: (c) => q(`UPDATE lots SET seller_id = $2 WHERE id = $1`, [c.lotId, c.aliceId]),
    expected: [{ code: 'PREV_HASH_MISMATCH', seq: 1 }],
  },
];

const ledgerAttacks: Attack[] = [
  {
    name: 'apagar a reserva (hold) de um lance',
    run: (c) => q(`DELETE FROM wallet_ledger WHERE kind = 'hold' AND bid_id = $1`, [c.bidIds[3]]),
    expected: [{ code: 'LEDGER_MISMATCH', seq: 3 }],
  },
  {
    name: 'editar o valor da reserva de um lance',
    run: (c) =>
      q(
        `UPDATE wallet_ledger SET amount_cents = amount_cents + 1 WHERE kind = 'hold' AND bid_id = $1`,
        [c.bidIds[3]],
      ),
    expected: [{ code: 'LEDGER_MISMATCH', seq: 3 }],
  },
  {
    name: 'trocar de quem e a reserva',
    run: (c) =>
      q(`UPDATE wallet_ledger SET user_id = $2 WHERE kind = 'hold' AND bid_id = $1`, [
        c.bidIds[3],
        c.bobId,
      ]),
    expected: [{ code: 'LEDGER_MISMATCH', seq: 3 }],
  },
  {
    name: 'inserir uma reserva orfa (sem lance)',
    run: (c) =>
      q(
        `INSERT INTO wallet_ledger (user_id, kind, amount_cents, total_after_cents, committed_after_cents, lot_id)
         VALUES ($1, 'hold', 1000, 10000, 1000, $2)`,
        [c.aliceId, c.lotId],
      ),
    expected: [{ code: 'LEDGER_MISMATCH' }],
  },
  {
    name: 'duplicar a reserva de um lance',
    run: (c) =>
      q(
        `INSERT INTO wallet_ledger (user_id, kind, amount_cents, total_after_cents, committed_after_cents, lot_id, bid_id)
         SELECT user_id, kind, amount_cents, total_after_cents, committed_after_cents, lot_id, bid_id
         FROM wallet_ledger WHERE kind = 'hold' AND bid_id = $1`,
        [c.bidIds[2]],
      ),
    expected: [{ code: 'LEDGER_MISMATCH', seq: 2 }],
  },
];

const receiptAttacks: Attack[] = [
  {
    name: 'editar o valor do comprovante',
    run: (c) =>
      q(`UPDATE receipts SET amount_cents = amount_cents - 1 WHERE lot_id = $1`, [c.lotId]),
    expected: [{ code: 'RECEIPT_MISMATCH' }],
  },
  {
    name: 'trocar o vencedor do comprovante',
    run: (c) => q(`UPDATE receipts SET winner_id = $2 WHERE lot_id = $1`, [c.lotId, c.aliceId]),
    expected: [{ code: 'RECEIPT_MISMATCH' }],
  },
  {
    name: 'editar a assinatura do comprovante',
    run: (c) => q(`UPDATE receipts SET signature = repeat('0', 64) WHERE lot_id = $1`, [c.lotId]),
    expected: [{ code: 'RECEIPT_MISMATCH' }],
  },
  {
    name: 'editar o hash final registrado no comprovante',
    run: (c) =>
      q(`UPDATE receipts SET final_head_hash = repeat('0', 64) WHERE lot_id = $1`, [c.lotId]),
    expected: [{ code: 'RECEIPT_MISMATCH' }],
  },
  {
    name: 'editar a contagem de lances do comprovante',
    run: (c) => q(`UPDATE receipts SET bid_count = bid_count + 1 WHERE lot_id = $1`, [c.lotId]),
    expected: [{ code: 'RECEIPT_MISMATCH' }],
  },
  {
    name: 'apagar o comprovante de um lote encerrado com vencedor',
    run: (c) => q(`DELETE FROM receipts WHERE lot_id = $1`, [c.lotId]),
    expected: [{ code: 'RECEIPT_MISSING' }],
  },
  {
    name: 'apagar o ultimo lance DEPOIS do encerramento (reescrever o passado)',
    run: (c) => q(`DELETE FROM bids WHERE id = $1`, [c.bidIds[4]]),
    expected: [{ code: 'HEAD_MISMATCH' }, { code: 'RECEIPT_MISMATCH' }],
  },
];

describe.each([
  ['lances', bidAttacks, 'open'],
  ['resumo, selo e termos do lote', summaryAndSealAttacks, 'open'],
  ['extrato da carteira', ledgerAttacks, 'open'],
  ['comprovante', receiptAttacks, 'closed'],
] as const)('adulteracao direta no banco: %s', (_group, attacks, kind) => {
  it.each(attacks.map((a) => [a.name, a] as const))('detecta: %s', async (_name, attack) => {
    const ctx = kind === 'closed' ? await closedLot() : await openLot();
    await expectIntactNow(ctx.lotId);
    await attack.run(ctx);
    await expectDetected(ctx.lotId, attack.expected);
  });
});

describe('adulteracao em lotes que nao deveriam ter comprovante', () => {
  it('comprovante plantado em lote ABERTO -> RECEIPT_MISMATCH', async () => {
    const ctx = await openLot();
    await expectIntactNow(ctx.lotId);
    await q(
      `INSERT INTO receipts (code, lot_id, winner_id, seller_id, amount_cents, bid_count, final_head_hash, issued_at, signature)
       VALUES ('FAKE0001', $1, $2, $3, 100, 1, repeat('a', 64), now(), repeat('b', 64))`,
      [ctx.lotId, ctx.aliceId, ctx.sellerId],
    );
    await expectDetected(ctx.lotId, [{ code: 'RECEIPT_MISMATCH' }]);
  });

  it('comprovante plantado em lote CANCELADO -> RECEIPT_MISMATCH', async () => {
    const ctx = await openLot();
    await h.cancelLot.execute({ id: ctx.sellerId, role: 'seller' }, ctx.lotId);
    await expectIntactNow(ctx.lotId);
    await q(
      `INSERT INTO receipts (code, lot_id, winner_id, seller_id, amount_cents, bid_count, final_head_hash, issued_at, signature)
       VALUES ('FAKE0002', $1, $2, $3, 100, 1, repeat('a', 64), now(), repeat('b', 64))`,
      [ctx.lotId, ctx.aliceId, ctx.sellerId],
    );
    await expectDetected(ctx.lotId, [{ code: 'RECEIPT_MISMATCH' }]);
  });
});

describe('o atacante NAO tem a chave: reescrever tudo de forma consistente tambem e detectado', () => {
  const wrongMac = createMac('chave-errada-do-atacante-0123456789abcdef0123');

  it('refaz hash, selo, resumo e extrato do ultimo lance com a chave errada', async () => {
    const ctx = await openLot();
    await expectIntactNow(ctx.lotId);

    const { rows } = await db.pool.query<{ placed_at: Date; prev_hash: string }>(
      `SELECT placed_at, prev_hash FROM bids WHERE id = $1`,
      [ctx.bidIds[4]],
    );
    const original = rows[0];
    if (original === undefined) throw new Error('lance 4 inexistente');
    const forged = {
      seq: 4,
      bidderId: ctx.bobId,
      amount: cents(reais(1)),
      placedAt: original.placed_at,
    };
    const forgedHash = computeBidHash(wrongMac, ctx.lotId, forged, original.prev_hash);

    await q(`UPDATE bids SET amount_cents = $2, hash = $3 WHERE id = $1`, [
      ctx.bidIds[4],
      forged.amount,
      forgedHash,
    ]);
    await q(`UPDATE wallet_ledger SET amount_cents = $2 WHERE kind = 'hold' AND bid_id = $1`, [
      ctx.bidIds[4],
      forged.amount,
    ]);
    await q(`UPDATE lots SET current_amount_cents = $2, head_hash = $3, seal = $4 WHERE id = $1`, [
      ctx.lotId,
      forged.amount,
      forgedHash,
      computeSeal(wrongMac, ctx.lotId, 4, forgedHash),
    ]);

    // Resumo, extrato e selo agora "batem entre si", mas nada disso foi assinado com a chave real.
    await expectDetected(ctx.lotId, [{ code: 'HASH_MISMATCH', seq: 4 }, { code: 'SEAL_INVALID' }]);
  });

  it('forja um comprovante inteiro (valor e assinatura) com a chave errada', async () => {
    const ctx = await closedLot();
    await expectIntactNow(ctx.lotId);
    const { rows } = await db.pool.query(`SELECT * FROM receipts WHERE lot_id = $1`, [ctx.lotId]);
    const r = rows[0];
    const facts = {
      code: r.code as string,
      lotId: ctx.lotId,
      sellerId: r.seller_id as string,
      winnerId: r.winner_id as string,
      amount: cents(1),
      bidCount: r.bid_count as number,
      finalHeadHash: r.final_head_hash as string,
      issuedAt: r.issued_at as Date,
    };
    await q(`UPDATE receipts SET amount_cents = 1, signature = $2 WHERE lot_id = $1`, [
      ctx.lotId,
      computeReceiptSignature(wrongMac, facts),
    ]);
    await expectDetected(ctx.lotId, [{ code: 'RECEIPT_MISMATCH' }]);
  });
});

describe('a auditoria nunca vaza dado pessoal, nem sob adulteracao', () => {
  it('o relatorio de um lote adulterado so tem referencias anonimas', async () => {
    const ctx = await openLot();
    await q(`UPDATE bids SET amount_cents = 1 WHERE id = $1`, [ctx.bidIds[2]]);
    const json = JSON.stringify(await h.audit.execute(ctx.lotId));
    for (const secret of [ctx.aliceId, ctx.bobId, ctx.sellerId, 'teste.local', 'password']) {
      expect(json).not.toContain(secret);
    }
  });
});

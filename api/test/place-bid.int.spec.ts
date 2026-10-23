import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlaceBid } from '../src/application/usecases/place-bid.js';
import type { Actor, UnitOfWork } from '../src/application/ports.js';
import { cryptoIds } from '../src/adapters/outbound/system.js';
import { HOUR, MIN, createHarness, reais } from './support/harness.js';
import type { Harness } from './support/harness.js';
import { RecordingBus } from './support/harness.js';
import { createTestDb } from './support/test-db.js';
import type { TestDb } from './support/test-db.js';

let db: TestDb;
let h: Harness;

beforeAll(async () => {
  db = await createTestDb();
  h = createHarness(db);
});

afterAll(async () => {
  await h.assertInvariants();
  await db.close();
});

async function scenario(
  opts: { funds?: number; startingBid?: number; minIncrement?: number } = {},
) {
  const seller = await h.seedUser('seller');
  const alice = await h.seedUser('bidder', 'alice');
  const bob = await h.seedUser('bidder', 'bob');
  await h.fund(alice, opts.funds ?? reais(10_000));
  await h.fund(bob, opts.funds ?? reais(10_000));
  const lot = await h.newLot(seller, {
    startingBid: opts.startingBid ?? reais(100),
    minIncrement: opts.minIncrement ?? reais(5),
  });
  return { seller, alice, bob, lot };
}

const bid = (actor: Actor, lotId: string, amount: unknown, idempotencyKey?: string) =>
  h.placeBid.execute({
    actor,
    lotId,
    amount,
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  });

describe('fluxo feliz', () => {
  it('primeiro lance igual ao inicial: aceito, compromete o valor e vira lider', async () => {
    const { alice, lot } = await scenario();
    const r = await bid(alice, lot.id, reais(100));
    expect(r).toMatchObject({ accepted: true, replayed: false, extended: false, bidCount: 1 });
    expect(r.accepted && r.bid.seq).toBe(1);

    expect(await h.walletOf(alice.id)).toEqual({
      total: reais(10_000),
      committed: reais(100),
      available: reais(9_900),
    });
    const row = await h.lotRow(lot.id);
    expect(row.leader_id).toBe(alice.id);
    expect(Number(row.current_amount_cents)).toBe(reais(100));
    expect(row.bid_count).toBe(1);
  });

  it('ser superado devolve o valor ao disponivel IMEDIATAMENTE; o novo lider compromete', async () => {
    const { alice, bob, lot } = await scenario();
    await bid(alice, lot.id, reais(100));
    expect((await h.walletOf(alice.id)).committed).toBe(reais(100));

    const r = await bid(bob, lot.id, reais(105));
    expect(r.accepted).toBe(true);
    expect(await h.walletOf(alice.id)).toMatchObject({ committed: 0, available: reais(10_000) });
    expect(await h.walletOf(bob.id)).toMatchObject({ committed: reais(105) });
  });

  it('quem foi superado pode voltar a liderar; o comprometido acompanha sem vazar', async () => {
    const { alice, bob, lot } = await scenario();
    await bid(alice, lot.id, reais(100));
    await bid(bob, lot.id, reais(105));
    await bid(alice, lot.id, reais(110));
    await bid(bob, lot.id, reais(200));
    await bid(alice, lot.id, reais(300));
    expect(await h.walletOf(alice.id)).toMatchObject({ committed: reais(300) });
    expect(await h.walletOf(bob.id)).toMatchObject({ committed: 0 });
  });

  it('a cadeia de hash fica integra e o extrato tem hold e release nas horas certas', async () => {
    const { alice, bob, lot } = await scenario();
    for (let i = 0; i < 6; i++) {
      await bid(i % 2 === 0 ? alice : bob, lot.id, reais(100 + i * 5));
    }
    const report = await h.audit.execute(lot.id);
    expect(report.integrity).toEqual({ intact: true, issues: [] });
    expect(report.bidCount).toBe(6);
    const { rows } = await db.pool.query<{ kind: string }>(
      `SELECT kind FROM wallet_ledger WHERE lot_id = $1 ORDER BY id`,
      [lot.id],
    );
    expect(rows.map((r) => r.kind)).toEqual([
      'hold', // 1o lance
      'release',
      'hold', // superado + novo
      'release',
      'hold',
      'release',
      'hold',
      'release',
      'hold',
      'release',
      'hold',
    ]);
  });

  it('publica evento bid_placed DEPOIS do commit, com o lider anterior', async () => {
    const { alice, bob, lot } = await scenario();
    const before = h.events.ofType('bid_placed').length;
    await bid(alice, lot.id, reais(100));
    await bid(bob, lot.id, reais(105));
    const events = h.events.ofType('bid_placed').slice(before);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ seq: 1, previousLeaderId: null, bidderId: alice.id });
    expect(events[1]).toMatchObject({ seq: 2, previousLeaderId: alice.id, bidderId: bob.id });
  });
});

describe('recusas: cada motivo do enunciado, sem efeito colateral', () => {
  async function snapshot(lotId: string, ...users: Actor[]) {
    const wallets = await Promise.all(users.map((u) => h.walletOf(u.id)));
    const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM bids WHERE lot_id = $1`, [
      lotId,
    ]);
    const ledger = await db.pool.query(`SELECT count(*)::int AS n FROM wallet_ledger`);
    return { wallets, bids: rows[0].n, ledger: ledger.rows[0].n, lot: await h.lotRow(lotId) };
  }

  it('abaixo do inicial -> BELOW_MINIMUM com o minimo exigido', async () => {
    const { alice, lot } = await scenario();
    const before = await snapshot(lot.id, alice);
    const eventsBefore = h.events.events.length;
    expect(await bid(alice, lot.id, reais(99))).toEqual({
      accepted: false,
      reason: 'BELOW_MINIMUM',
      minimumRequired: reais(100),
    });
    expect(await snapshot(lot.id, alice)).toEqual(before);
    expect(h.events.events).toHaveLength(eventsBefore);
  });

  it('abaixo de atual + incremento -> BELOW_MINIMUM', async () => {
    const { alice, bob, lot } = await scenario();
    await bid(alice, lot.id, reais(100));
    expect(await bid(bob, lot.id, reais(104))).toMatchObject({
      accepted: false,
      reason: 'BELOW_MINIMUM',
      minimumRequired: reais(105),
    });
  });

  it('lider cobrindo o proprio lance -> ALREADY_LEADING, nada muda', async () => {
    const { alice, lot } = await scenario();
    await bid(alice, lot.id, reais(100));
    const before = await snapshot(lot.id, alice);
    expect(await bid(alice, lot.id, reais(500))).toMatchObject({
      accepted: false,
      reason: 'ALREADY_LEADING',
    });
    expect(await snapshot(lot.id, alice)).toEqual(before);
  });

  it('saldo insuficiente -> INSUFFICIENT_FUNDS com o disponivel', async () => {
    const { alice, lot } = await scenario({ funds: reais(150) });
    expect(await bid(alice, lot.id, reais(200))).toEqual({
      accepted: false,
      reason: 'INSUFFICIENT_FUNDS',
      available: reais(150),
    });
  });

  it('o disponivel considera o que ja esta comprometido em OUTRO lote', async () => {
    const { seller, alice } = await scenario({ funds: reais(150) });
    const lotA = await h.newLot(seller, { startingBid: reais(100) });
    const lotB = await h.newLot(seller, { startingBid: reais(100) });
    expect((await bid(alice, lotA.id, reais(100))).accepted).toBe(true);
    expect(await bid(alice, lotB.id, reais(100))).toMatchObject({
      accepted: false,
      reason: 'INSUFFICIENT_FUNDS',
      available: reais(50),
    });
  });

  it('lote agendado -> LOT_NOT_STARTED', async () => {
    const { seller, alice } = await scenario();
    const future = await h.newLot(seller, { startInMs: 10 * MIN });
    expect(await bid(alice, future.id, reais(100))).toMatchObject({
      accepted: false,
      reason: 'LOT_NOT_STARTED',
    });
  });

  it('leiloeiro nao da lance (no proprio nem em outro lote) -> SELLER_CANNOT_BID', async () => {
    const { seller, lot } = await scenario();
    const otherSeller = await h.seedUser('seller');
    await h.fund(seller, reais(1_000)).catch(() => undefined); // leiloeiro nem deposita
    expect(await bid(seller, lot.id, reais(100))).toMatchObject({
      accepted: false,
      reason: 'SELLER_CANNOT_BID',
    });
    expect(await bid(otherSeller, lot.id, reais(100))).toMatchObject({
      accepted: false,
      reason: 'SELLER_CANNOT_BID',
    });
  });

  it('lote cancelado -> LOT_CANCELLED', async () => {
    const { seller, alice, lot } = await scenario();
    await h.cancelLot.execute(seller, lot.id);
    expect(await bid(alice, lot.id, reais(100))).toMatchObject({
      accepted: false,
      reason: 'LOT_CANCELLED',
    });
  });

  it('lote encerrado -> LOT_ENDED, e a liquidacao acontece na hora (leitura preguicosa)', async () => {
    const { alice, bob, lot } = await scenario();
    await bid(alice, lot.id, reais(100));
    h.clock.advance(HOUR + 1);

    expect(await bid(bob, lot.id, reais(500))).toMatchObject({
      accepted: false,
      reason: 'LOT_ENDED',
    });

    const row = await h.lotRow(lot.id);
    expect(row.status).toBe('closed');
    // alice ganhou e foi debitada; bob nao foi tocado
    expect(await h.walletOf(alice.id)).toMatchObject({ total: reais(9_900), committed: 0 });
    expect(await h.walletOf(bob.id)).toMatchObject({ total: reais(10_000), committed: 0 });
    expect(h.events.ofType('lot_closed').some((e) => e.lotId === lot.id && e.sold)).toBe(true);
    h.clock.advance(-(HOUR + 1));
  });

  it('exatamente no instante do fim ja nao aceita (intervalo aberto a direita)', async () => {
    const { alice, lot } = await scenario();
    h.clock.set(lot.endsAt);
    expect(await bid(alice, lot.id, reais(100))).toMatchObject({
      accepted: false,
      reason: 'LOT_ENDED',
    });
    h.clock.advance(-HOUR);
  });
});

describe('anti-sniping (+2 min nos ultimos 2 min; novo fim = instante do lance + 2 min)', () => {
  it('lance fora da janela nao prorroga', async () => {
    const { alice, lot } = await scenario();
    h.clock.set(new Date(lot.endsAt.getTime() - 5 * MIN));
    const r = await bid(alice, lot.id, reais(100));
    expect(r).toMatchObject({ accepted: true, extended: false });
    expect(new Date((await h.lotRow(lot.id)).ends_at as Date).getTime()).toBe(lot.endsAt.getTime());
    h.clock.set(new Date(lot.startsAt));
  });

  it('lance nos ultimos 2 min estende para instante + 2 min e persiste', async () => {
    const { alice, lot } = await scenario();
    const at = new Date(lot.endsAt.getTime() - 30_000);
    h.clock.set(at);
    const r = await bid(alice, lot.id, reais(100));
    expect(r).toMatchObject({ accepted: true, extended: true });
    const row = await h.lotRow(lot.id);
    expect(new Date(row.ends_at as Date).getTime()).toBe(at.getTime() + 2 * MIN);
    expect(row.extension_count).toBe(1);
    expect(h.events.ofType('bid_placed').at(-1)).toMatchObject({ extended: true });
    h.clock.set(new Date(lot.startsAt));
  });

  it('prorrogacoes encadeadas: cada lance perto do fim empurra o fim de novo', async () => {
    const { alice, bob, lot } = await scenario();
    let now = new Date(lot.endsAt.getTime() - 60_000);
    h.clock.set(now);
    await bid(alice, lot.id, reais(100));
    for (let i = 0; i < 4; i++) {
      now = new Date(now.getTime() + 90_000); // sempre dentro dos 2 min finais do fim atual
      h.clock.set(now);
      const r = await bid(i % 2 === 0 ? bob : alice, lot.id, reais(105 + i * 5));
      expect(r).toMatchObject({ accepted: true, extended: true });
    }
    const row = await h.lotRow(lot.id);
    expect(row.extension_count).toBe(5);
    expect(new Date(row.ends_at as Date).getTime()).toBe(now.getTime() + 2 * MIN);
    h.clock.set(new Date(lot.startsAt));
  });

  it('lance recusado nunca prorroga', async () => {
    const { alice, lot } = await scenario();
    h.clock.set(new Date(lot.endsAt.getTime() - 30_000));
    await bid(alice, lot.id, reais(1)); // abaixo do minimo
    expect(new Date((await h.lotRow(lot.id)).ends_at as Date).getTime()).toBe(lot.endsAt.getTime());
    h.clock.set(new Date(lot.startsAt));
  });
});

describe('idempotencia do lance (Idempotency-Key)', () => {
  it('mesma chave duas vezes: um unico lance, segunda resposta e replay', async () => {
    const { alice, lot } = await scenario();
    const first = await bid(alice, lot.id, reais(100), 'chave-estavel-0001');
    const second = await bid(alice, lot.id, reais(100), 'chave-estavel-0001');
    expect(first).toMatchObject({ accepted: true, replayed: false });
    expect(second).toMatchObject({ accepted: true, replayed: true });
    expect(first.accepted && second.accepted && first.bid.id).toBe(
      second.accepted && second.bid.id,
    );
    expect((await h.walletOf(alice.id)).committed).toBe(reais(100)); // comprometeu UMA vez
    const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM bids WHERE lot_id = $1`, [
      lot.id,
    ]);
    expect(rows[0].n).toBe(1);
  });

  it('replay nao republica evento', async () => {
    const { alice, lot } = await scenario();
    await bid(alice, lot.id, reais(100), 'chave-estavel-0002');
    const n = h.events.events.length;
    await bid(alice, lot.id, reais(100), 'chave-estavel-0002');
    expect(h.events.events).toHaveLength(n);
  });

  it('mesma chave com OUTRO valor -> IDEMPOTENCY_KEY_REUSED', async () => {
    const { alice, lot } = await scenario();
    await bid(alice, lot.id, reais(100), 'chave-estavel-0003');
    await expect(bid(alice, lot.id, reais(200), 'chave-estavel-0003')).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  });

  it('mesma chave em OUTRO lote -> IDEMPOTENCY_KEY_REUSED', async () => {
    const { seller, alice, lot } = await scenario();
    const other = await h.newLot(seller);
    await bid(alice, lot.id, reais(100), 'chave-estavel-0004');
    await expect(bid(alice, other.id, reais(100), 'chave-estavel-0004')).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  });

  it('chaves de pessoas diferentes nao colidem', async () => {
    const { alice, bob, lot } = await scenario();
    expect((await bid(alice, lot.id, reais(100), 'mesma-chave-vinda-de-2')).accepted).toBe(true);
    const r = await bid(bob, lot.id, reais(105), 'mesma-chave-vinda-de-2');
    expect(r).toMatchObject({ accepted: true, replayed: false });
  });
});

describe('entrada hostil', () => {
  const invalidAmounts: [string, unknown][] = [
    ['string numerica', '100'],
    ['decimal', 100.5],
    ['negativo', -100],
    ['zero', 0],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['acima de 2^53', 2 ** 53],
    ['acima do teto da carteira', 10_000_000_01 * 100],
    ['null', null],
    ['undefined', undefined],
    ['objeto', { $gt: 0 }],
    ['array', [100]],
    ['booleano', true],
  ];
  it.each(invalidAmounts)('valor invalido (%s) -> VALIDATION_ERROR', async (_n, value) => {
    const { alice, lot } = await scenario();
    await expect(bid(alice, lot.id, value)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it.each([
    ['abc'],
    [''],
    ["' OR 1=1 --"],
    ['00000000-0000-0000-0000-00000000000'],
    ['../../etc/passwd'],
    [undefined],
    [42],
  ])('id de lote invalido (%s) -> LOT_NOT_FOUND (nunca erro de banco)', async (id) => {
    const { alice } = await scenario();
    await expect(bid(alice, id as string, reais(100))).rejects.toMatchObject({
      code: 'LOT_NOT_FOUND',
    });
  });

  it('lote inexistente (UUID valido) -> LOT_NOT_FOUND', async () => {
    const { alice } = await scenario();
    await expect(
      bid(alice, '11111111-1111-4111-8111-111111111111', reais(100)),
    ).rejects.toMatchObject({ code: 'LOT_NOT_FOUND' });
  });

  it.each([['curta'], ['tem espaco na chave 123'], ['a'.repeat(101)], ['chave;DROP TABLE bids']])(
    'Idempotency-Key invalida (%s) -> VALIDATION_ERROR',
    async (key) => {
      const { alice, lot } = await scenario();
      await expect(bid(alice, lot.id, reais(100), key)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    },
  );
});

describe('atomicidade: falha no meio da transacao nao deixa nada para tras', () => {
  it('erro depois de inserir o lance desfaz lance, carteira, extrato e lote', async () => {
    const { alice, lot } = await scenario();
    const before = {
      wallet: await h.walletOf(alice.id),
      lot: await h.lotRow(lot.id),
      bids: (await db.pool.query(`SELECT count(*)::int AS n FROM bids WHERE lot_id = $1`, [lot.id]))
        .rows[0].n,
    };

    const sabotaged: UnitOfWork = {
      readSnapshot: (w) => db.uow.readSnapshot(w),
      run: (work) =>
        db.uow.run((repos) =>
          work({
            ...repos,
            wallets: {
              lock: (id) => repos.wallets.lock(id),
              save: (w) => repos.wallets.save(w),
              findLedgerByKey: (u, k) => repos.wallets.findLedgerByKey(u, k),
              ledgerByLot: (l) => repos.wallets.ledgerByLot(l),
              appendLedger: () => Promise.reject(new Error('falha simulada no extrato')),
            },
          }),
        ),
    };
    const broken = new PlaceBid({
      uow: sabotaged,
      clock: h.clock,
      mac: h.mac,
      ids: cryptoIds,
      events: new RecordingBus(),
    });

    await expect(
      broken.execute({ actor: alice, lotId: lot.id, amount: reais(100) }),
    ).rejects.toThrow('falha simulada');

    expect(await h.walletOf(alice.id)).toEqual(before.wallet);
    expect(await h.lotRow(lot.id)).toEqual(before.lot);
    const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM bids WHERE lot_id = $1`, [
      lot.id,
    ]);
    expect(rows[0].n).toBe(before.bids);
  });
});

describe('integridade: nao empilha lance sobre historico adulterado', () => {
  it('selo do lote editado por fora -> INTEGRITY_VIOLATION e nada muda', async () => {
    const { alice, bob, lot } = await scenario();
    await bid(alice, lot.id, reais(100));

    const original = (await h.lotRow(lot.id)).head_hash as string;
    const raw = await db.rawClient();
    await raw.query(`SET session_replication_role = replica`); // superusuario ignora triggers
    await raw.query(`UPDATE lots SET head_hash = repeat('0', 64) WHERE id = $1`, [lot.id]);

    const walletBefore = await h.walletOf(bob.id);
    await expect(bid(bob, lot.id, reais(105))).rejects.toMatchObject({
      code: 'INTEGRITY_VIOLATION',
    });
    expect(await h.walletOf(bob.id)).toEqual(walletBefore);

    const report = await h.audit.execute(lot.id);
    expect(report.integrity.intact).toBe(false);

    // Desfaz a adulteracao: o lote volta a ser auditavel como integro (e prova que o
    // sistema se recupera quando o historico volta ao que era).
    await raw.query(`UPDATE lots SET head_hash = $2 WHERE id = $1`, [lot.id, original]);
    expect((await h.audit.execute(lot.id)).integrity.intact).toBe(true);
    expect((await bid(bob, lot.id, reais(105))).accepted).toBe(true);
  });
});

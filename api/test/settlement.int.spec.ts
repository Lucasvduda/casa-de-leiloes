import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../src/application/ports.js';
import { SettleLot } from '../src/application/usecases/settle-lot.js';
import { HOUR, MIN, createHarness, reais } from './support/harness.js';
import type { Harness } from './support/harness.js';
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

async function scenario(funds = reais(10_000)) {
  const seller = await h.seedUser('seller');
  const alice = await h.seedUser('bidder', 'alice');
  const bob = await h.seedUser('bidder', 'bob');
  await h.fund(alice, funds);
  await h.fund(bob, funds);
  const lot = await h.newLot(seller);
  return { seller, alice, bob, lot };
}

const bid = (actor: Actor, lotId: string, amount: number) =>
  h.placeBid.execute({ actor, lotId, amount });

async function drainDue(): Promise<void> {
  const { failed } = await h.settleLot.settleDue(1_000);
  expect(failed).toEqual([]);
}

const ledgerOf = async (userId: string, lotId: string) =>
  (
    await db.pool.query<{ kind: string; amount_cents: string }>(
      `SELECT kind, amount_cents FROM wallet_ledger WHERE user_id = $1 AND lot_id = $2 ORDER BY id`,
      [userId, lotId],
    )
  ).rows.map((r) => ({ kind: r.kind, amount: Number(r.amount_cents) }));

describe('liquidacao: lote com vencedor', () => {
  it('debita o vencedor, credita o leiloeiro, emite comprovante e fecha o lote', async () => {
    const { seller, alice, bob, lot } = await scenario();
    await bid(alice, lot.id, reais(100));
    await bid(bob, lot.id, reais(150));
    h.clock.advance(HOUR);

    const out = await h.settleLot.execute(lot.id);
    expect(out.kind).toBe('sold');

    expect(await h.walletOf(bob.id)).toEqual({
      total: reais(10_000) - reais(150),
      committed: 0,
      available: reais(10_000) - reais(150),
    });
    expect(await h.walletOf(seller.id)).toEqual({
      total: reais(150),
      committed: 0,
      available: reais(150),
    });
    // quem perdeu nao paga nada
    expect(await h.walletOf(alice.id)).toEqual({
      total: reais(10_000),
      committed: 0,
      available: reais(10_000),
    });

    const row = await h.lotRow(lot.id);
    expect(row.status).toBe('closed');
    expect(row.closed_at).not.toBeNull();
  });

  it('o extrato do vencedor e do leiloeiro tem exatamente as linhas esperadas', async () => {
    const { seller, bob, lot } = await scenario();
    await bid(bob, lot.id, reais(120));
    h.clock.advance(HOUR);
    await h.settleLot.execute(lot.id);

    expect(await ledgerOf(bob.id, lot.id)).toEqual([
      { kind: 'hold', amount: reais(120) },
      { kind: 'settle_debit', amount: reais(120) },
    ]);
    expect(await ledgerOf(seller.id, lot.id)).toEqual([
      { kind: 'settle_credit', amount: reais(120) },
    ]);
  });

  it('o comprovante tem assinatura valida, amarra o valor, o vencedor e a cadeia, e a auditoria segue integra', async () => {
    const { alice, bob, lot } = await scenario();
    await bid(alice, lot.id, reais(100));
    await bid(bob, lot.id, reais(105));
    h.clock.advance(HOUR);
    const out = await h.settleLot.execute(lot.id);
    if (out.kind !== 'sold') throw new Error('esperava venda');

    expect(out.receipt).toMatchObject({ amount: reais(105), bidCount: 2, winnerId: bob.id });
    const report = await h.audit.execute(lot.id);
    expect(report.integrity).toEqual({ intact: true, issues: [] });
    expect(report.receipt).toMatchObject({
      code: out.receipt.code,
      amount: reais(105),
      signatureValid: true,
    });
    expect(report.receipt?.winner).toMatch(/^Licitante #[0-9a-f]{8}$/);
    // privacidade: o comprovante publico nunca expoe o id interno do vencedor
    expect(JSON.stringify(report)).not.toContain(bob.id);
    expect(report.headHash).toBe(out.receipt.finalHeadHash);
  });

  it('o vencedor so paga o ultimo lance, nao a soma dos que deu', async () => {
    const { alice, bob, lot } = await scenario();
    await bid(alice, lot.id, reais(100));
    await bid(bob, lot.id, reais(105));
    await bid(alice, lot.id, reais(110));
    await bid(bob, lot.id, reais(115));
    await bid(alice, lot.id, reais(120));
    h.clock.advance(HOUR);
    await h.settleLot.execute(lot.id);
    expect((await h.walletOf(alice.id)).total).toBe(reais(10_000) - reais(120));
    expect((await h.walletOf(bob.id)).total).toBe(reais(10_000));
  });

  it('o comprometido em OUTRO lote nao e tocado pela liquidacao', async () => {
    const { seller, alice, lot } = await scenario();
    const other = await h.newLot(seller, { durationMs: 5 * HOUR });
    await bid(alice, lot.id, reais(100));
    await bid(alice, other.id, reais(200));
    h.clock.advance(HOUR);
    await h.settleLot.execute(lot.id);
    expect(await h.walletOf(alice.id)).toMatchObject({
      total: reais(10_000) - reais(100),
      committed: reais(200),
    });
  });

  it('o leiloeiro que recebeu a venda continua sem poder dar lance, mesmo com saldo', async () => {
    const { seller, alice, lot } = await scenario();
    await bid(alice, lot.id, reais(100));
    h.clock.advance(HOUR);
    await h.settleLot.execute(lot.id);
    const another = await h.seedUser('seller');
    const lot2 = await h.newLot(another);
    // o papel e fixo: ter saldo de venda nao transforma leiloeiro em comprador
    expect(await bid(seller, lot2.id, reais(100))).toMatchObject({
      accepted: false,
      reason: 'SELLER_CANNOT_BID',
    });
  });

  it('publica lot_closed com sold=true', async () => {
    const { alice, lot } = await scenario();
    await bid(alice, lot.id, reais(100));
    h.clock.advance(HOUR);
    const before = h.events.ofType('lot_closed').length;
    await h.settleLot.execute(lot.id);
    const events = h.events.ofType('lot_closed');
    expect(events).toHaveLength(before + 1);
    expect(events[events.length - 1]).toMatchObject({ lotId: lot.id, sold: true });
  });
});

describe('liquidacao: lote sem lances', () => {
  it('fecha sem vencedor, sem comprovante e sem mexer em nenhuma carteira', async () => {
    const { seller, alice, lot } = await scenario();
    h.clock.advance(HOUR);
    const out = await h.settleLot.execute(lot.id);
    expect(out.kind).toBe('closed_no_winner');

    const row = await h.lotRow(lot.id);
    expect(row.status).toBe('closed');
    expect(row.leader_id).toBeNull();
    const receipts = await db.pool.query(`SELECT 1 FROM receipts WHERE lot_id = $1`, [lot.id]);
    expect(receipts.rowCount).toBe(0);
    expect(await ledgerOf(seller.id, lot.id)).toEqual([]);
    expect(await h.walletOf(alice.id)).toMatchObject({ total: reais(10_000), committed: 0 });

    const report = await h.audit.execute(lot.id);
    expect(report.integrity.intact).toBe(true);
    expect(report.receipt).toBeNull();
    expect(report.bidCount).toBe(0);
  });

  it('publica lot_closed com sold=false', async () => {
    const { lot } = await scenario();
    h.clock.advance(HOUR);
    await h.settleLot.execute(lot.id);
    const events = h.events.ofType('lot_closed');
    expect(events[events.length - 1]).toMatchObject({ lotId: lot.id, sold: false });
  });
});

describe('liquidacao: momento certo', () => {
  it('antes do fim -> not_due, nada muda', async () => {
    const { alice, lot } = await scenario();
    await bid(alice, lot.id, reais(100));
    h.clock.advance(HOUR - 1);
    expect(await h.settleLot.execute(lot.id)).toEqual({ kind: 'not_due' });
    expect((await h.lotRow(lot.id)).status).toBe('open');
    expect((await h.walletOf(alice.id)).committed).toBe(reais(100));
  });

  it('exatamente no instante do fim ja liquida (mesma fronteira do lance: [inicio, fim))', async () => {
    const { alice, lot } = await scenario();
    await bid(alice, lot.id, reais(100));
    h.clock.advance(HOUR);
    expect((await h.settleLot.execute(lot.id)).kind).toBe('sold');
  });

  it('lote prorrogado pelo anti-sniping NAO liquida no fim original', async () => {
    const { alice, bob, lot } = await scenario();
    await bid(alice, lot.id, reais(100));
    h.clock.advance(HOUR - MIN); // 1 min antes do fim
    const r = await bid(bob, lot.id, reais(105));
    expect(r).toMatchObject({ accepted: true, extended: true });

    h.clock.advance(MIN); // chegou o fim ORIGINAL
    expect(await h.settleLot.execute(lot.id)).toEqual({ kind: 'not_due' });
    h.clock.advance(MIN); // chegou o novo fim (lance + 2 min)
    expect((await h.settleLot.execute(lot.id)).kind).toBe('sold');
  });

  it('lote inexistente / id invalido -> LOT_NOT_FOUND', async () => {
    await expect(h.settleLot.execute('11111111-1111-4111-8111-111111111111')).rejects.toMatchObject(
      {
        code: 'LOT_NOT_FOUND',
      },
    );
    await expect(h.settleLot.execute("' OR 1=1 --")).rejects.toMatchObject({
      code: 'LOT_NOT_FOUND',
    });
  });
});

describe('liquidacao: idempotencia (nunca paga duas vezes)', () => {
  it('liquidar de novo devolve already_final e nao move dinheiro', async () => {
    const { seller, bob, lot } = await scenario();
    await bid(bob, lot.id, reais(130));
    h.clock.advance(HOUR);
    await h.settleLot.execute(lot.id);
    const sellerBefore = await h.walletOf(seller.id);
    const bobBefore = await h.walletOf(bob.id);

    expect(await h.settleLot.execute(lot.id)).toEqual({ kind: 'already_final', status: 'closed' });
    expect(await h.walletOf(seller.id)).toEqual(sellerBefore);
    expect(await h.walletOf(bob.id)).toEqual(bobBefore);
    const receipts = await db.pool.query(`SELECT 1 FROM receipts WHERE lot_id = $1`, [lot.id]);
    expect(receipts.rowCount).toBe(1);
  });

  it('20 liquidacoes em paralelo: exatamente uma vende, o leiloeiro recebe UMA vez', async () => {
    const { seller, bob, lot } = await scenario();
    await bid(bob, lot.id, reais(130));
    h.clock.advance(HOUR);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => h.settleLot.execute(lot.id)),
    );
    expect(results.filter((r) => r.kind === 'sold')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'already_final')).toHaveLength(19);
    expect((await h.walletOf(seller.id)).total).toBe(reais(130));
    expect(await ledgerOf(seller.id, lot.id)).toEqual([
      { kind: 'settle_credit', amount: reais(130) },
    ]);
  });
});

describe('agendador: settleDue', () => {
  it('liquida so os vencidos, respeita o limite e ignora lotes ja finalizados', async () => {
    await drainDue(); // o banco e compartilhado no arquivo: parte-se de uma fila de vencidos vazia
    const seller = await h.seedUser('seller');
    const bidder = await h.seedUser('bidder');
    await h.fund(bidder, reais(50_000));
    const due1 = await h.newLot(seller, { durationMs: 10 * MIN });
    const due2 = await h.newLot(seller, { durationMs: 10 * MIN });
    const later = await h.newLot(seller, { durationMs: 10 * HOUR });
    await bid(bidder, due1.id, reais(100));
    await bid(bidder, later.id, reais(100));

    h.clock.advance(11 * MIN);
    const first = await h.settleLot.settleDue(1);
    expect(first.settled).toBe(1);
    const second = await h.settleLot.settleDue(50);
    expect(second.settled).toBe(1); // o outro vencido; `later` continua aberto
    expect(second.failed).toEqual([]);

    expect((await h.lotRow(due1.id)).status).toBe('closed');
    expect((await h.lotRow(due2.id)).status).toBe('closed');
    expect((await h.lotRow(later.id)).status).toBe('open');

    expect(await h.settleLot.settleDue(50)).toEqual({ settled: 0, failed: [] });
  });

  it('lote com historico adulterado NAO derruba os outros: falha isolada e reportada', async () => {
    await drainDue();
    const seller = await h.seedUser('seller');
    const bidder = await h.seedUser('bidder');
    await h.fund(bidder, reais(50_000));
    const bad = await h.newLot(seller, { durationMs: 10 * MIN });
    const good = await h.newLot(seller, { durationMs: 10 * MIN });
    await bid(bidder, bad.id, reais(100));
    await bid(bidder, good.id, reais(100));

    const raw = await db.rawClient();
    await raw.query(`SET session_replication_role = replica`);
    await raw.query(`UPDATE bids SET amount_cents = 1 WHERE lot_id = $1`, [bad.id]);

    h.clock.advance(11 * MIN);
    const result = await h.settleLot.settleDue(50);
    expect(result.settled).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.lotId).toBe(bad.id);
    expect(result.failed[0]?.error).toMatchObject({ code: 'INTEGRITY_VIOLATION' });
    expect((await h.lotRow(good.id)).status).toBe('closed');
    expect((await h.lotRow(bad.id)).status).toBe('open');

    // desfaz a adulteracao: o lote volta a poder ser liquidado normalmente
    await raw.query(`UPDATE bids SET amount_cents = $2 WHERE lot_id = $1`, [bad.id, reais(100)]);
    // Em quarentena: reparar nao basta, o lote so volta a ser tentado depois do periodo.
    expect(await h.settleLot.settleDue(50)).toEqual({ settled: 0, failed: [] });
    expect((await h.lotRow(bad.id)).status).toBe('open');
    h.clock.advance(6 * MIN);
    expect((await h.settleLot.settleDue(50)).settled).toBe(1);
    expect((await h.lotRow(bad.id)).status).toBe('closed');
  });

  it('lote que falhou fica em quarentena: nao e reprocessado e nao ocupa a fila dos demais', async () => {
    await drainDue();
    const seller = await h.seedUser('seller');
    const bidder = await h.seedUser('bidder');
    await h.fund(bidder, reais(50_000));
    const bad = await h.newLot(seller, { durationMs: 10 * MIN });
    await bid(bidder, bad.id, reais(100));
    const raw = await db.rawClient();
    await raw.query(`SET session_replication_role = replica`);
    await raw.query(`UPDATE bids SET amount_cents = 1 WHERE lot_id = $1`, [bad.id]);
    h.clock.advance(11 * MIN);

    // 1a varredura: falha e entra em quarentena. O lote ruim e o mais antigo da fila.
    const first = await h.settleLot.settleDue(1);
    expect(first.failed.map((f) => f.lotId)).toEqual([bad.id]);

    // Com limite 1, sem quarentena o lote ruim ocuparia a vaga para sempre e `good` nunca sairia.
    const good = await h.newLot(seller, { durationMs: 1 * MIN });
    await bid(bidder, good.id, reais(100));
    h.clock.advance(2 * MIN);
    const second = await h.settleLot.settleDue(1);
    expect(second.failed).toEqual([]);
    expect(second.settled).toBe(1);
    expect((await h.lotRow(good.id)).status).toBe('closed');
    expect((await h.lotRow(bad.id)).status).toBe('open');

    // Cura e conserta o dado: ao fim da quarentena volta sozinho.
    await raw.query(`UPDATE bids SET amount_cents = $2 WHERE lot_id = $1`, [bad.id, reais(100)]);
    h.clock.advance(6 * MIN);
    expect((await h.settleLot.settleDue(1)).settled).toBe(1);
    expect((await h.lotRow(bad.id)).status).toBe('closed');
  });

  it('a quarentena tem teto: acima dele o lote volta a ser tentado (memoria nunca cresce sem fim)', async () => {
    await drainDue();
    const settler = new SettleLot({ ...h.base, maxQuarantined: 1 });
    const seller = await h.seedUser('seller');
    const bidder = await h.seedUser('bidder');
    await h.fund(bidder, reais(50_000));
    const raw = await db.rawClient();
    await raw.query(`SET session_replication_role = replica`);
    const tampered: string[] = [];
    for (let i = 0; i < 2; i++) {
      const bad = await h.newLot(seller, { durationMs: 10 * MIN });
      await bid(bidder, bad.id, reais(100));
      await raw.query(`UPDATE bids SET amount_cents = 1 WHERE lot_id = $1`, [bad.id]);
      tampered.push(bad.id);
    }
    h.clock.advance(11 * MIN);

    expect((await settler.settleDue(50)).failed).toHaveLength(2); // os dois falham; so um cabe na quarentena
    expect((await settler.settleDue(50)).failed).toHaveLength(1); // o que ficou de fora e tentado de novo
    expect((await settler.settleDue(50)).failed).toHaveLength(1);

    // Desfaz a adulteracao: a auditoria final da suite exige o banco integro.
    await raw.query(`UPDATE bids SET amount_cents = $2 WHERE lot_id = ANY($1::uuid[])`, [
      tampered,
      reais(100),
    ]);
  });
});

describe('liquidacao recusa historico adulterado (nao paga em cima de dado suspeito)', () => {
  it('lance editado por fora -> INTEGRITY_VIOLATION, ninguem recebe nem paga', async () => {
    const { seller, bob, lot } = await scenario();
    await bid(bob, lot.id, reais(100));

    const raw = await db.rawClient();
    await raw.query(`SET session_replication_role = replica`);
    await raw.query(`UPDATE bids SET amount_cents = $2 WHERE lot_id = $1`, [lot.id, reais(1)]);

    h.clock.advance(HOUR);
    const bobBefore = await h.walletOf(bob.id);
    const sellerBefore = await h.walletOf(seller.id);
    await expect(h.settleLot.execute(lot.id)).rejects.toMatchObject({
      code: 'INTEGRITY_VIOLATION',
    });
    expect(await h.walletOf(bob.id)).toEqual(bobBefore);
    expect(await h.walletOf(seller.id)).toEqual(sellerBefore);
    expect((await h.lotRow(lot.id)).status).toBe('open');

    await raw.query(`UPDATE bids SET amount_cents = $2 WHERE lot_id = $1`, [lot.id, reais(100)]);
    expect((await h.settleLot.execute(lot.id)).kind).toBe('sold');
  });
});

describe('cancelamento', () => {
  it('sem lances: cancela, nao estorna nada e o lote deixa de aceitar lance', async () => {
    const { seller, alice, lot } = await scenario();
    const r = await h.cancelLot.execute(seller, lot.id);
    expect(r).toEqual({ cancelled: true, refunded: false });

    const row = await h.lotRow(lot.id);
    expect(row.status).toBe('cancelled');
    expect(row.cancelled_at).not.toBeNull();
    await expect(bid(alice, lot.id, reais(100))).resolves.toMatchObject({
      accepted: false,
      reason: 'LOT_CANCELLED',
    });
    expect((await h.audit.execute(lot.id)).integrity.intact).toBe(true);
  });

  it('com lances: estorna o lider automaticamente, sem cobrar ninguem e sem comprovante', async () => {
    const { seller, alice, bob, lot } = await scenario();
    await bid(alice, lot.id, reais(100));
    await bid(bob, lot.id, reais(150));
    expect((await h.walletOf(bob.id)).committed).toBe(reais(150));

    const r = await h.cancelLot.execute(seller, lot.id);
    expect(r).toEqual({ cancelled: true, refunded: true });

    expect(await h.walletOf(bob.id)).toEqual({
      total: reais(10_000),
      committed: 0,
      available: reais(10_000),
    });
    expect(await h.walletOf(alice.id)).toEqual({
      total: reais(10_000),
      committed: 0,
      available: reais(10_000),
    });
    expect(await h.walletOf(seller.id)).toEqual({ total: 0, committed: 0, available: 0 });
    expect(await ledgerOf(bob.id, lot.id)).toEqual([
      { kind: 'hold', amount: reais(150) },
      { kind: 'release', amount: reais(150) },
    ]);
    const receipts = await db.pool.query(`SELECT 1 FROM receipts WHERE lot_id = $1`, [lot.id]);
    expect(receipts.rowCount).toBe(0);

    const report = await h.audit.execute(lot.id);
    expect(report.integrity).toEqual({ intact: true, issues: [] });
    expect(report.lot.status).toBe('cancelled');
    expect(report.bidCount).toBe(2); // o historico dos lances permanece
  });

  it('estorna so o lote cancelado; o comprometido em outro lote continua', async () => {
    const { seller, bob, lot } = await scenario();
    const other = await h.newLot(seller);
    await bid(bob, lot.id, reais(100));
    await bid(bob, other.id, reais(300));
    await h.cancelLot.execute(seller, lot.id);
    expect(await h.walletOf(bob.id)).toMatchObject({ committed: reais(300) });
  });

  it('publica lot_cancelled', async () => {
    const { seller, lot } = await scenario();
    await h.cancelLot.execute(seller, lot.id);
    const events = h.events.ofType('lot_cancelled');
    expect(events[events.length - 1]).toMatchObject({ lotId: lot.id });
  });

  it('outro leiloeiro cancelando lote alheio -> LOT_NOT_FOUND (nao revela que existe)', async () => {
    const { lot } = await scenario();
    const intruder = await h.seedUser('seller', 'intruso');
    await expect(h.cancelLot.execute(intruder, lot.id)).rejects.toMatchObject({
      code: 'LOT_NOT_FOUND',
    });
    expect((await h.lotRow(lot.id)).status).toBe('open');
  });

  it('comprador tentando cancelar -> recusado, lote intacto', async () => {
    const { alice, lot } = await scenario();
    await expect(h.cancelLot.execute(alice, lot.id)).rejects.toMatchObject({
      code: 'LOT_NOT_FOUND',
    });
    expect((await h.lotRow(lot.id)).status).toBe('open');
  });

  it('papel adulterado no ator (comprador com o id do dono) -> ONLY_SELLERS_CAN_CANCEL', async () => {
    const { seller, lot } = await scenario();
    const forged: Actor = { id: seller.id, role: 'bidder' };
    await expect(h.cancelLot.execute(forged, lot.id)).rejects.toMatchObject({
      code: 'ONLY_SELLERS_CAN_CANCEL',
    });
    expect((await h.lotRow(lot.id)).status).toBe('open');
  });

  it('cancelar duas vezes -> LOT_ALREADY_CANCELLED (e nao estorna duas vezes)', async () => {
    const { seller, bob, lot } = await scenario();
    await bid(bob, lot.id, reais(100));
    await h.cancelLot.execute(seller, lot.id);
    await expect(h.cancelLot.execute(seller, lot.id)).rejects.toMatchObject({
      code: 'LOT_ALREADY_CANCELLED',
    });
    expect(await ledgerOf(bob.id, lot.id)).toHaveLength(2); // hold + um unico release
  });

  it('cancelar lote ja encerrado -> LOT_ALREADY_CLOSED', async () => {
    const { seller, bob, lot } = await scenario();
    await bid(bob, lot.id, reais(100));
    h.clock.advance(HOUR);
    await h.settleLot.execute(lot.id);
    await expect(h.cancelLot.execute(seller, lot.id)).rejects.toMatchObject({
      code: 'LOT_ALREADY_CLOSED',
    });
  });

  it('cancelar depois do fim NAO cancela: liquida e o vencedor paga', async () => {
    const { seller, bob, lot } = await scenario();
    await bid(bob, lot.id, reais(100));
    h.clock.advance(HOUR);
    const r = await h.cancelLot.execute(seller, lot.id);
    expect(r).toEqual({ cancelled: false, reason: 'LOT_ENDED' });
    expect((await h.lotRow(lot.id)).status).toBe('closed');
    expect((await h.walletOf(seller.id)).total).toBe(reais(100));
    expect((await h.walletOf(bob.id)).total).toBe(reais(10_000) - reais(100));
  });

  it('cancelar lote agendado (ainda nao comecou) funciona', async () => {
    const seller = await h.seedUser('seller');
    const lot = await h.newLot(seller, { startInMs: 2 * HOUR });
    expect(await h.cancelLot.execute(seller, lot.id)).toEqual({ cancelled: true, refunded: false });
  });

  it('10 cancelamentos em paralelo: um vence, os outros recebem conflito, estorno uma unica vez', async () => {
    const { seller, bob, lot } = await scenario();
    await bid(bob, lot.id, reais(100));
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => h.cancelLot.execute(seller, lot.id)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected')) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'LOT_ALREADY_CANCELLED' });
    }
    expect(await h.walletOf(bob.id)).toEqual({
      total: reais(10_000),
      committed: 0,
      available: reais(10_000),
    });
    expect(await ledgerOf(bob.id, lot.id)).toHaveLength(2);
  });

  it('liquidar lote cancelado -> already_final(cancelled), sem mover dinheiro', async () => {
    const { seller, bob, lot } = await scenario();
    await bid(bob, lot.id, reais(100));
    await h.cancelLot.execute(seller, lot.id);
    h.clock.advance(HOUR);
    expect(await h.settleLot.execute(lot.id)).toEqual({
      kind: 'already_final',
      status: 'cancelled',
    });
    expect((await h.walletOf(seller.id)).total).toBe(0);
  });
});

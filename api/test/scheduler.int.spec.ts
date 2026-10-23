import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Scheduler, purgeSessionsTask, settleDueTask } from '../src/infrastructure/scheduler.js';
import { HOUR, MIN, FakeClock, reais } from './support/harness.js';
import { Client, createHttpHarness } from './support/http-harness.js';
import type { HttpHarness } from './support/http-harness.js';
import { createTestDb } from './support/test-db.js';
import type { TestDb } from './support/test-db.js';

let db: TestDb;
let http: HttpHarness;
const clock = new FakeClock();
const silent = { error: () => undefined };
const iso = (ms: number) => new Date(ms).toISOString();

beforeAll(async () => {
  db = await createTestDb();
  http = createHttpHarness(db, { clock });
});

afterAll(async () => {
  await db.close();
});

async function register(role: 'seller' | 'bidder', name: string, funds = 0): Promise<Client> {
  const c = new Client(http.app);
  expect((await c.register({ role, displayName: name })).res.status).toBe(201);
  if (funds > 0) expect((await c.post('/api/wallet/deposits', { amount: funds })).status).toBe(201);
  return c;
}

async function lot(s: Client, endsInMs: number): Promise<string> {
  const now = clock.now().getTime();
  const res = await s.post('/api/lots', {
    sourceId: '1001',
    startingBid: reais(100),
    minIncrement: reais(5),
    startsAt: iso(now),
    endsAt: iso(now + endsInMs),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.lot.id as string;
}

const phaseOf = async (id: string) =>
  (await request(http.app).get(`/api/lots/${id}`)).body.lot.phase as string;

/** Consulta direta ao banco: nao passa pela liquidacao preguicosa da leitura. */
async function unsettledDue(): Promise<number> {
  const { rows } = await db.pool.query(
    `SELECT count(*)::int AS n FROM lots WHERE status = 'open' AND ends_at <= $1`,
    [clock.now()],
  );
  return rows[0].n;
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condicao nao ocorreu a tempo');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

describe('settleDueTask com o banco real', () => {
  it('uma execucao liquida todos os vencidos, mesmo em varios lotes de tamanho pequeno', async () => {
    const s = await register('seller', 'Leiloeiro');
    const bob = await register('bidder', 'Bob', reais(10_000));
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await lot(s, 5 * MIN));
    await bob.post(`/api/lots/${ids[0]}/bids`, { amount: reais(100) });
    clock.advance(6 * MIN);
    expect(await unsettledDue()).toBeGreaterThanOrEqual(5);

    await settleDueTask(http.settle, silent, { batchSize: 2 }).run();
    expect(await unsettledDue()).toBe(0);
    for (const id of ids) expect(await phaseOf(id)).toBe('closed');
  });

  it('teto de lotes por ciclo: nao monopoliza o banco, o proximo ciclo continua', async () => {
    const s = await register('seller', 'Leiloeiro');
    for (let i = 0; i < 5; i++) await lot(s, 5 * MIN);
    clock.advance(6 * MIN);
    const before = await unsettledDue();
    await settleDueTask(http.settle, silent, { batchSize: 2, maxBatchesPerRun: 1 }).run();
    expect(await unsettledDue()).toBe(before - 2);
    await settleDueTask(http.settle, silent, { batchSize: 50 }).run();
    expect(await unsettledDue()).toBe(0);
  });

  it('o agendador de verdade (timers reais) liquida sozinho e para limpo', async () => {
    const s = await register('seller', 'Leiloeiro');
    const bob = await register('bidder', 'Bob', reais(1_000));
    const id = await lot(s, 5 * MIN);
    await bob.post(`/api/lots/${id}/bids`, { amount: reais(150) });
    clock.advance(6 * MIN);

    const scheduler = new Scheduler([settleDueTask(http.settle, silent, { everyMs: 20 })], silent);
    scheduler.start();
    await waitFor(async () => (await unsettledDue()) === 0);
    await scheduler.stop();
    expect(await phaseOf(id)).toBe('closed');
  });

  it('duas instancias concorrentes nunca liquidam o mesmo lote duas vezes (dinheiro conservado)', async () => {
    const s = await register('seller', 'Leiloeiro');
    const bob = await register('bidder', 'Bob', reais(10_000));
    const before = (await s.get('/api/wallet')).body.available as number;
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await lot(s, 5 * MIN));
    for (const id of ids)
      expect((await bob.post(`/api/lots/${id}/bids`, { amount: reais(100) })).status).toBe(201);
    clock.advance(6 * MIN);

    const a = new Scheduler(
      [settleDueTask(http.settle, silent, { everyMs: 5, batchSize: 2 })],
      silent,
    );
    const b = new Scheduler(
      [settleDueTask(http.settle, silent, { everyMs: 5, batchSize: 2 })],
      silent,
    );
    a.start();
    b.start();
    await waitFor(async () => (await unsettledDue()) === 0);
    await Promise.all([a.stop(), b.stop()]);

    // Cada venda credita o vendedor uma unica vez; o comprador paga uma unica vez.
    expect((await s.get('/api/wallet')).body.available).toBe(before + 6 * reais(100));
    expect((await bob.get('/api/wallet')).body).toMatchObject({
      available: reais(10_000) - 6 * reais(100),
      committed: 0,
    });
    const receipts = await db.pool.query(
      `SELECT count(*)::int AS n FROM receipts WHERE lot_id = ANY($1::uuid[])`,
      [ids],
    );
    expect(receipts.rows[0].n).toBe(6);
    const credits = await db.pool.query(
      `SELECT count(*)::int AS n FROM wallet_ledger WHERE kind = 'settle_credit' AND lot_id = ANY($1::uuid[])`,
      [ids],
    );
    expect(credits.rows[0].n).toBe(6);
  });
});

describe('purgeSessionsTask com o banco real', () => {
  it('remove sessoes vencidas, preserva as vivas e e idempotente', async () => {
    const stale = await register('bidder', 'Sessao Velha');
    clock.advance(40 * 24 * HOUR); // alem do TTL
    const fresh = await register('bidder', 'Sessao Nova');
    expect((await stale.get('/api/auth/me')).status).toBe(401);

    const task = purgeSessionsTask(http.auth);
    expect(await task.run()).toBeGreaterThanOrEqual(1);
    expect(await task.run()).toBe(0);
    expect((await fresh.get('/api/auth/me')).status).toBe(200);
  });
});

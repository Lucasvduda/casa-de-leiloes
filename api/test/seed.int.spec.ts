import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_ACCOUNTS, ensureDemoData } from '../src/application/seed/demo-data.js';
import type { DemoDataDeps } from '../src/application/seed/demo-data.js';
import type { Clock } from '../src/application/ports.js';
import { CancelLot } from '../src/application/usecases/cancel-lot.js';
import { CreateLot } from '../src/application/usecases/create-lot.js';
import { Deposit } from '../src/application/usecases/deposit.js';
import { PlaceBid } from '../src/application/usecases/place-bid.js';
import { OFFLINE_ITEMS } from '../src/adapters/outbound/catalog/offline-catalog.data.js';
import { FakeClock, createHarness } from './support/harness.js';
import { createHttpHarness } from './support/http-harness.js';
import { createTestDb } from './support/test-db.js';
import type { TestDb } from './support/test-db.js';

const open: TestDb[] = [];
afterEach(async () => {
  for (const db of open.splice(0)) await db.close();
});

const logger = { info: () => undefined };
const DAY = 24 * 60 * 60 * 1000;

async function setup(tweak: (deps: DemoDataDeps) => DemoDataDeps = (deps) => deps) {
  const db = await createTestDb();
  open.push(db);
  const clock = new FakeClock(new Date());
  const http = createHttpHarness(db, { clock });
  const deps = (): DemoDataDeps =>
    tweak({
      auth: http.auth,
      deposit: new Deposit({ uow: db.uow }),
      queries: http.queries,
      settle: http.settle,
      uow: db.uow,
      clock,
      writers: (seedClock: Clock) => ({
        createLot: new CreateLot({ ...http.base, clock: seedClock }),
        placeBid: new PlaceBid({ ...http.base, clock: seedClock }),
        cancelLot: new CancelLot({ ...http.base, clock: seedClock }),
      }),
      items: OFFLINE_ITEMS,
      password: 'Demo-Leilao-2026!',
      logger,
    });
  const count = async (table: string) =>
    Number((await db.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
  const snapshot = async () => ({
    users: await count('users'),
    lots: await count('lots'),
    bids: await count('bids'),
    ledger: await count('wallet_ledger'),
    receipts: await count('receipts'),
  });
  return {
    db,
    clock,
    http,
    deps,
    count,
    snapshot,
    invariants: createHarness(db, clock).assertInvariants,
  };
}

describe('ensureDemoData', () => {
  it('cria contas, saldo e 7 lotes em todos os estados, com historico integro', async () => {
    const t = await setup();
    const summary = await ensureDemoData(t.deps());
    expect(summary).toEqual({ usersCreated: 3, lotsCreated: 7, bidsPlaced: 11 });
    expect(await t.snapshot()).toEqual({
      users: 3,
      lots: 7,
      bids: 11,
      ledger: expect.any(Number),
      receipts: 1,
    });

    const states = await t.db.pool.query(
      `SELECT status, count(*)::int AS n FROM lots GROUP BY status`,
    );
    expect(Object.fromEntries(states.rows.map((r) => [r.status, r.n]))).toEqual({
      open: 4,
      closed: 2,
      cancelled: 1,
    });

    // Toda cadeia de hash, extrato e saldo consistentes (as mesmas invariantes das demais suites).
    await t.invariants();
  });

  it('o lote vendido tem vencedora, valor e comprovante; o outro encerrado fecha sem vencedor', async () => {
    const t = await setup();
    await ensureDemoData(t.deps());
    const { rows } = await t.db.pool.query(`
      SELECT r.amount_cents, r.bid_count, u.email
      FROM receipts r JOIN users u ON u.id = r.winner_id`);
    expect(rows).toEqual([
      { amount_cents: '350000', bid_count: 3, email: DEMO_ACCOUNTS.ana.email },
    ]);
    const closed = await t.db.pool.query(
      `SELECT bid_count FROM lots WHERE status = 'closed' ORDER BY bid_count`,
    );
    expect(closed.rows.map((r) => r.bid_count)).toEqual([0, 3]);
  });

  it('o historico e gravado no passado, em ordem, e os lotes ao vivo seguem abertos', async () => {
    const t = await setup();
    const startedAt = t.clock.now().getTime();
    await ensureDemoData(t.deps());
    const { rows } = await t.db.pool.query(`
      SELECT l.id, l.status, l.ends_at, b.seq, b.placed_at
      FROM lots l JOIN bids b ON b.lot_id = l.id ORDER BY l.id, b.seq`);
    const byLot = new Map<string, typeof rows>();
    for (const r of rows) byLot.set(r.id as string, [...(byLot.get(r.id as string) ?? []), r]);
    for (const bids of byLot.values()) {
      const times = bids.map((r) => (r.placed_at as Date).getTime());
      expect(times, 'instantes crescem com o seq').toEqual([...times].sort((a, b) => a - b));
      expect(new Set(times).size, 'cada lance tem o seu proprio instante').toBe(times.length);
      for (const r of bids) expect((r.placed_at as Date).getTime()).toBeLessThanOrEqual(startedAt);
      // Nenhum lance posterior ao fim do lote.
      for (const r of bids)
        expect((r.placed_at as Date).getTime()).toBeLessThan((r.ends_at as Date).getTime());
    }
    const sold = rows.filter((r) => r.status === 'closed');
    expect((sold[0]!.placed_at as Date).getTime()).toBeLessThan(startedAt - 4 * DAY);
    const live = await t.db.pool.query(
      `SELECT count(*)::int AS n FROM lots WHERE status = 'open' AND ends_at > $1 AND starts_at <= $1`,
      [new Date(startedAt)],
    );
    expect(live.rows[0].n).toBe(3);
  });

  it('com mais de 50 lotes do leiloeiro (varias paginas) ainda reconhece os lotes da demonstracao', async () => {
    const t = await setup();
    await ensureDemoData(t.deps());
    const seller = (
      await t.db.pool.query(`SELECT id FROM users WHERE email = $1`, [DEMO_ACCOUNTS.seller.email])
    ).rows[0].id as string;
    const writers = t.deps().writers(t.clock);
    // 55 lotes mais novos empurram os da demonstracao para depois da 1a pagina (50 por pagina).
    for (let i = 0; i < 55; i++) {
      await writers.createLot.execute({
        actor: { id: seller, role: 'seller' },
        input: {
          item: { ...OFFLINE_ITEMS[10]!, title: `Lote extra ${i}` },
          startingBid: 10_000,
          minIncrement: 1_000,
          startsAt: t.clock.now().toISOString(),
          endsAt: new Date(t.clock.now().getTime() + DAY).toISOString(),
        },
      });
    }
    const before = await t.snapshot();
    expect(before.lots).toBe(62);
    const again = await ensureDemoData(t.deps());
    expect(again).toEqual({ usersCreated: 0, lotsCreated: 0, bidsPlaced: 0 });
    expect(await t.snapshot()).toEqual(before);
  });

  it('lance recusado em lote NOVO e bug do seed: falha alto em vez de seguir com dados incompletos', async () => {
    const t = await setup((deps) => ({
      ...deps,
      writers: (clock) => ({
        createLot: deps.writers(clock).createLot,
        cancelLot: deps.writers(clock).cancelLot,
        placeBid: {
          execute: async () => ({ accepted: false, reason: 'INSUFFICIENT_FUNDS' }),
        } as unknown as PlaceBid,
      }),
    }));
    await expect(ensureDemoData(t.deps())).rejects.toThrow(/recusado \(INSUFFICIENT_FUNDS\)/);
  });

  it('rodar de novo nao muda nada (idempotente)', async () => {
    const t = await setup();
    await ensureDemoData(t.deps());
    const before = await t.snapshot();
    const again = await ensureDemoData(t.deps());
    expect(again).toEqual({ usersCreated: 0, lotsCreated: 0, bidsPlaced: 0 });
    expect(await t.snapshot()).toEqual(before);
    await t.invariants();
  });

  it('retoma depois de uma queda no meio, sem duplicar lance, deposito nem lote', async () => {
    let calls = 0;
    const t = await setup((deps) => ({
      ...deps,
      writers: (clock) => {
        const real = deps.writers(clock);
        return {
          createLot: real.createLot,
          cancelLot: real.cancelLot,
          placeBid: {
            execute: async (cmd) => {
              calls += 1;
              if (calls === 4) throw new Error('queda no meio do seed');
              return real.placeBid.execute(cmd);
            },
          } as PlaceBid,
        };
      },
    }));
    await expect(ensureDemoData(t.deps())).rejects.toThrow('queda no meio do seed');
    const partial = await t.snapshot();
    expect(partial.bids).toBe(3);

    calls = 100; // sem novas quedas
    await ensureDemoData(t.deps());
    const final = await t.snapshot();
    expect(final).toMatchObject({ users: 3, lots: 7, bids: 11, receipts: 1 });
    const deposits = await t.db.pool.query(
      `SELECT count(*)::int AS n FROM wallet_ledger WHERE kind = 'deposit'`,
    );
    expect(deposits.rows[0].n).toBe(2);
    await t.invariants();
  });

  it('nao adivinha: conta de demonstracao ja existente com outro papel interrompe o seed', async () => {
    const t = await setup();
    await t.db.pool.query(
      `INSERT INTO users (id, email, display_name, password_hash, role)
       VALUES (gen_random_uuid(), $1, 'Intrusa', 'x', 'seller')`,
      [DEMO_ACCOUNTS.ana.email],
    );
    await expect(ensureDemoData(t.deps())).rejects.toThrow(/outro papel/);
    expect(await t.count('lots')).toBe(0);
  });

  it('recusa catalogo sem obras suficientes ou com titulos repetidos', async () => {
    const few = await setup((deps) => ({ ...deps, items: OFFLINE_ITEMS.slice(0, 3) }));
    await expect(ensureDemoData(few.deps())).rejects.toThrow(/poucas obras/);

    const dup = await setup((deps) => ({
      ...deps,
      items: OFFLINE_ITEMS.map((item, i) => (i < 2 ? { ...OFFLINE_ITEMS[0]! } : item)),
    }));
    await expect(ensureDemoData(dup.deps())).rejects.toThrow(/titulos distintos/);
    expect(await dup.count('users')).toBe(0);
  });
});

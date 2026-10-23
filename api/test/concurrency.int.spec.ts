import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../src/application/ports.js';
import type { PlaceBidResult } from '../src/application/usecases/place-bid.js';
import { HOUR, createHarness, reais } from './support/harness.js';
import type { Harness } from './support/harness.js';
import { createTestDb } from './support/test-db.js';
import type { TestDb } from './support/test-db.js';

let db: TestDb;
let h: Harness;

beforeAll(async () => {
  db = await createTestDb(20);
  h = createHarness(db);
});

afterAll(async () => {
  await db.close();
});

const bid = (actor: Actor, lotId: string, amount: number, key?: string) =>
  h.placeBid.execute({
    actor,
    lotId,
    amount,
    ...(key !== undefined ? { idempotencyKey: key } : {}),
  });

async function bidders(n: number, funds = reais(100_000)): Promise<Actor[]> {
  const list: Actor[] = [];
  for (let i = 0; i < n; i++) {
    const b = await h.seedUser('bidder', `b${i}`);
    await h.fund(b, funds);
    list.push(b);
  }
  return list;
}

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

const accepted = (r: PlaceBidResult[]) => r.filter((x) => x.accepted);
const rejectedWith = (r: PlaceBidResult[], reason: string) =>
  r.filter((x) => !x.accepted && x.reason === reason);

describe('lances simultaneos', () => {
  it('25 pessoas dando o MESMO valor ao mesmo tempo: exatamente 1 vence, 24 recusadas por valor', async () => {
    const seller = await h.seedUser('seller');
    const lot = await h.newLot(seller);
    const people = await bidders(25);

    const results = await Promise.all(people.map((p) => bid(p, lot.id, reais(100))));

    expect(accepted(results)).toHaveLength(1);
    expect(rejectedWith(results, 'BELOW_MINIMUM')).toHaveLength(24);
    const row = await h.lotRow(lot.id);
    expect(row.bid_count).toBe(1);
    await h.assertInvariants();
  });

  it('lances crescentes em ordem embaralhada: a maior oferta sempre termina lider, seq e cadeia consistentes', async () => {
    for (let round = 0; round < 5; round++) {
      const seller = await h.seedUser('seller');
      const lot = await h.newLot(seller, { startingBid: reais(100), minIncrement: reais(5) });
      const people = await bidders(15);
      const offers = people.map((p, i) => ({ p, amount: reais(100 + i * 5) }));

      const results = await Promise.all(shuffle(offers).map((o) => bid(o.p, lot.id, o.amount)));

      const top = offers[offers.length - 1]!;
      const row = await h.lotRow(lot.id);
      expect(row.leader_id).toBe(top.p.id);
      expect(Number(row.current_amount_cents)).toBe(top.amount);
      expect(row.bid_count).toBe(accepted(results).length);

      // O comprometido total do lote inteiro e exatamente o valor do lider; ninguem mais segura nada.
      const wallets = await Promise.all(people.map((p) => h.walletOf(p.id)));
      const committed = wallets.reduce((s, w) => s + w.committed, 0);
      expect(committed).toBe(top.amount);

      // Valores aceitos sao estritamente crescentes por seq, respeitando o incremento.
      const { rows } = await db.pool.query<{ seq: number; amount_cents: string }>(
        `SELECT seq, amount_cents FROM bids WHERE lot_id = $1 ORDER BY seq`,
        [lot.id],
      );
      rows.forEach((r, i) => {
        expect(r.seq).toBe(i + 1);
        if (i > 0) {
          const prev = Number(rows[i - 1]!.amount_cents);
          expect(Number(r.amount_cents)).toBeGreaterThanOrEqual(prev + reais(5));
        }
      });
    }
    await h.assertInvariants();
  });

  it('a mesma Idempotency-Key disparada 12 vezes em paralelo gera UM lance e 11 replays', async () => {
    const seller = await h.seedUser('seller');
    const lot = await h.newLot(seller);
    const [alice] = await bidders(1);

    const results = await Promise.all(
      Array.from({ length: 12 }, () => bid(alice!, lot.id, reais(100), 'clique-duplo-0000001')),
    );

    expect(results.every((r) => r.accepted)).toBe(true);
    const fresh = results.filter((r) => r.accepted && !r.replayed);
    expect(fresh).toHaveLength(1);
    const ids = new Set(results.map((r) => (r.accepted ? r.bid.id : '')));
    expect(ids.size).toBe(1);
    expect((await h.walletOf(alice!.id)).committed).toBe(reais(100));
    await h.assertInvariants();
  });

  it('carga: 150 lances aleatorios em 4 lotes por 8 pessoas, sem erro e com dinheiro conservado', async () => {
    const seller = await h.seedUser('seller');
    const lots = await Promise.all([1, 2, 3, 4].map(() => h.newLot(seller)));
    const people = await bidders(8, reais(1_000_000));

    const jobs = Array.from({ length: 150 }, (_, i) => {
      const lot = lots[i % lots.length]!;
      const person = people[Math.floor(Math.random() * people.length)]!;
      const amount = reais(100 + Math.floor(Math.random() * 400) * 5);
      return bid(person, lot.id, amount);
    });
    const results = await Promise.all(jobs); // nenhum pode lancar (deadlock, lock timeout...)

    expect(accepted(results).length).toBeGreaterThan(0);
    await h.assertInvariants();
  });
});

describe('carteira sob concorrencia', () => {
  it('fundos para UM lote, 2 lotes em paralelo: so um lance entra (10 rodadas)', async () => {
    for (let round = 0; round < 10; round++) {
      const seller = await h.seedUser('seller');
      const [alice] = await bidders(1, reais(150));
      const [a, b] = await Promise.all([h.newLot(seller), h.newLot(seller)]);

      const results = await Promise.all([
        bid(alice!, a!.id, reais(100)),
        bid(alice!, b!.id, reais(100)),
      ]);

      expect(accepted(results)).toHaveLength(1);
      expect(rejectedWith(results, 'INSUFFICIENT_FUNDS')).toHaveLength(1);
      expect(await h.walletOf(alice!.id)).toMatchObject({
        committed: reais(100),
        available: reais(50),
      });
    }
    await h.assertInvariants();
  });

  it('fundos para um unico lance entre 20 lotes simultaneos: exatamente 1 aceito', async () => {
    const seller = await h.seedUser('seller');
    const [alice] = await bidders(1, reais(120));
    const lots = await Promise.all(Array.from({ length: 20 }, () => h.newLot(seller)));

    const results = await Promise.all(lots.map((l) => bid(alice!, l.id, reais(100))));

    expect(accepted(results)).toHaveLength(1);
    expect(rejectedWith(results, 'INSUFFICIENT_FUNDS')).toHaveLength(19);
    expect((await h.walletOf(alice!.id)).committed).toBe(reais(100));
    await h.assertInvariants();
  });

  it('30 depositos simultaneos somam exatamente', async () => {
    const [alice] = await bidders(1, reais(1));
    await Promise.all(
      Array.from({ length: 30 }, () => h.deposit.execute(alice!, { amount: reais(10) })),
    );
    expect((await h.walletOf(alice!.id)).total).toBe(reais(1) + 30 * reais(10));
    await h.assertInvariants();
  });

  it('deposito com a mesma chave em paralelo conta uma unica vez', async () => {
    const [alice] = await bidders(1, reais(1));
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        h.deposit.execute(alice!, { amount: reais(50), idempotencyKey: 'deposito-duplo-0001' }),
      ),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect((await h.walletOf(alice!.id)).total).toBe(reais(1) + reais(50));
    await h.assertInvariants();
  });
});

describe('deadlock: lances cruzados entre lotes e carteiras', () => {
  it('X e Y se superam em A e B ao mesmo tempo, 25 rodadas, sem nenhum erro', async () => {
    const seller = await h.seedUser('seller');
    const [x, y] = await bidders(2);
    const [lotA, lotB] = await Promise.all([h.newLot(seller), h.newLot(seller)]);
    await bid(x!, lotA!.id, reais(100));
    await bid(y!, lotB!.id, reais(100));

    let amount = 100;
    for (let round = 0; round < 25; round++) {
      amount += 5;
      // y supera x em A enquanto x supera y em B: cada transacao trava lote + as DUAS carteiras
      const results = await Promise.all([
        bid(y!, lotA!.id, reais(amount)),
        bid(x!, lotB!.id, reais(amount)),
      ]);
      expect(results.every((r) => r.accepted)).toBe(true);
      amount += 5;
      await Promise.all([bid(x!, lotA!.id, reais(amount)), bid(y!, lotB!.id, reais(amount))]);
    }
    await h.assertInvariants();
  });

  it('varios licitantes em varios lotes, todos contra todos, sem deadlock', async () => {
    const seller = await h.seedUser('seller');
    const people = await bidders(6);
    const lots = await Promise.all(Array.from({ length: 3 }, () => h.newLot(seller)));
    for (let round = 0; round < 10; round++) {
      const jobs = lots.flatMap((lot, li) =>
        people.map((p, pi) => bid(p, lot.id, reais(100 + (round * 100 + pi * 5 + li) * 5))),
      );
      await Promise.all(jobs);
    }
    await h.assertInvariants();
  });
});

describe('lance x encerramento x cancelamento', () => {
  it('5 lances + 5 liquidacoes depois do fim: ninguem entra, liquida uma unica vez', async () => {
    const seller = await h.seedUser('seller');
    const [alice, ...others] = await bidders(6);
    const lot = await h.newLot(seller);
    await bid(alice!, lot.id, reais(100));
    h.clock.advance(HOUR + 1000);

    const results = await Promise.all([
      ...others.slice(0, 5).map((p) => bid(p, lot.id, reais(500))),
      ...Array.from({ length: 5 }, () => h.settleLot.execute(lot.id)),
    ]);

    const bidResults = results.slice(0, 5) as PlaceBidResult[];
    expect(bidResults.every((r) => !r.accepted && r.reason === 'LOT_ENDED')).toBe(true);
    const { rows } = await db.pool.query(
      `SELECT count(*)::int AS n FROM receipts WHERE lot_id = $1`,
      [lot.id],
    );
    expect(rows[0].n).toBe(1);
    expect(await h.walletOf(alice!.id)).toMatchObject({
      total: reais(10_000_0) - reais(100),
      committed: 0,
    });
    h.clock.advance(-(HOUR + 1000));
    await h.assertInvariants();
  });

  it('12 liquidacoes simultaneas do mesmo lote: 1 "sold", o resto "already_final", vendedor creditado 1 vez', async () => {
    const seller = await h.seedUser('seller');
    const [alice] = await bidders(1);
    const lot = await h.newLot(seller);
    await bid(alice!, lot.id, reais(250));
    h.clock.advance(HOUR + 1000);

    const results = await Promise.all(
      Array.from({ length: 12 }, () => h.settleLot.execute(lot.id)),
    );

    expect(results.filter((r) => r.kind === 'sold')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'already_final')).toHaveLength(11);
    expect((await h.walletOf(seller.id)).total).toBe(reais(250));
    h.clock.advance(-(HOUR + 1000));
    await h.assertInvariants();
  });

  it('lances e cancelamento em corrida (15 rodadas): estado sempre consistente, estorno sem sobra', async () => {
    for (let round = 0; round < 15; round++) {
      const seller = await h.seedUser('seller');
      const people = await bidders(4);
      const lot = await h.newLot(seller);
      await bid(people[0]!, lot.id, reais(100));

      const results = await Promise.allSettled([
        h.cancelLot.execute(seller, lot.id),
        ...people.slice(1).map((p, i) => bid(p, lot.id, reais(105 + i * 5))),
      ]);

      // nenhuma operacao pode quebrar por causa da corrida
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      const row = await h.lotRow(lot.id);
      expect(row.status).toBe('cancelled');
      // cancelado: ninguem fica com valor preso
      const wallets = await Promise.all(people.map((p) => h.walletOf(p.id)));
      expect(wallets.every((w) => w.committed === 0)).toBe(true);
    }
    await h.assertInvariants();
  });
});

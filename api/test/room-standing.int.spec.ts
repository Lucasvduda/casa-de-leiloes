import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../src/application/ports.js';
import { createHarness, reais } from './support/harness.js';
import type { Harness } from './support/harness.js';
import { createHttpHarness } from './support/http-harness.js';
import type { HttpHarness } from './support/http-harness.js';
import { createTestDb } from './support/test-db.js';
import type { TestDb } from './support/test-db.js';

/**
 * Sala do lote: situacao de quem olha (ja deu lance? em que posicao?) vem do banco, nao da janela
 * dos 50 lances mais recentes. Antes, quem tinha sido superado ha mais de 50 lances voltava a
 * aparecer como "sem lance".
 */
let db: TestDb;
let h: Harness;
let http: HttpHarness;

beforeAll(async () => {
  db = await createTestDb();
  h = createHarness(db);
  // Mesmo relogio: o harness de leitura enxerga o lote como o de escrita.
  http = createHttpHarness(db, { clock: h.clock });
});

afterAll(async () => {
  await h.assertInvariants();
  await db.close();
});

const bid = (actor: Actor, lotId: string, amount: number) =>
  h.placeBid.execute({ actor, lotId, amount });

async function bidders(n: number): Promise<Actor[]> {
  const out: Actor[] = [];
  for (let i = 0; i < n; i++) {
    const actor = await h.seedUser('bidder', `licitante${i}`);
    await h.fund(actor, reais(500_000));
    out.push(actor);
  }
  return out;
}

describe('viewerDetail: hasBid e position', () => {
  it('quem nunca deu lance: hasBid false e posicao nula; anonimo nao tem viewerDetail', async () => {
    const seller = await h.seedUser('seller');
    const [ana, bruno, carla] = await bidders(3);
    const lot = await h.newLot(seller);
    await bid(ana!, lot.id, reais(100));
    await bid(bruno!, lot.id, reais(120));

    const asCarla = await http.queries.getLot(carla!, lot.id);
    expect(asCarla.viewerDetail).toMatchObject({ hasBid: false, position: null });
    expect((await http.queries.getLot(null, lot.id)).viewerDetail).toBeNull();
    expect((await http.queries.getLot(seller, lot.id)).viewerDetail).toMatchObject({
      hasBid: false,
      position: null,
    });
  });

  it('posicao pelo maior lance de cada pessoa: lider 1o, superados 2o e 3o', async () => {
    const seller = await h.seedUser('seller');
    const [ana, bruno, carla] = await bidders(3);
    const lot = await h.newLot(seller);
    await bid(ana!, lot.id, reais(100));
    await bid(bruno!, lot.id, reais(120));
    await bid(carla!, lot.id, reais(140));
    await bid(ana!, lot.id, reais(160)); // Ana volta a liderar; Ana tinha dois lances, conta so uma vez

    const position = async (who: Actor) =>
      (await http.queries.getLot(who, lot.id)).viewerDetail?.position;
    expect(await position(ana!)).toBe(1);
    expect(await position(carla!)).toBe(2);
    expect(await position(bruno!)).toBe(3);
  });

  it('superado ha mais de 50 lances continua com hasBid e posicao certos', async () => {
    const seller = await h.seedUser('seller');
    const [ana, bruno, carla] = await bidders(3);
    const lot = await h.newLot(seller, { startingBid: reais(100), minIncrement: reais(5) });
    await bid(carla!, lot.id, reais(100)); // so um lance, logo no comeco
    let amount = reais(105);
    for (let i = 0; i < 60; i++) {
      const result = await bid(i % 2 === 0 ? ana! : bruno!, lot.id, amount);
      expect(result.accepted, `lance ${i + 1}`).toBe(true);
      amount += reais(5);
    }

    const room = await http.queries.getLot(carla!, lot.id);
    // A janela da sala guarda so os 50 mais recentes e o lance da Carla ficou de fora dela...
    expect(room.bids).toHaveLength(50);
    expect(room.bids.some((b) => b.mine)).toBe(false);
    expect(room.bidCount).toBe(61);
    // ...mas o servidor sabe que ela deu lance e que esta em 3o (atras de quem mais deu lance).
    expect(room.viewerDetail).toMatchObject({ hasBid: true, position: 3 });
    expect(room.viewer).toMatchObject({ isLeading: false });
  });

  it('a sala devolve os 50 mais recentes, do mais novo para o mais antigo, sem lacunas', async () => {
    const seller = await h.seedUser('seller');
    const [ana, bruno] = await bidders(2);
    const lot = await h.newLot(seller);
    let amount = reais(100);
    for (let i = 0; i < 55; i++) {
      await bid(i % 2 === 0 ? ana! : bruno!, lot.id, amount);
      amount += reais(5);
    }
    const room = await http.queries.getLot(null, lot.id);
    expect(room.bids.map((b) => b.seq)).toEqual(Array.from({ length: 50 }, (_, i) => 55 - i));
    expect(room.bids[0]!.amount).toBe(room.currentAmount);
  });
});

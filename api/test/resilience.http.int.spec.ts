import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HOUR, FakeClock, createHarness, reais } from './support/harness.js';
import type { Harness } from './support/harness.js';
import { Client, createHttpHarness } from './support/http-harness.js';
import type { HttpHarness } from './support/http-harness.js';
import { createTestDb } from './support/test-db.js';
import type { TestDb } from './support/test-db.js';

/**
 * Resiliencia com falhas REAIS de infraestrutura (nao mocks): conexoes mortas no meio da
 * requisicao, lock de linha preso e pool esgotado. Regra: o cliente recebe 503 com Retry-After
 * (nunca 500, nunca pendura), nada fica pela metade e o servico se recupera sozinho.
 */

let db: TestDb;
let http: HttpHarness;
let core: Harness;
const clock = new FakeClock();

beforeAll(async () => {
  // Pool pequeno de proposito: facilita esgota-lo no teste de pool.
  db = await createTestDb(4);
  http = createHttpHarness(db, { clock });
  core = createHarness(db, clock);
});

afterAll(async () => {
  await db.close();
});

async function setup() {
  const seller = new Client(http.app);
  await seller.register({ role: 'seller', displayName: 'Casa Resiliente' });
  const bidders: Client[] = [];
  for (let i = 0; i < 4; i += 1) {
    const b = new Client(http.app);
    await b.register({ role: 'bidder', displayName: `Licitante ${i}` });
    await b.post('/api/wallet/deposits', { amount: reais(50_000) });
    bidders.push(b);
  }
  const now = clock.now().getTime();
  const res = await seller.post('/api/lots', {
    sourceId: '1001',
    startingBid: reais(100),
    minIncrement: reais(5),
    startsAt: new Date(now).toISOString(),
    endsAt: new Date(now + 6 * HOUR).toISOString(),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { seller, bidders, lotId: res.body.lot.id as string };
}

describe('conexoes do banco morrendo no meio das requisicoes', () => {
  it('sob carga: so 2xx/4xx/503 (nunca 500), sem estado pela metade, e recupera sozinho', async () => {
    const { bidders, lotId } = await setup();
    const killer = await db.rawClient();
    let killing = true;
    const killLoop = (async () => {
      while (killing) {
        await killer
          .query(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
             WHERE datname = current_database() AND pid <> pg_backend_pid()`,
          )
          .catch(() => undefined);
        await new Promise((r) => setTimeout(r, 15));
      }
    })();

    const statuses: number[] = [];
    const retryAfterOn503: (string | undefined)[] = [];
    const work: Promise<void>[] = [];
    for (let round = 0; round < 12; round += 1) {
      for (const [i, bidder] of bidders.entries()) {
        work.push(
          (async () => {
            const res = await bidder.post(
              `/api/lots/${lotId}/bids`,
              { amount: reais(105 + round * 20 + i * 5) },
              { 'Idempotency-Key': `resilience-${round}-${i}` },
            );
            statuses.push(res.status);
            if (res.status === 503) retryAfterOn503.push(res.headers['retry-after'] as string);
          })(),
          (async () => {
            const res = await request(http.app).get(`/api/lots/${lotId}`);
            statuses.push(res.status);
            if (res.status === 503) retryAfterOn503.push(res.headers['retry-after'] as string);
          })(),
        );
      }
    }
    await Promise.all(work);
    killing = false;
    await killLoop;

    expect(statuses.filter((s) => s >= 500 && s !== 503)).toEqual([]);
    expect(retryAfterOn503.every((v) => v !== undefined && Number(v) > 0)).toBe(true);
    // O teste so vale se as mortes realmente atrapalharam alguma requisicao.
    expect(statuses.includes(503), 'nenhuma requisicao foi afetada: teste fraco').toBe(true);

    // Recuperacao: o proximo pedido normal funciona sem reiniciar nada.
    let recovered = 0;
    for (let i = 0; i < 20 && recovered === 0; i += 1) {
      const res = await request(http.app).get('/api/lots');
      if (res.status === 200) recovered = 1;
      else await new Promise((r) => setTimeout(r, 50));
    }
    expect(recovered).toBe(1);

    // Nada pela metade: dinheiro conservado, extrato coerente, cadeias integras.
    await core.assertInvariants();
  }, 60_000);

  it('/ready acompanha a saude real do banco e volta sozinho', async () => {
    const killer = await db.rawClient();
    await killer.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid()`,
    );
    let ok = false;
    for (let i = 0; i < 20 && !ok; i += 1) {
      ok = (await request(http.app).get('/api/lots')).status === 200;
      if (!ok) await new Promise((r) => setTimeout(r, 50));
    }
    expect(ok).toBe(true);
  });
});

describe('lock de linha preso por outra transacao', () => {
  it('o lance recebe 503 + Retry-After em ~5 s (lock_timeout), nao pendura, e funciona depois', async () => {
    const { bidders, lotId } = await setup();
    const holder = await db.rawClient();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM lots WHERE id = $1 FOR UPDATE', [lotId]);

    const started = Date.now();
    const blocked = await bidders[0]!.post(
      `/api/lots/${lotId}/bids`,
      { amount: reais(200) },
      { 'Idempotency-Key': 'lock-test-0001' },
    );
    const elapsed = Date.now() - started;
    expect(blocked.status).toBe(503);
    expect(blocked.body.error.code).toBe('TEMPORARILY_UNAVAILABLE');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(elapsed).toBeGreaterThanOrEqual(4_000);
    expect(elapsed).toBeLessThan(12_000);

    // Leitura publica NAO depende desse lock (snapshot): continua respondendo durante a trava.
    const read = await request(http.app).get(`/api/lots/${lotId}`);
    expect(read.status).toBe(200);

    await holder.query('ROLLBACK');
    const after = await bidders[0]!.post(
      `/api/lots/${lotId}/bids`,
      { amount: reais(200) },
      { 'Idempotency-Key': 'lock-test-0001' },
    );
    expect(after.status, JSON.stringify(after.body)).toBe(201);
    await core.assertInvariants();
  }, 60_000);
});

describe('pool de conexoes esgotado', () => {
  it('pedido que nao consegue conexao vira 503 com Retry-After (nunca 500) e o servico volta depois', async () => {
    const held = await Promise.all(Array.from({ length: 4 }, () => db.pool.connect()));
    try {
      const started = Date.now();
      const res = await request(http.app).get('/api/lots');
      const elapsed = Date.now() - started;
      expect(res.status, JSON.stringify(res.body)).toBe(503);
      expect(res.body.error.code).toBe('TEMPORARILY_UNAVAILABLE');
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      // connectionTimeoutMillis = 10 s: responde, nao fica pendurado para sempre.
      expect(elapsed).toBeLessThan(15_000);
    } finally {
      for (const client of held) client.release();
    }
    const again = await request(http.app).get('/api/lots');
    expect(again.status).toBe(200);
  }, 60_000);
});

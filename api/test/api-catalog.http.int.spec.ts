import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HOUR, FakeClock, reais } from './support/harness.js';
import { Client, LOOSE_RATE_LIMITS, createHttpHarness } from './support/http-harness.js';
import type { HttpHarness } from './support/http-harness.js';
import { createTestDb } from './support/test-db.js';
import type { TestDb } from './support/test-db.js';

let db: TestDb;
let http: HttpHarness;
const clock = new FakeClock();
const app = () => http.app;
const iso = (ms: number) => new Date(ms).toISOString();

beforeAll(async () => {
  db = await createTestDb();
  http = createHttpHarness(db, { clock });
});

afterAll(async () => {
  await db.close();
});

async function register(
  role: 'seller' | 'bidder',
  name: string,
  funds = 0,
  target = app(),
): Promise<Client> {
  const c = new Client(target);
  expect((await c.register({ role, displayName: name })).res.status).toBe(201);
  if (funds > 0) expect((await c.post('/api/wallet/deposits', { amount: funds })).status).toBe(201);
  return c;
}

const lotBody = (over: Record<string, unknown> = {}) => {
  const now = clock.now().getTime();
  return {
    sourceId: '1001',
    startingBid: reais(100),
    minIncrement: reais(5),
    startsAt: iso(now),
    endsAt: iso(now + HOUR),
    ...over,
  };
};

describe('busca no catalogo (so leiloeiro)', () => {
  it('devolve itens pagina a pagina, com total e indicador de degradacao', async () => {
    const s = await register('seller', 'Leiloeiro');
    const p1 = (await s.get('/api/catalog/search?q=')).body;
    expect(p1).toMatchObject({ page: 1, pageSize: 12, total: 30, degraded: false });
    expect(p1.items).toHaveLength(12);
    expect(p1.items[0]).toEqual(
      expect.objectContaining({
        source: 'cleveland',
        sourceId: expect.any(String),
        title: expect.any(String),
        imageUrl: expect.any(String),
      }),
    );
    const p3 = (await s.get('/api/catalog/search?page=3')).body;
    expect(p3.items).toHaveLength(6);
    const ids = [
      ...p1.items,
      ...(await s.get('/api/catalog/search?page=2')).body.items,
      ...p3.items,
    ].map((i: { sourceId: string }) => i.sourceId);
    expect(new Set(ids).size).toBe(30);
  });

  it('filtra por termo (titulo ou artista)', async () => {
    const s = await register('seller', 'Leiloeiro');
    expect((await s.get('/api/catalog/search?q=monet')).body.total).toBe(10);
    expect((await s.get('/api/catalog/search?q=retrato')).body.total).toBe(15);
    expect((await s.get('/api/catalog/search?q=zzzzzz')).body).toMatchObject({
      total: 0,
      items: [],
    });
  });

  it.each([
    ['page=0', 'page=0'],
    ['page=101', 'page=101'],
    ['page texto', 'page=abc'],
    ['page decimal', 'page=1.5'],
    ['q com 101 caracteres', `q=${'a'.repeat(101)}`],
    ['q repetido', 'q=a&q=b'],
  ])('parametro invalido (%s) -> 400', async (_n, query) => {
    const s = await register('seller', 'Leiloeiro');
    const res = await s.get(`/api/catalog/search?${query}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('termo hostil (controle, injecao, emoji) nao gera 500', async () => {
    const s = await register('seller', 'Leiloeiro');
    for (const q of [
      '%00%01',
      "'; DROP TABLE lots;--",
      '%F0%9F%8E%A8',
      '..%2F..%2Fetc%2Fpasswd',
      '%3Cscript%3E',
    ]) {
      const res = await s.get(`/api/catalog/search?q=${q}`);
      expect(res.status, q).toBe(200);
    }
  });
});

describe('o leilao NAO depende da API externa', () => {
  it('com o catalogo fora do ar, tudo que ja existe continua funcionando', async () => {
    const s = await register('seller', 'Leiloeiro Resiliente');
    const bob = await register('bidder', 'Bob', reais(1_000));
    const created = await s.post('/api/lots', lotBody());
    expect(created.status).toBe(201);
    const lotId = created.body.lot.id as string;

    http.catalog.down = true;
    const before = http.catalog.calls.length;
    try {
      // Vitrine, sala (com a imagem/titulo copiados), auditoria, carteira e lances: nenhum toca no catalogo.
      const list = await request(app()).get('/api/lots');
      expect(list.status).toBe(200);
      expect(list.body.items[0]).toMatchObject({
        title: 'Retrato numero 1',
        imageUrl: expect.stringContaining('1001'),
      });
      const room = await request(app()).get(`/api/lots/${lotId}`);
      expect(room.status).toBe(200);
      expect(room.body.lot.item).toMatchObject({ sourceId: '1001', title: 'Retrato numero 1' });
      expect((await bob.post(`/api/lots/${lotId}/bids`, { amount: reais(100) })).status).toBe(201);
      expect((await request(app()).get(`/api/lots/${lotId}/audit`)).body.integrity.intact).toBe(
        true,
      );
      expect((await bob.get('/api/wallet')).status).toBe(200);
      clock.advance(HOUR + 60_000);
      const closed = await request(app()).get(`/api/lots/${lotId}`);
      expect(closed.body.lot.phase).toBe('closed');
      const code = closed.body.lot.result.receiptCode as string;
      expect((await request(app()).get(`/api/receipts/${code}`)).status).toBe(200);
      expect(http.catalog.calls.length).toBe(before);
    } finally {
      http.catalog.down = false;
    }
  });

  it('so criar lote e buscar item dependem do catalogo: 503 claro, com Retry-After, sem criar lote pela metade', async () => {
    const s = await register('seller', 'Leiloeiro Sem Catalogo');
    http.catalog.down = true;
    try {
      const search = await s.get('/api/catalog/search?q=a');
      expect(search.status).toBe(503);
      expect(search.body.error.code).toBe('CATALOG_UNAVAILABLE');
      expect(search.headers['retry-after']).toBeDefined();

      const create = await s.post('/api/lots', lotBody());
      expect(create.status).toBe(503);
      expect(create.body.error.code).toBe('CATALOG_UNAVAILABLE');
      expect(create.headers['retry-after']).toBeDefined();
      expect((await s.get('/api/me/lots')).body.items).toHaveLength(0);
    } finally {
      http.catalog.down = false;
    }
    // Voltou: funciona de novo, sem estado preso.
    expect((await s.post('/api/lots', lotBody())).status).toBe(201);
  });
});

describe('limites de taxa nas rotas sensiveis (por usuario, nao global)', () => {
  let limited: HttpHarness;

  beforeAll(() => {
    limited = createHttpHarness(db, {
      clock,
      rateLimits: {
        ...LOOSE_RATE_LIMITS,
        bid: { windowMs: 60_000, limit: 3 },
        deposit: { windowMs: 60_000, limit: 3 },
        catalog: { windowMs: 60_000, limit: 3 },
        write: { windowMs: 60_000, limit: 4 },
      },
    });
  });

  it('lances: o 4o em um minuto leva 429; outra pessoa nao e afetada', async () => {
    const s = await register('seller', 'Leiloeiro', 0, limited.app);
    const a = await register('bidder', 'Ana', reais(10_000), limited.app);
    const b = await register('bidder', 'Beto', reais(10_000), limited.app);
    const lot = await s.post('/api/lots', lotBody());
    const id = lot.body.lot.id as string;
    // Alterna A e B para os lances serem validos; so conta o limite de A.
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push(
        (await a.post(`/api/lots/${id}/bids`, { amount: reais(100 + i * 10) + 1 })).status,
      );
    }
    expect(statuses.slice(0, 3).every((st) => st === 201 || st === 409)).toBe(true);
    expect(statuses[3]).toBe(429);
    const blocked = await a.post(`/api/lots/${id}/bids`, { amount: reais(500) });
    expect(blocked.body.error).toMatchObject({
      code: 'RATE_LIMITED',
      details: { retryAfterSeconds: expect.any(Number) },
    });
    // B segue livre (chave por usuario).
    const other = await b.post(`/api/lots/${id}/bids`, { amount: reais(600) });
    expect(other.status).toBe(201);
  });

  it('depositos: 429 depois do limite', async () => {
    const c = await register('bidder', 'Caio', 0, limited.app);
    const out: number[] = [];
    for (let i = 0; i < 5; i++)
      out.push((await c.post('/api/wallet/deposits', { amount: reais(1) })).status);
    // O cadastro nao gasta o limite de deposito; 3 passam, o resto e barrado.
    expect(out).toEqual([201, 201, 201, 429, 429]);
    expect((await c.get('/api/wallet')).status).toBe(200); // leitura nao e limitada
  });

  it('busca no catalogo: 429 depois do limite', async () => {
    const s = await register('seller', 'Leiloeiro', 0, limited.app);
    const out: number[] = [];
    for (let i = 0; i < 5; i++) out.push((await s.get('/api/catalog/search?q=a')).status);
    expect(out).toEqual([200, 200, 200, 429, 429]);
  });

  it('o limite e checado ANTES do trabalho caro: requisicao barrada nao chega ao catalogo', async () => {
    const s = await register('seller', 'Leiloeiro', 0, limited.app);
    for (let i = 0; i < 3; i++) await s.get('/api/catalog/search?q=a');
    const calls = http.catalog.calls.length;
    expect((await s.get('/api/catalog/search?q=a')).status).toBe(429);
    expect(http.catalog.calls.length).toBe(calls);
  });
});

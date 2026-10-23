import request from 'supertest';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HOUR, MIN, FakeClock, reais } from './support/harness.js';
import { Client, createHttpHarness } from './support/http-harness.js';
import type { HttpHarness } from './support/http-harness.js';
import { createTestDb } from './support/test-db.js';
import type { TestDb } from './support/test-db.js';

let db: TestDb;
let http: HttpHarness;
const clock = new FakeClock();

beforeAll(async () => {
  db = await createTestDb();
  http = createHttpHarness(db, { clock });
});

afterAll(async () => {
  await db.close();
});

const iso = (ms: number) => new Date(ms).toISOString();
const app = () => http.app;

async function seller(name = 'Casa de Leiloes Teste'): Promise<Client> {
  const c = new Client(app());
  const { res } = await c.register({ role: 'seller', displayName: name });
  expect(res.status).toBe(201);
  return c;
}

async function bidder(funds = reais(10_000), name = 'Licitante Teste'): Promise<Client> {
  const c = new Client(app());
  const { res } = await c.register({ role: 'bidder', displayName: name });
  expect(res.status).toBe(201);
  for (let left = funds; left > 0; left -= reais(100_000)) {
    const dep = await c.post('/api/wallet/deposits', { amount: Math.min(left, reais(100_000)) });
    expect(dep.status).toBe(201);
  }
  return c;
}

function lotBody(over: Record<string, unknown> = {}) {
  const now = clock.now().getTime();
  return {
    sourceId: '1001',
    startingBid: reais(100),
    minIncrement: reais(5),
    startsAt: iso(now),
    endsAt: iso(now + HOUR),
    ...over,
  };
}

async function liveLot(s: Client, over: Record<string, unknown> = {}): Promise<string> {
  const res = await s.post('/api/lots', lotBody(over));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.lot.id as string;
}

const bid = (c: Client, lotId: string, amount: unknown, key?: string) =>
  c.post(
    `/api/lots/${lotId}/bids`,
    { amount },
    key !== undefined ? { 'Idempotency-Key': key } : {},
  );

describe('matriz de autorizacao: cada rota x cada papel', () => {
  type Who = 'anon' | 'bidder' | 'seller' | 'otherSeller';
  interface Ctx {
    anon: null;
    bidder: Client;
    seller: Client;
    otherSeller: Client;
    lotId: string;
  }
  interface Case {
    route: string;
    call: (actor: Client | null, ctx: Ctx) => request.Test;
    /** Ordem de execucao: quem consome estado (ex.: cancelar) vem por ultimo. */
    expected: [Who, number][];
  }

  const send = (
    actor: Client | null,
    method: 'get' | 'post',
    url: string,
    body: unknown = {},
  ): request.Test => {
    if (actor === null) {
      return method === 'get'
        ? request(app()).get(url)
        : request(app())
            .post(url)
            .send(body as object);
    }
    return method === 'get' ? actor.get(url) : actor.post(url, body);
  };

  const cases: Case[] = [
    {
      route: 'GET /api/lots',
      call: (a) => send(a, 'get', '/api/lots'),
      expected: [
        ['anon', 200],
        ['bidder', 200],
        ['seller', 200],
      ],
    },
    {
      route: 'GET /api/lots/:id',
      call: (a, c) => send(a, 'get', `/api/lots/${c.lotId}`),
      expected: [
        ['anon', 200],
        ['bidder', 200],
        ['seller', 200],
      ],
    },
    {
      route: 'GET /api/lots/:id/audit',
      call: (a, c) => send(a, 'get', `/api/lots/${c.lotId}/audit`),
      expected: [
        ['anon', 200],
        ['bidder', 200],
        ['seller', 200],
      ],
    },
    {
      route: 'GET /api/receipts/:code',
      call: (a) => send(a, 'get', `/api/receipts/${'A'.repeat(22)}`),
      expected: [
        ['anon', 404],
        ['bidder', 404],
        ['seller', 404],
      ],
    },
    {
      route: 'POST /api/auth/logout',
      call: (a) => send(a, 'post', '/api/auth/logout'),
      expected: [['anon', 204]],
    },
    {
      route: 'POST /api/lots',
      call: (a) => send(a, 'post', '/api/lots', lotBody()),
      expected: [
        ['anon', 401],
        ['bidder', 403],
        ['otherSeller', 201],
        ['seller', 201],
      ],
    },
    {
      route: 'POST /api/lots/:id/cancel',
      call: (a, c) => send(a, 'post', `/api/lots/${c.lotId}/cancel`),
      expected: [
        ['anon', 401],
        ['bidder', 403],
        ['otherSeller', 404],
        ['seller', 200],
      ],
    },
    {
      route: 'POST /api/lots/:id/bids',
      call: (a, c) => send(a, 'post', `/api/lots/${c.lotId}/bids`, { amount: reais(100) }),
      expected: [
        ['anon', 401],
        ['seller', 403],
        ['otherSeller', 403],
        ['bidder', 201],
      ],
    },
    {
      route: 'GET /api/wallet',
      call: (a) => send(a, 'get', '/api/wallet'),
      expected: [
        ['anon', 401],
        ['bidder', 200],
        ['seller', 200],
        ['otherSeller', 200],
      ],
    },
    {
      route: 'POST /api/wallet/deposits',
      call: (a) => send(a, 'post', '/api/wallet/deposits', { amount: reais(10) }),
      expected: [
        ['anon', 401],
        ['seller', 403],
        ['otherSeller', 403],
        ['bidder', 201],
      ],
    },
    {
      route: 'GET /api/me/lots',
      call: (a) => send(a, 'get', '/api/me/lots'),
      expected: [
        ['anon', 401],
        ['bidder', 403],
        ['seller', 200],
      ],
    },
    {
      route: 'GET /api/me/bids',
      call: (a) => send(a, 'get', '/api/me/bids'),
      expected: [
        ['anon', 401],
        ['seller', 403],
        ['bidder', 200],
      ],
    },
    {
      route: 'GET /api/me/wins',
      call: (a) => send(a, 'get', '/api/me/wins'),
      expected: [
        ['anon', 401],
        ['seller', 403],
        ['bidder', 200],
      ],
    },
    {
      route: 'GET /api/catalog/search',
      call: (a) => send(a, 'get', '/api/catalog/search?q=paisagem'),
      expected: [
        ['anon', 401],
        ['bidder', 403],
        ['seller', 200],
      ],
    },
  ];

  it.each(cases.map((c) => [c.route, c] as const))('%s', async (_route, testCase) => {
    const s = await seller();
    const ctx: Ctx = {
      anon: null,
      bidder: await bidder(),
      seller: s,
      otherSeller: await seller('Outro Leiloeiro'),
      lotId: await liveLot(s),
    };
    for (const [who, status] of testCase.expected) {
      const res = await testCase.call(ctx[who], ctx);
      expect(res.status, `${testCase.route} como ${who}: ${JSON.stringify(res.body)}`).toBe(status);
      // Quem barra importa: 401/403 vem do middleware (camada externa), nao de uma checagem
      // mais funda do caso de uso. Sem isso, remover o middleware passaria despercebido.
      if (status === 401) expect(res.body.error.code).toBe('UNAUTHENTICATED');
      if (status === 403) expect(res.body.error.code).toBe('FORBIDDEN_ROLE');
    }
  });

  it.each([
    ['POST /api/lots', 'seller', '/api/lots', lotBody],
    ['POST /api/lots/:id/cancel', 'seller', '/api/lots/ID/cancel', () => ({})],
    ['POST /api/lots/:id/bids', 'bidder', '/api/lots/ID/bids', () => ({ amount: reais(100) })],
    ['POST /api/wallet/deposits', 'bidder', '/api/wallet/deposits', () => ({ amount: reais(10) })],
    ['POST /api/auth/logout', 'bidder', '/api/auth/logout', () => ({})],
  ] as const)(
    '%s sem X-CSRF-Token e recusada (403) mesmo com o papel certo',
    async (_r, role, url, body) => {
      const s = await seller();
      const lotId = await liveLot(s);
      const actor = role === 'seller' ? s : await bidder();
      const res = await actor.agent.post(url.replace('ID', lotId)).send(body() as object);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CSRF_INVALID');
    },
  );
});

describe('ciclo completo do leilao, ponta a ponta por HTTP', () => {
  it('cria lote, recebe lances, encerra, liquida, emite comprovante e atualiza todos os paineis', async () => {
    const s = await seller('Galeria Central');
    const alice = await bidder(reais(5_000), 'Alice');
    const bob = await bidder(reais(5_000), 'Bob');
    const lotId = await liveLot(s);

    expect((await bid(alice, lotId, reais(100))).status).toBe(201);
    expect((await bid(bob, lotId, reais(150))).status).toBe(201);
    expect((await bid(alice, lotId, reais(200))).status).toBe(201);
    expect((await bid(bob, lotId, reais(250))).status).toBe(201);

    const live = (await request(app()).get(`/api/lots/${lotId}`)).body.lot;
    expect(live).toMatchObject({
      phase: 'live',
      currentAmount: reais(250),
      bidCount: 4,
      minimumNextBid: reais(255),
    });

    // Carteiras durante o leilao: so o lider tem valor comprometido.
    expect((await alice.get('/api/wallet')).body).toMatchObject({
      total: reais(5_000),
      committed: 0,
      available: reais(5_000),
    });
    expect((await bob.get('/api/wallet')).body).toMatchObject({
      total: reais(5_000),
      committed: reais(250),
      available: reais(4_750),
    });

    // O relogio passa do fim: abrir a sala liquida na hora (sem depender do agendador).
    clock.advance(HOUR + MIN);
    const closed = (await request(app()).get(`/api/lots/${lotId}`)).body.lot;
    expect(closed.phase).toBe('closed');
    expect(closed.result).toMatchObject({ outcome: 'sold', amount: reais(250) });
    const code = closed.result.receiptCode as string;

    const receipt = (await request(app()).get(`/api/receipts/${code}`)).body.receipt;
    expect(receipt).toMatchObject({
      code,
      amount: reais(250),
      bidCount: 4,
      sellerName: 'Galeria Central',
      signatureValid: true,
    });
    expect(receipt.winner).toBe(closed.result.winner);

    // Dinheiro: Bob pagou, Alice nao, o leiloeiro recebeu.
    expect((await bob.get('/api/wallet')).body).toMatchObject({
      total: reais(4_750),
      committed: 0,
    });
    expect((await alice.get('/api/wallet')).body).toMatchObject({
      total: reais(5_000),
      committed: 0,
    });
    expect((await s.get('/api/wallet')).body).toMatchObject({
      total: reais(250),
      available: reais(250),
    });

    // Paineis.
    const wins = (await bob.get('/api/me/wins')).body;
    expect(wins.items).toHaveLength(1);
    expect(wins.items[0]).toMatchObject({ id: lotId, receiptCode: code });
    expect((await alice.get('/api/me/wins')).body.items).toHaveLength(0);
    expect((await alice.get('/api/me/bids')).body.items.map((l: { id: string }) => l.id)).toContain(
      lotId,
    );

    const mine = (await s.get('/api/me/lots')).body;
    expect(mine.totals).toEqual({ received: reais(250), soldCount: 1 });
    expect(mine.items.find((l: { id: string }) => l.id === lotId)).toMatchObject({
      phase: 'closed',
      receiptCode: code,
    });

    // Auditoria publica integra, com o comprovante.
    const audit = (await request(app()).get(`/api/lots/${lotId}/audit`)).body;
    expect(audit.integrity).toEqual({ intact: true, issues: [] });
    expect(audit.bids).toHaveLength(4);
    expect(audit.receipt).toMatchObject({ code, signatureValid: true });
  });

  it('lote sem lances encerra sem vencedor e sem comprovante', async () => {
    const s = await seller();
    const lotId = await liveLot(s, { endsAt: iso(clock.now().getTime() + 5 * MIN) });
    clock.advance(6 * MIN);
    const lot = (await request(app()).get(`/api/lots/${lotId}`)).body.lot;
    expect(lot).toMatchObject({
      phase: 'closed',
      result: { outcome: 'no_winner' },
      receiptCode: null,
    });
  });

  it('cancelar com lances estorna o lider e o lote vira cancelado para todos', async () => {
    const s = await seller();
    const bob = await bidder(reais(1_000));
    const lotId = await liveLot(s);
    await bid(bob, lotId, reais(300));
    expect((await bob.get('/api/wallet')).body.committed).toBe(reais(300));

    const cancel = await s.post(`/api/lots/${lotId}/cancel`);
    expect(cancel.status).toBe(200);
    expect(cancel.body).toEqual({ cancelled: true, refunded: true });
    expect((await bob.get('/api/wallet')).body).toMatchObject({
      total: reais(1_000),
      committed: 0,
    });
    const lot = (await request(app()).get(`/api/lots/${lotId}`)).body.lot;
    expect(lot).toMatchObject({ phase: 'cancelled', result: { outcome: 'cancelled' } });

    const again = await s.post(`/api/lots/${lotId}/cancel`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('LOT_ALREADY_CANCELLED');
  });

  it('padrao estrito (producao): cancelar com lances responde 409 LOT_HAS_BIDS e nao estorna', async () => {
    const strict = createHttpHarness(db, { clock, allowCancelWithBids: false });
    const s = new Client(strict.app);
    expect((await s.register({ role: 'seller', displayName: 'Casa Estrita' })).res.status).toBe(
      201,
    );
    const bob = new Client(strict.app);
    expect((await bob.register({ role: 'bidder' })).res.status).toBe(201);
    expect((await bob.post('/api/wallet/deposits', { amount: reais(1_000) })).status).toBe(201);

    const created = await s.post('/api/lots', lotBody());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const lotId = created.body.lot.id as string;

    const semLances = await s.post(`/api/lots/${lotId}/bids`, { amount: reais(300) });
    expect(semLances.status).toBe(403); // leiloeiro nao da lance: a rota e so de licitante
    expect((await bob.post(`/api/lots/${lotId}/bids`, { amount: reais(300) })).status).toBe(201);

    const cancel = await s.post(`/api/lots/${lotId}/cancel`);
    expect(cancel.status).toBe(409);
    expect(cancel.body.error.code).toBe('LOT_HAS_BIDS');
    expect((await bob.get('/api/wallet')).body.committed).toBe(reais(300));
    const lot = (await request(strict.app).get(`/api/lots/${lotId}`)).body.lot;
    expect(lot.phase).toBe('live');
  });

  it('cancelar depois do fim liquida e responde 409 LOT_ENDED', async () => {
    const s = await seller();
    const bob = await bidder();
    const lotId = await liveLot(s);
    await bid(bob, lotId, reais(100));
    clock.advance(HOUR + MIN);
    const res = await s.post(`/api/lots/${lotId}/cancel`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LOT_ENDED');
    expect((await s.get('/api/wallet')).body.total).toBe(reais(100));
  });

  it('anti-sniping aparece na resposta do lance e o fim e prorrogado', async () => {
    const s = await seller();
    const bob = await bidder();
    const lotId = await liveLot(s);
    clock.advance(HOUR - MIN); // falta 1 minuto
    const res = await bid(bob, lotId, reais(100));
    expect(res.status).toBe(201);
    expect(res.body.extended).toBe(true);
    expect(new Date(res.body.endsAt).getTime()).toBe(clock.now().getTime() + 2 * MIN);
  });
});

describe('lances por HTTP: cada recusa tem codigo, status e detalhes uteis', () => {
  it('lance aceito: 201 com o formato esperado e sem vazar dado interno', async () => {
    const s = await seller();
    const bob = await bidder();
    const lotId = await liveLot(s);
    const res = await bid(bob, lotId, reais(100));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      replayed: false,
      bid: { seq: 1, amount: reais(100), placedAt: expect.any(String) },
      endsAt: expect.any(String),
      extended: false,
      bidCount: 1,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/hash|bidderId|userId/i);
  });

  it('abaixo do minimo -> 409 BELOW_MINIMUM com o minimo exigido', async () => {
    const s = await seller();
    const bob = await bidder();
    const lotId = await liveLot(s);
    const res = await bid(bob, lotId, reais(99));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'BELOW_MINIMUM',
      details: { minimumRequired: reais(100) },
    });
  });

  it('saldo insuficiente -> 409 INSUFFICIENT_FUNDS com o disponivel', async () => {
    const s = await seller();
    const poor = await bidder(reais(50));
    const lotId = await liveLot(s);
    const res = await bid(poor, lotId, reais(100));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
      details: { available: reais(50) },
    });
  });

  it('cobrir o proprio lance -> 409 ALREADY_LEADING', async () => {
    const s = await seller();
    const bob = await bidder();
    const lotId = await liveLot(s);
    await bid(bob, lotId, reais(100));
    const res = await bid(bob, lotId, reais(200));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_LEADING');
  });

  it('lote agendado -> 409 LOT_NOT_STARTED; encerrado -> LOT_ENDED; cancelado -> LOT_CANCELLED', async () => {
    const s = await seller();
    const bob = await bidder();
    const scheduled = await liveLot(
      s,
      lotBody({
        startsAt: iso(clock.now().getTime() + 2 * HOUR),
        endsAt: iso(clock.now().getTime() + 3 * HOUR),
      }),
    );
    expect((await bid(bob, scheduled, reais(100))).body.error.code).toBe('LOT_NOT_STARTED');

    const cancelled = await liveLot(s);
    await s.post(`/api/lots/${cancelled}/cancel`);
    expect((await bid(bob, cancelled, reais(100))).body.error.code).toBe('LOT_CANCELLED');

    const ending = await liveLot(s, { endsAt: iso(clock.now().getTime() + 5 * MIN) });
    clock.advance(6 * MIN);
    const ended = await bid(bob, ending, reais(100));
    expect(ended.status).toBe(409);
    expect(ended.body.error.code).toBe('LOT_ENDED');
  });

  it.each([
    ['string numerica', '100'],
    ['decimal', 100.5],
    ['negativo', -100],
    ['zero', 0],
    ['Infinity (vira null no JSON)', Number.POSITIVE_INFINITY],
    ['acima do teto', 10_000_000_01 * 100],
    ['null', null],
    ['objeto (injecao NoSQL)', { $gt: 0 }],
    ['array', [100]],
    ['booleano', true],
  ])('valor invalido (%s) -> 400', async (_n, amount) => {
    const s = await seller();
    const bob = await bidder();
    const lotId = await liveLot(s);
    const res = await bid(bob, lotId, amount);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('corpo sem amount, com array ou vazio -> 400 (nunca 500)', async () => {
    const s = await seller();
    const bob = await bidder();
    const lotId = await liveLot(s);
    for (const body of [{}, [], { valor: 100 }]) {
      expect((await bob.post(`/api/lots/${lotId}/bids`, body)).status).toBe(400);
    }
  });

  it.each([['abc'], ["' OR 1=1 --"], ['00000000-0000-0000-0000-00000000000'], ['..%2F..%2Fetc']])(
    'id de lote invalido (%s) -> 404 LOT_NOT_FOUND',
    async (id) => {
      const bob = await bidder();
      const res = await bid(bob, id, reais(100));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('LOT_NOT_FOUND');
    },
  );

  it('lote inexistente (UUID valido) -> 404', async () => {
    const bob = await bidder();
    const res = await bid(bob, '11111111-1111-4111-8111-111111111111', reais(100));
    expect(res.status).toBe(404);
  });

  it('campos extras no corpo (bidderId, status) sao ignorados', async () => {
    const s = await seller();
    const bob = await bidder();
    const eve = await bidder();
    const lotId = await liveLot(s);
    const res = await bob.post(`/api/lots/${lotId}/bids`, {
      amount: reais(100),
      bidderId: eve.userId,
      status: 'won',
    });
    expect(res.status).toBe(201);
    const audit = (await request(app()).get(`/api/lots/${lotId}/audit`)).body;
    expect(audit.integrity.intact).toBe(true);
    expect((await eve.get('/api/wallet')).body.committed).toBe(0);
    expect((await bob.get('/api/wallet')).body.committed).toBe(reais(100));
  });

  describe('idempotencia (Idempotency-Key)', () => {
    it('mesma chave duas vezes: 201 e depois 200 replayed, um unico lance', async () => {
      const s = await seller();
      const bob = await bidder();
      const lotId = await liveLot(s);
      const first = await bid(bob, lotId, reais(100), 'lance-chave-0001');
      const second = await bid(bob, lotId, reais(100), 'lance-chave-0001');
      expect([first.status, second.status]).toEqual([201, 200]);
      expect(second.body.replayed).toBe(true);
      expect((await request(app()).get(`/api/lots/${lotId}`)).body.lot.bidCount).toBe(1);
    });

    it('mesma chave com OUTRO valor -> 409 IDEMPOTENCY_KEY_REUSED', async () => {
      const s = await seller();
      const bob = await bidder();
      const lotId = await liveLot(s);
      await bid(bob, lotId, reais(100), 'lance-chave-0002');
      const res = await bid(bob, lotId, reais(105), 'lance-chave-0002');
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it.each([['curta'], ['tem espaco na chave'], ['a'.repeat(101)], ['chave;DROP TABLE bids']])(
      'chave invalida (%s) -> 400',
      async (key) => {
        const s = await seller();
        const bob = await bidder();
        const lotId = await liveLot(s);
        const res = await bid(bob, lotId, reais(100), key);
        expect(res.status).toBe(400);
        expect(res.body.error.details).toHaveProperty('idempotencyKey');
      },
    );

    it('10 requisicoes simultaneas com a mesma chave: um unico lance', async () => {
      const s = await seller();
      const bob = await bidder();
      const lotId = await liveLot(s);
      const results = await Promise.all(
        Array.from({ length: 10 }, () => bid(bob, lotId, reais(100), 'lance-paralelo-1')),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 200)).toHaveLength(9);
      expect((await request(app()).get(`/api/lots/${lotId}`)).body.lot.bidCount).toBe(1);
    });
  });

  it('12 licitantes disputando ao mesmo tempo: sem dinheiro criado, um lider, cadeia integra', async () => {
    const s = await seller();
    const lotId = await liveLot(s);
    const people = await Promise.all(
      Array.from({ length: 12 }, (_, i) => bidder(reais(10_000), `Disputa ${i}`)),
    );
    const results = await Promise.all(people.map((p, i) => bid(p, lotId, reais(100 + i * 5))));
    for (const r of results) expect([201, 409]).toContain(r.status);
    expect(results.some((r) => r.status === 201)).toBe(true);

    const lot = (await request(app()).get(`/api/lots/${lotId}`)).body.lot;
    const wallets = await Promise.all(people.map((p) => p.get('/api/wallet')));
    const committed = wallets.map((w) => w.body.committed as number);
    expect(committed.reduce((a, b) => a + b, 0)).toBe(lot.currentAmount);
    expect(committed.filter((c) => c > 0)).toHaveLength(1);
    const totals = wallets.map((w) => w.body.total as number);
    expect(totals.every((t) => t === reais(10_000))).toBe(true);
    expect((await request(app()).get(`/api/lots/${lotId}/audit`)).body.integrity.intact).toBe(true);
  });
});

describe('depositos por HTTP', () => {
  it('201 com saldo novo; repetir a mesma chave -> 200 replayed e saldo nao dobra', async () => {
    const bob = await bidder(0);
    const key = { 'Idempotency-Key': 'deposito-http-001' };
    const a = await bob.post('/api/wallet/deposits', { amount: reais(250) }, key);
    const b = await bob.post('/api/wallet/deposits', { amount: reais(250) }, key);
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(a.body).toEqual({
      total: reais(250),
      committed: 0,
      available: reais(250),
      replayed: false,
    });
    expect(b.body.replayed).toBe(true);
    expect((await bob.get('/api/wallet')).body.total).toBe(reais(250));
  });

  it.each([
    ['zero', 0],
    ['negativo', -1],
    ['decimal', 10.5],
    ['string', '100'],
    ['null', null],
    ['objeto', { amount: 1 }],
  ])('valor invalido (%s) -> 400', async (_n, amount) => {
    const bob = await bidder(0);
    const res = await bob.post('/api/wallet/deposits', { amount });
    expect(res.status).toBe(400);
  });

  it('acima do teto por deposito -> 422 DEPOSIT_TOO_LARGE; acima do saldo maximo -> 422', async () => {
    const bob = await bidder(0);
    const big = await bob.post('/api/wallet/deposits', { amount: reais(100_000) + 1 });
    expect(big.status).toBe(422);
    expect(big.body.error.code).toBe('DEPOSIT_TOO_LARGE');
  });
});

describe('privacidade e IDOR', () => {
  it('nenhuma resposta publica traz id interno, e-mail ou nome de licitante', async () => {
    const s = await seller('Leiloeiro Publico');
    const alice = await bidder(reais(5_000), 'Alice Segredo');
    const bob = await bidder(reais(5_000), 'Bob Segredo');
    const lotId = await liveLot(s);
    await bid(alice, lotId, reais(100));
    await bid(bob, lotId, reais(150));
    clock.advance(HOUR + MIN);

    const lot = await request(app()).get(`/api/lots/${lotId}`);
    const audit = await request(app()).get(`/api/lots/${lotId}/audit`);
    const list = await request(app()).get('/api/lots?phase=all&pageSize=50');
    const code = lot.body.lot.result.receiptCode as string;
    const receipt = await request(app()).get(`/api/receipts/${code}`);

    const aliceEmail = (await alice.get('/api/auth/me')).body.user.email as string;
    const bobEmail = (await bob.get('/api/auth/me')).body.user.email as string;
    const secrets = [
      alice.userId,
      bob.userId,
      aliceEmail,
      bobEmail,
      'Alice Segredo',
      'Bob Segredo',
      'password',
      'argon2',
    ];
    for (const [name, res] of [
      ['lot', lot],
      ['audit', audit],
      ['list', list],
      ['receipt', receipt],
    ] as [string, Response][]) {
      // Sem isso o teste passaria "vazio": um corpo de erro nunca contem segredo.
      expect(res.status, `${name}: ${JSON.stringify(res.body)}`).toBe(200);
      const text = JSON.stringify(res.body);
      for (const secret of secrets)
        expect(text, `${name} vaza ${String(secret)}`).not.toContain(String(secret));
    }
    // O nome do leiloeiro e publico (e a "marca" da casa), o dos licitantes nunca.
    expect(JSON.stringify(lot.body)).toContain('Leiloeiro Publico');
  });

  it('cada pessoa so ve a propria carteira e os proprios lances', async () => {
    const s = await seller();
    const alice = await bidder(reais(1_000));
    const bob = await bidder(reais(2_000));
    const lotId = await liveLot(s);
    await bid(alice, lotId, reais(100));

    expect((await alice.get('/api/wallet')).body).toMatchObject({
      total: reais(1_000),
      committed: reais(100),
    });
    expect((await bob.get('/api/wallet')).body).toMatchObject({
      total: reais(2_000),
      committed: 0,
    });
    expect((await bob.get('/api/me/bids')).body.items).toHaveLength(0);
    expect((await alice.get('/api/me/bids')).body.items).toHaveLength(1);
    // Parametros de usuario na URL sao ignorados: nao ha como pedir a carteira de outro.
    const sneaky = await bob.get(`/api/wallet?userId=${alice.userId}&user_id=${alice.userId}`);
    expect(sneaky.body.total).toBe(reais(2_000));
  });

  it('a sala marca "mine" e viewerDetail.ref so para quem esta logado e deu o lance', async () => {
    const s = await seller();
    const alice = await bidder();
    const bob = await bidder();
    const lotId = await liveLot(s);
    await bid(alice, lotId, reais(100));
    await bid(bob, lotId, reais(105));

    const asAlice = (await alice.get(`/api/lots/${lotId}`)).body.lot;
    expect(asAlice.bids.filter((b: { mine: boolean }) => b.mine)).toHaveLength(1);
    const mine = asAlice.bids.find((b: { mine: boolean }) => b.mine);
    expect(mine.bidder).toBe(asAlice.viewerDetail.ref);
    expect(asAlice.viewer).toEqual({ isSeller: false, isLeading: false });
    expect((await bob.get(`/api/lots/${lotId}`)).body.lot.viewer).toEqual({
      isSeller: false,
      isLeading: true,
    });
    expect((await s.get(`/api/lots/${lotId}`)).body.lot.viewer).toEqual({
      isSeller: true,
      isLeading: false,
    });

    const anon = (await request(app()).get(`/api/lots/${lotId}`)).body.lot;
    expect(anon.viewer).toBeNull();
    expect(anon.viewerDetail).toBeNull();
    expect(anon.bids.some((b: { mine: boolean }) => b.mine)).toBe(false);
  });

  it('a referencia do licitante muda de um lote para outro (nao permite rastrear a pessoa)', async () => {
    const s = await seller();
    const alice = await bidder();
    const lotA = await liveLot(s);
    const lotB = await liveLot(s);
    await bid(alice, lotA, reais(100));
    await bid(alice, lotB, reais(100));
    const refA = (await alice.get(`/api/lots/${lotA}`)).body.lot.viewerDetail.ref;
    const refB = (await alice.get(`/api/lots/${lotB}`)).body.lot.viewerDetail.ref;
    expect(refA).not.toBe(refB);
  });
});

describe('criar lote por HTTP', () => {
  it('o item vem do catalogo do servidor: titulo, imagem e atributos forjados no corpo sao ignorados', async () => {
    const s = await seller();
    const res = await s.post('/api/lots', {
      ...lotBody({ sourceId: '1002' }),
      item: {
        title: 'TITULO FORJADO',
        imageUrl: 'javascript:alert(1)',
        source: 'x',
        sourceId: '999',
        attributes: {},
      },
      sellerId: 'outro',
      status: 'closed',
      currentAmount: reais(999),
    });
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/api/lots/${res.body.lot.id}`);
    expect(res.body.lot).toMatchObject({
      title: 'Paisagem numero 2',
      status: 'open',
      currentAmount: null,
      bidCount: 0,
    });
    expect(res.body.lot.item).toMatchObject({ sourceId: '1002', source: 'cleveland' });
    expect(JSON.stringify(res.body)).not.toContain('FORJADO');
  });

  it.each([
    ['sem sourceId', {}],
    ['sourceId com ../', { sourceId: '../../etc/passwd' }],
    ['sourceId com espaco', { sourceId: '10 01' }],
    ['sourceId gigante', { sourceId: 'x'.repeat(101) }],
    ['sourceId numerico (tipo errado)', { sourceId: 1001 }],
    ['sourceId com ?', { sourceId: '1001?admin=1' }],
    ['sourceId com barra', { sourceId: '1001/../x' }],
  ])('%s -> 400 e o catalogo NAO e consultado', async (_n, over) => {
    const s = await seller();
    const before = http.catalog.calls.length;
    const res = await s.post('/api/lots', { ...lotBody(), sourceId: undefined, ...over });
    expect(res.status).toBe(400);
    expect(http.catalog.calls.length).toBe(before);
  });

  it('item inexistente -> 404 ITEM_NOT_FOUND e nenhum lote e criado', async () => {
    const s = await seller();
    const res = await s.post('/api/lots', lotBody({ sourceId: '999999' }));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ITEM_NOT_FOUND');
    expect((await s.get('/api/me/lots')).body.items).toHaveLength(0);
  });

  it.each([
    ['fim antes do inicio', () => ({ endsAt: iso(clock.now().getTime() - HOUR) }), 'endsAt'],
    [
      'duracao menor que 1 minuto',
      () => ({ endsAt: iso(clock.now().getTime() + 30_000) }),
      'endsAt',
    ],
    [
      'inicio no passado',
      () => ({
        startsAt: iso(clock.now().getTime() - HOUR),
        endsAt: iso(clock.now().getTime() + HOUR),
      }),
      'startsAt',
    ],
    ['lance inicial zero', () => ({ startingBid: 0 }), 'startingBid'],
    ['incremento negativo', () => ({ minIncrement: -5 }), 'minIncrement'],
    ['lance inicial decimal', () => ({ startingBid: 10.5 }), 'startingBid'],
    ['data invalida', () => ({ startsAt: 'amanha' }), 'startsAt'],
  ])('janela/valores invalidos (%s) -> 400 com detalhe do campo', async (_n, over, field) => {
    const s = await seller();
    const res = await s.post('/api/lots', lotBody(over()));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toHaveProperty(field);
  });
});

describe('contrato de erro uniforme', () => {
  it('todo erro da API tem code, message e requestId (nunca stack ou SQL)', async () => {
    const bob = await bidder();
    const responses = [
      await request(app()).get('/api/lots/abc'),
      await request(app()).get('/api/lots/11111111-1111-4111-8111-111111111111'),
      await request(app()).get('/api/me/bids'),
      await bob.get('/api/me/lots'),
      await bob.post('/api/lots/abc/bids', { amount: 1 }),
      await bob.post('/api/wallet/deposits', { amount: 'x' }),
      await request(app()).get('/api/nao-existe'),
    ];
    for (const res of responses) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.error).toEqual(
        expect.objectContaining({
          code: expect.any(String),
          message: expect.any(String),
          requestId: res.headers['x-request-id'],
        }),
      );
      expect(JSON.stringify(res.body)).not.toMatch(/\.ts:|node_modules|SELECT |pg_|at Object/);
    }
  });
});

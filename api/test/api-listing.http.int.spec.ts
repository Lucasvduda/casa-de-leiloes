import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HOUR, MIN, FakeClock, reais } from './support/harness.js';
import { Client, createHttpHarness } from './support/http-harness.js';
import type { HttpHarness } from './support/http-harness.js';
import { createTestDb } from './support/test-db.js';
import type { TestDb } from './support/test-db.js';

/**
 * Vitrine, busca, ordenacao, paginacao e extrato. Banco proprio: a vitrine e global, entao um
 * conjunto de lotes conhecido e a unica forma de afirmar "exatamente estes".
 *
 * Catalogo falso: itens 1001..1030; par = "Paisagem numero N", impar = "Retrato numero N";
 * multiplos de 3 sao de "Claude Monet".
 */
let db: TestDb;
let http: HttpHarness;
const clock = new FakeClock();
const app = () => http.app;
const iso = (ms: number) => new Date(ms).toISOString();

const lots: Record<string, string> = {}; // sourceId -> lotId
let alice: Client;
let bob: Client;
let seller1: Client;
let seller2: Client;

async function register(role: 'seller' | 'bidder', name: string, funds = 0): Promise<Client> {
  const c = new Client(app());
  expect((await c.register({ role, displayName: name })).res.status).toBe(201);
  if (funds > 0) expect((await c.post('/api/wallet/deposits', { amount: funds })).status).toBe(201);
  return c;
}

async function create(
  s: Client,
  sourceId: string,
  over: Record<string, unknown> = {},
): Promise<void> {
  const now = clock.now().getTime();
  const res = await s.post('/api/lots', {
    sourceId,
    startingBid: reais(100),
    minIncrement: reais(5),
    startsAt: iso(now),
    endsAt: iso(now + HOUR),
    ...over,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  lots[sourceId] = res.body.lot.id as string;
}

beforeAll(async () => {
  db = await createTestDb();
  http = createHttpHarness(db, { clock });
  seller1 = await register('seller', 'Leiloeiro Um');
  seller2 = await register('seller', 'Leiloeiro Dois');
  alice = await register('bidder', 'Alice', reais(100_000));
  bob = await register('bidder', 'Bob', reais(100_000));

  const t0 = clock.now().getTime();
  // Encerrados (precisam existir antes de o relogio andar): 1009 sem lances, 1010 vendido.
  await create(seller1, '1009', { endsAt: iso(t0 + 2 * MIN) });
  await create(seller2, '1010', { endsAt: iso(t0 + 2 * MIN) });
  expect((await alice.post(`/api/lots/${lots['1010']}/bids`, { amount: reais(100) })).status).toBe(
    201,
  );
  clock.advance(3 * MIN);
  expect((await request(app()).get(`/api/lots/${lots['1010']}`)).body.lot.phase).toBe('closed');

  const now = clock.now().getTime();
  // Ao vivo (seller1: 1001,1003,1005; seller2: 1002,1004,1006), preco e fim diferentes.
  const live: [string, Client, number, number][] = [
    ['1001', seller1, 100, 1],
    ['1002', seller2, 300, 2],
    ['1003', seller1, 200, 3],
    ['1004', seller2, 500, 4],
    ['1005', seller1, 400, 5],
    ['1006', seller2, 600, 6],
  ];
  for (const [id, s, price, hours] of live) {
    await create(s, id, { startingBid: reais(price), endsAt: iso(now + hours * HOUR) });
  }
  // 1003 recebe lances: o preco corrente (R$ 1.000) passa a ordenar no lugar do inicial.
  expect((await bob.post(`/api/lots/${lots['1003']}/bids`, { amount: reais(1_000) })).status).toBe(
    201,
  );
  // 1005: Alice lidera com R$ 450.
  expect((await alice.post(`/api/lots/${lots['1005']}/bids`, { amount: reais(450) })).status).toBe(
    201,
  );
  // Agendados.
  await create(seller1, '1007', { startsAt: iso(now + HOUR), endsAt: iso(now + 2 * HOUR) });
  await create(seller2, '1008', { startsAt: iso(now + 2 * HOUR), endsAt: iso(now + 3 * HOUR) });
  // Cancelado.
  await create(seller1, '1011');
  expect((await seller1.post(`/api/lots/${lots['1011']}/cancel`)).status).toBe(200);
});

afterAll(async () => {
  await db.close();
});

const ids = (res: request.Response): string[] =>
  (res.body.items as { id: string }[]).map((l) => l.id);
const idsOf = (...sourceIds: string[]): string[] => sourceIds.map((s) => lots[s]!);
const list = (query = '') => request(app()).get(`/api/lots${query}`);

describe('fases da vitrine', () => {
  it('sem parametros mostra so os lotes AO VIVO, os que acabam antes primeiro', async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual(idsOf('1001', '1002', '1003', '1004', '1005', '1006'));
    expect(res.body).toMatchObject({ total: 6, page: 1, pageSize: 12 });
    expect(typeof res.body.serverNow).toBe('string');
  });

  it.each([
    ['live', ['1001', '1002', '1003', '1004', '1005', '1006']],
    ['scheduled', ['1007', '1008']],
    ['finished', ['1009', '1010']],
    ['cancelled', ['1011']],
    [
      'all',
      ['1001', '1002', '1003', '1004', '1005', '1006', '1007', '1008', '1009', '1010', '1011'],
    ],
  ])('phase=%s traz exatamente os lotes dessa fase', async (phase, expected) => {
    const res = await list(`?phase=${phase}&pageSize=50`);
    expect(res.status).toBe(200);
    expect([...ids(res)].sort()).toEqual(idsOf(...expected).sort());
    expect(res.body.total).toBe(expected.length);
  });

  it('cada item informa a fase certa, o preco minimo do proximo lance e o resultado', async () => {
    const items = (await list('?phase=all&pageSize=50')).body.items as Record<string, unknown>[];
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.get(lots['1001'])).toMatchObject({
      phase: 'live',
      currentAmount: null,
      minimumNextBid: reais(100),
      bidCount: 0,
    });
    expect(byId.get(lots['1003'])).toMatchObject({
      phase: 'live',
      currentAmount: reais(1_000),
      minimumNextBid: reais(1_005),
      bidCount: 1,
    });
    expect(byId.get(lots['1007'])).toMatchObject({ phase: 'scheduled' });
    // Passou do fim e ninguem abriu a sala nem o agendador rodou: "ended" (apurando), nao "closed".
    expect(byId.get(lots['1009'])).toMatchObject({ phase: 'ended' });
    expect(byId.get(lots['1010'])).toMatchObject({ phase: 'closed', currentAmount: reais(100) });
    expect(byId.get(lots['1011'])).toMatchObject({ phase: 'cancelled' });
    expect(byId.get(lots['1001'])).toMatchObject({ sellerName: 'Leiloeiro Um' });
  });

  it('o relogio manda: um lote "aberto" cujo fim passou aparece em finished, nao em live', async () => {
    // 1009 nunca foi aberto nem liquidado explicitamente depois de vencer pela listagem.
    expect(ids(await list('?phase=live&pageSize=50'))).not.toContain(lots['1009']);
    expect(ids(await list('?phase=finished'))).toContain(lots['1009']);
  });
});

describe('ordenacao', () => {
  it('sort=ending: fim mais proximo primeiro', async () => {
    expect(ids(await list('?sort=ending'))).toEqual(
      idsOf('1001', '1002', '1003', '1004', '1005', '1006'),
    );
  });

  it('sort=price_asc / price_desc usam o preco CORRENTE (lance) quando existe, senao o inicial', async () => {
    // Precos efetivos: 1001=100, 1002=300, 1003=1000 (lance), 1004=500, 1005=450 (lance), 1006=600.
    expect(ids(await list('?sort=price_asc'))).toEqual(
      idsOf('1001', '1002', '1005', '1004', '1006', '1003'),
    );
    expect(ids(await list('?sort=price_desc'))).toEqual(
      idsOf('1003', '1006', '1004', '1005', '1002', '1001'),
    );
  });

  it('sort=newest: criados por ultimo primeiro; empates (mesmo instante) desempatam por id, de forma estavel', async () => {
    const a = ids(await list('?phase=all&sort=newest&pageSize=50'));
    const b = ids(await list('?phase=all&sort=newest&pageSize=50'));
    expect(a).toEqual(b);
    // 1009 e 1010 foram criados 3 minutos antes de todos os outros: ficam no fim.
    expect(a.slice(-2).sort()).toEqual(idsOf('1009', '1010').sort());
    // Paginar nao muda a ordem (sem o desempate, paginas poderiam repetir/pular itens).
    const paged = [
      ...ids(await list('?phase=all&sort=newest&pageSize=4&page=1')),
      ...ids(await list('?phase=all&sort=newest&pageSize=4&page=2')),
      ...ids(await list('?phase=all&sort=newest&pageSize=4&page=3')),
    ];
    expect(paged).toEqual(a);
  });
});

describe('paginacao', () => {
  it('paginas de 4 cobrem tudo sem repetir nem pular, e o total e o mesmo em todas', async () => {
    const seen: string[] = [];
    for (const [page, size] of [
      [1, 4],
      [2, 4],
      [3, 3],
    ] as const) {
      const res = await list(`?phase=all&sort=newest&pageSize=4&page=${page}`);
      expect(res.body.total).toBe(11);
      expect(res.body.items).toHaveLength(size);
      seen.push(...ids(res));
    }
    expect(new Set(seen).size).toBe(11);
    expect([...seen].sort()).toEqual(
      idsOf(
        '1001',
        '1002',
        '1003',
        '1004',
        '1005',
        '1006',
        '1007',
        '1008',
        '1009',
        '1010',
        '1011',
      ).sort(),
    );
  });

  it('pagina alem do fim: lista vazia, mas o total continua correto', async () => {
    const res = await list('?phase=all&pageSize=4&page=4');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe(11);
  });

  it('fase sem lotes: lista vazia, total 0', async () => {
    const res = await request(app()).get('/api/me/wins').set('Cookie', ''); // sem sessao -> 401
    expect(res.status).toBe(401);
    expect((await bob.get('/api/me/wins?pageSize=5')).body).toMatchObject({ items: [], total: 0 });
  });

  it.each([
    ['page=0', '?page=0'],
    ['page negativa', '?page=-1'],
    ['page decimal', '?page=1.5'],
    ['page texto', '?page=abc'],
    ['page gigante', '?page=10001'],
    ['pageSize=0', '?pageSize=0'],
    ['pageSize=51', '?pageSize=51'],
    ['pageSize decimal', '?pageSize=1.5'],
    ['phase desconhecida', '?phase=todas'],
    ['sort desconhecido', '?sort=random()'],
    ['q repetido (array)', '?q=a&q=b'],
    ['q com 101 caracteres', `?q=${'a'.repeat(101)}`],
    ['phase repetida', '?phase=live&phase=all'],
  ])('parametro invalido (%s) -> 400, nunca 500', async (_n, query) => {
    const res = await list(query);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('busca', () => {
  const titles = async (query: string) =>
    ((await list(`?phase=all&pageSize=50&${query}`)).body.items as { title: string }[]).map(
      (l) => l.title,
    );

  it('por titulo, sem diferenciar maiusculas', async () => {
    const found = await titles('q=PAISAGEM');
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((t) => t.startsWith('Paisagem'))).toBe(true);
    // Itens pares: 1002, 1004, 1006, 1008, 1010.
    expect(found).toHaveLength(5);
  });

  it('por artista (atributo do item) e por trecho', async () => {
    // Multiplos de 3: 1002? nao; 1001..1011 -> i = 3, 6, 9 => 1003, 1006, 1009.
    const res = await list('?phase=all&pageSize=50&q=monet');
    expect(ids(res).sort()).toEqual(idsOf('1003', '1006', '1009').sort());
  });

  it('% e _ digitados valem como texto literal (nao casam tudo)', async () => {
    for (const q of ['%25', '_', '%25%25', '%5C', '%25_%25']) {
      const res = await list(`?phase=all&pageSize=50&q=${q}`);
      expect(res.status).toBe(200);
      expect(res.body.total, `q=${q}`).toBe(0);
    }
  });

  it('injecao de SQL na busca e tratada como texto e nao altera nada', async () => {
    for (const q of [
      "'; DROP TABLE lots; --",
      "' OR '1'='1",
      '" OR 1=1 --',
      '%27)%20UNION%20SELECT%20*%20FROM%20users--',
    ]) {
      const res = await list(`?phase=all&q=${encodeURIComponent(decodeURIComponentSafe(q))}`);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(0);
    }
    expect((await list('?phase=all&pageSize=50')).body.total).toBe(11);
  });

  it('caracteres de controle viram espaco e q vazio equivale a sem busca', async () => {
    expect((await list('?phase=all&q=%00%01%02')).body.total).toBe(11);
    expect((await list('?phase=all&q=')).body.total).toBe(11);
    expect((await list('?phase=all&q=%20%20')).body.total).toBe(11);
  });

  it('acentos e emoji na busca nao quebram (UTF-8)', async () => {
    for (const q of ['cora%C3%A7%C3%A3o', '%F0%9F%8E%A8', 'Jos%C3%A9']) {
      const res = await list(`?phase=all&q=${q}`);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(0);
    }
  });

  it('busca combina com fase e ordenacao', async () => {
    const res = await list('?phase=live&q=retrato&sort=price_desc');
    // Ao vivo e impar: 1001, 1003, 1005 -> precos efetivos 100, 1000, 450.
    expect(ids(res)).toEqual(idsOf('1003', '1005', '1001'));
  });
});

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

describe('paineis da pessoa logada', () => {
  it('/me/lots mostra so os lotes do leiloeiro e o total recebido', async () => {
    const mine1 = (await seller1.get('/api/me/lots?pageSize=50')).body;
    expect(mine1.items.map((l: { id: string }) => l.id).sort()).toEqual(
      idsOf('1001', '1003', '1005', '1007', '1009', '1011').sort(),
    );
    expect(mine1.totals).toEqual({ received: 0, soldCount: 0 });

    const mine2 = (await seller2.get('/api/me/lots?pageSize=50')).body;
    expect(mine2.items.map((l: { id: string }) => l.id)).not.toContain(lots['1001']);
    // seller2 vendeu 1010 por R$ 100 para a Alice (liquidado ao abrir a sala).
    expect(mine2.totals).toEqual({ received: reais(100), soldCount: 1 });
  });

  it('/me/bids lista so onde a pessoa deu lance; /me/wins so o que ela arrematou', async () => {
    expect(
      (await alice.get('/api/me/bids?pageSize=50')).body.items
        .map((l: { id: string }) => l.id)
        .sort(),
    ).toEqual(idsOf('1005', '1010').sort());
    expect(
      (await bob.get('/api/me/bids?pageSize=50')).body.items.map((l: { id: string }) => l.id),
    ).toEqual(idsOf('1003'));
    const wins = (await alice.get('/api/me/wins')).body;
    expect(wins.items.map((l: { id: string }) => l.id)).toEqual(idsOf('1010'));
    expect(wins.items[0].receiptCode).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  });

  it('flags do espectador na listagem: lider/superado so para quem esta logado', async () => {
    const asAlice = (await alice.get('/api/lots?pageSize=50')).body.items as {
      id: string;
      viewer: { isLeading: boolean; isSeller: boolean };
    }[];
    expect(asAlice.find((l) => l.id === lots['1005'])!.viewer).toEqual({
      isSeller: false,
      isLeading: true,
    });
    expect(asAlice.find((l) => l.id === lots['1003'])!.viewer).toEqual({
      isSeller: false,
      isLeading: false,
    });
    const asSeller = (await seller1.get('/api/lots?pageSize=50')).body.items as typeof asAlice;
    expect(asSeller.find((l) => l.id === lots['1001'])!.viewer!.isSeller).toBe(true);
    expect(asSeller.find((l) => l.id === lots['1002'])!.viewer!.isSeller).toBe(false);
    const anon = (await list('?pageSize=50')).body.items as { viewer: unknown }[];
    expect(anon.every((l) => l.viewer === null)).toBe(true);
  });
});

describe('extrato da carteira', () => {
  it('tem os movimentos do mais novo ao mais antigo, com saldo apos cada um', async () => {
    const carol = await register('bidder', 'Carol');
    for (let i = 1; i <= 5; i++) {
      expect((await carol.post('/api/wallet/deposits', { amount: reais(10 * i) })).status).toBe(
        201,
      );
    }
    const wallet = (await carol.get('/api/wallet')).body;
    expect(wallet).toMatchObject({
      total: reais(150),
      committed: 0,
      available: reais(150),
      nextCursor: null,
    });
    expect(wallet.ledger.map((e: { amount: number }) => e.amount)).toEqual([
      reais(50),
      reais(40),
      reais(30),
      reais(20),
      reais(10),
    ]);
    expect(wallet.ledger[0]).toMatchObject({
      kind: 'deposit',
      totalAfter: reais(150),
      committedAfter: 0,
      lotId: null,
    });
  });

  it('cursor percorre tudo sem duplicar e termina com nextCursor nulo', async () => {
    const dave = await register('bidder', 'Dave');
    for (let i = 1; i <= 7; i++) await dave.post('/api/wallet/deposits', { amount: reais(i) });
    const seen: number[] = [];
    let before: number | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const url: string = `/api/wallet?limit=3${before === null ? '' : `&before=${before}`}`;
      const body = (await dave.get(url)).body;
      seen.push(...body.ledger.map((e: { id: number }) => e.id));
      if (body.nextCursor === null) break;
      before = body.nextCursor as number;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(seen).toEqual([...seen].sort((a, b) => b - a));
  });

  it('o extrato nao mostra movimentos de outra pessoa mesmo com cursor de outra pessoa', async () => {
    const erin = await register('bidder', 'Erin', reais(10));
    const fran = await register('bidder', 'Fran', reais(20));
    const erinIds = (await erin.get('/api/wallet')).body.ledger.map(
      (e: { id: number }) => e.id,
    ) as number[];
    const franBody = (await fran.get(`/api/wallet?before=${erinIds[0]! + 1}`)).body;
    for (const e of franBody.ledger as { id: number }[]) expect(erinIds).not.toContain(e.id);
    expect(franBody.total).toBe(reais(20));
  });

  it('lance e liquidacao aparecem no extrato com o lote', async () => {
    const wallet = (await alice.get('/api/wallet?limit=100')).body;
    const kinds = (wallet.ledger as { kind: string; lotTitle: string | null }[]).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['deposit']));
    expect(wallet.ledger.some((e: { lotTitle: string | null }) => e.lotTitle !== null)).toBe(true);
  });

  it.each([
    ['limit=0'],
    ['limit=101'],
    ['limit=abc'],
    ['before=0'],
    ['before=-5'],
    ['before=1.5'],
    ['before=abc'],
  ])('parametro invalido (%s) -> 400', async (query) => {
    const res = await alice.get(`/api/wallet?${query}`);
    expect(res.status).toBe(400);
  });
});

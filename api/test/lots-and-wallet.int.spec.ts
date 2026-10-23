import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_SINGLE_DEPOSIT_CENTS, MAX_WALLET_BALANCE_CENTS } from '../src/domain/wallet.js';
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

const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

/** Corpo valido de criacao; cada teste sobrescreve so o campo que quer estragar. */
function validInput(overrides: Record<string, unknown> = {}) {
  const now = h.clock.now().getTime();
  return {
    item: h.item('Obra valida'),
    startingBid: reais(100),
    minIncrement: reais(5),
    startsAt: iso(now),
    endsAt: iso(now + HOUR),
    ...overrides,
  };
}

const create = async (input: unknown, role: 'seller' | 'bidder' = 'seller') => {
  const actor = await h.seedUser(role);
  return h.createLot.execute({ actor, input });
};

const expectValidation = async (input: unknown, field?: string) => {
  const actor = await h.seedUser('seller');
  const error = await h.createLot.execute({ actor, input }).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, 'devia ter sido recusado').toMatchObject({ code: 'VALIDATION_ERROR' });
  if (field !== undefined) {
    expect((error as { details: Record<string, string> }).details).toHaveProperty(field);
  }
  const lots = await db.pool.query(`SELECT 1 FROM lots WHERE seller_id = $1`, [actor.id]);
  expect(lots.rowCount, 'recusa nao pode deixar lote para tras').toBe(0);
};

describe('criar lote: caminho feliz', () => {
  it('persiste o snapshot do item, nasce aberto e com a cadeia vazia auditavel', async () => {
    const seller = await h.seedUser('seller');
    const lot = await h.createLot.execute({ actor: seller, input: validInput() });

    const row = await h.lotRow(lot.id);
    expect(row).toMatchObject({
      status: 'open',
      bid_count: 0,
      head_seq: 0,
      leader_id: null,
      seller_id: seller.id,
    });
    expect(row.item).toMatchObject({
      source: 'artic',
      title: 'Obra valida',
      attributes: { artista: 'Fulano' },
    });

    const report = await h.audit.execute(lot.id);
    expect(report).toMatchObject({ bidCount: 0, integrity: { intact: true, issues: [] } });
  });

  it('o mesmo item pode virar varios lotes (a unicidade e do lote, nao do item)', async () => {
    const seller = await h.seedUser('seller');
    const a = await h.createLot.execute({ actor: seller, input: validInput() });
    const b = await h.createLot.execute({ actor: seller, input: validInput() });
    expect(a.id).not.toBe(b.id);
  });

  it('titulo com acentos, emoji e caracteres especiais e preservado', async () => {
    const title = 'Ação & "Paixão" <b>negrito</b> 🎨 日本';
    const lot = await create(validInput({ item: { ...h.item(), title } }));
    expect((await h.lotRow(lot.id)).title).toBe(title);
  });

  it('mass assignment: campos que o cliente nao pode definir sao ignorados', async () => {
    const seller = await h.seedUser('seller');
    const other = await h.seedUser('seller', 'outro');
    const lot = await h.createLot.execute({
      actor: seller,
      input: validInput({
        status: 'closed',
        sellerId: other.id,
        seller_id: other.id,
        currentAmount: reais(999),
        leaderId: other.id,
        bidCount: 50,
        id: '11111111-1111-4111-8111-111111111111',
      }),
    });
    expect(lot.id).not.toBe('11111111-1111-4111-8111-111111111111');
    expect(await h.lotRow(lot.id)).toMatchObject({
      status: 'open',
      seller_id: seller.id,
      current_amount_cents: null,
      leader_id: null,
      bid_count: 0,
    });
  });
});

describe('criar lote: permissao', () => {
  it('comprador nao cria lote', async () => {
    await expect(create(validInput(), 'bidder')).rejects.toMatchObject({
      code: 'ONLY_SELLERS_CAN_CREATE_LOTS',
    });
  });
});

describe('criar lote: janela de tempo (fronteiras exatas)', () => {
  const now = () => h.clock.now().getTime();

  it('inicio ate 60s no passado e tolerado (relogio do navegador); 61s nao', async () => {
    await expect(
      create(validInput({ startsAt: iso(now() - 60_000), endsAt: iso(now() + HOUR) })),
    ).resolves.toBeDefined();
    await expectValidation(
      validInput({ startsAt: iso(now() - 61_000), endsAt: iso(now() + HOUR) }),
      'startsAt',
    );
  });

  it('inicio a ate 1 ano no futuro vale; alem disso nao', async () => {
    const year = 365 * DAY;
    await expect(
      create(validInput({ startsAt: iso(now() + year), endsAt: iso(now() + year + HOUR) })),
    ).resolves.toBeDefined();
    await expectValidation(
      validInput({ startsAt: iso(now() + year + 1), endsAt: iso(now() + year + HOUR) }),
      'startsAt',
    );
  });

  it('duracao minima de 1 minuto (59.999 ms nao); maxima de 30 dias (+1 ms nao)', async () => {
    const s = now();
    await expect(
      create(validInput({ startsAt: iso(s), endsAt: iso(s + MIN) })),
    ).resolves.toBeDefined();
    await expectValidation(validInput({ startsAt: iso(s), endsAt: iso(s + MIN - 1) }), 'endsAt');
    await expect(
      create(validInput({ startsAt: iso(s), endsAt: iso(s + 30 * DAY) })),
    ).resolves.toBeDefined();
    await expectValidation(
      validInput({ startsAt: iso(s), endsAt: iso(s + 30 * DAY + 1) }),
      'endsAt',
    );
  });

  it('fim antes do inicio e fim igual ao inicio sao recusados', async () => {
    const s = now();
    await expectValidation(validInput({ startsAt: iso(s + HOUR), endsAt: iso(s) }), 'endsAt');
    await expectValidation(validInput({ startsAt: iso(s), endsAt: iso(s) }), 'endsAt');
  });

  it.each([
    ['texto livre', 'amanha'],
    ['data impossivel', '2026-13-45T00:00:00Z'],
    ['sem fuso horario (ambiguo)', '2026-11-01T12:00:00'],
    ['so a data', '2026-11-01'],
    ['numero (timestamp)', 1_800_000_000_000],
    ['null', null],
    ['objeto', {}],
    ['vazio', ''],
  ])('data invalida (%s) -> VALIDATION_ERROR', async (_name, value) => {
    await expectValidation(validInput({ startsAt: value }), 'startsAt');
    await expectValidation(validInput({ endsAt: value }), 'endsAt');
  });

  it('aceita fuso com offset (-03:00) e converte para o mesmo instante', async () => {
    const s = now();
    const offset = '2026-11-01T09:00:00.000-03:00'; // == 12:00Z, o relogio do teste
    expect(new Date(offset).getTime()).toBe(s);
    const lot = await create(validInput({ startsAt: offset, endsAt: iso(s + HOUR) }));
    expect(lot.startsAt.toISOString()).toBe(iso(s));
  });
});

describe('criar lote: valores em dinheiro', () => {
  const bad: [string, unknown][] = [
    ['zero', 0],
    ['negativo', -100],
    ['decimal', 100.5],
    ['string numerica', '100'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['acima do teto da carteira', MAX_WALLET_BALANCE_CENTS + 1],
    ['acima de 2^53', 2 ** 53],
    ['null', null],
    ['objeto', { $gt: 0 }],
  ];
  it.each(bad)('lance inicial invalido (%s)', async (_n, value) => {
    await expectValidation(validInput({ startingBid: value }), 'startingBid');
  });
  it.each(bad)('incremento minimo invalido (%s)', async (_n, value) => {
    await expectValidation(validInput({ minIncrement: value }), 'minIncrement');
  });

  it('1 centavo de lance inicial e de incremento sao validos; o teto exato tambem', async () => {
    await expect(create(validInput({ startingBid: 1, minIncrement: 1 }))).resolves.toBeDefined();
    await expect(
      create(
        validInput({
          startingBid: MAX_WALLET_BALANCE_CENTS,
          minIncrement: MAX_WALLET_BALANCE_CENTS,
        }),
      ),
    ).resolves.toBeDefined();
  });
});

describe('criar lote: item vindo de fora (a API publica nao e confiavel)', () => {
  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['ftp:', 'ftp://exemplo.com/a.jpg'],
    ['file:', 'file:///etc/passwd'],
    ['sem esquema', 'www.artic.edu/a.jpg'],
    ['texto', 'nao e url'],
    ['mais de 2048 caracteres', `https://a.com/${'x'.repeat(2100)}`],
  ])('imageUrl com %s e recusada', async (_n, imageUrl) => {
    await expectValidation(validInput({ item: { ...h.item(), imageUrl } }), 'item.imageUrl');
  });

  it('sourceUrl com esquema perigoso tambem e recusada', async () => {
    await expectValidation(
      validInput({ item: { ...h.item(), sourceUrl: 'javascript:alert(1)' } }),
      'item.sourceUrl',
    );
  });

  it('imageUrl e sourceUrl nulas sao aceitas (obra sem imagem)', async () => {
    const lot = await create(
      validInput({ item: { ...h.item(), imageUrl: null, sourceUrl: null } }),
    );
    expect(lot.item.imageUrl).toBeNull();
  });

  it.each([
    ['vazio', ''],
    ['so espacos', '    '],
    ['so caracteres de controle', '\u0000\u0007\n\t'],
    ['mais de 300 caracteres', 'x'.repeat(301)],
    ['numero', 123],
    ['null', null],
  ])('titulo invalido (%s)', async (_n, title) => {
    await expectValidation(validInput({ item: { ...h.item(), title } }), 'item.title');
  });

  it('titulo no limite de 300 caracteres e aceito', async () => {
    const lot = await create(validInput({ item: { ...h.item(), title: 'x'.repeat(300) } }));
    expect(lot.title).toHaveLength(300);
  });

  it('caracteres de controle (inclusive NUL, que o Postgres rejeitaria) viram espaco e sao aparados', async () => {
    const lot = await create(
      validInput({ item: { ...h.item(), title: '  Nome\u0000com\nquebra\u0007  ' } }),
    );
    expect(lot.title).toBe('Nome com quebra');
    expect((await h.lotRow(lot.id)).title).toBe('Nome com quebra');
  });

  it('mais de 20 atributos e recusado; 20 e aceito', async () => {
    const attrs = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, `v${i}`]));
    await expectValidation(
      validInput({ item: { ...h.item(), attributes: attrs(21) } }),
      'item.attributes',
    );
    await expect(
      create(validInput({ item: { ...h.item(), attributes: attrs(20) } })),
    ).resolves.toBeDefined();
  });

  it('atributo com valor gigante e recusado', async () => {
    await expectValidation(
      validInput({ item: { ...h.item(), attributes: { k: 'x'.repeat(501) } } }),
    );
  });

  it('chaves perigosas (__proto__, constructor) nao poluem o prototipo nem quebram', async () => {
    const attributes = JSON.parse('{"__proto__":"x","constructor":"y","toString":"z"}') as Record<
      string,
      string
    >;
    const lot = await create(validInput({ item: { ...h.item(), attributes } }));
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(lot.id).toBeDefined();
  });

  it('o lote guarda uma COPIA: nenhum dado do item depende de nova chamada externa', async () => {
    const lot = await create(validInput());
    const row = await h.lotRow(lot.id);
    expect((row.item as { title: string; imageUrl: string }).imageUrl).toContain('https://');
    expect((await h.audit.execute(lot.id)).lot.title).toBe('Obra valida');
  });
});

describe('criar lote: corpo hostil', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['string', 'texto'],
    ['numero', 42],
    ['array', []],
    ['objeto vazio', {}],
    [
      'sem item',
      {
        startingBid: 1,
        minIncrement: 1,
        startsAt: '2026-11-01T12:00:00Z',
        endsAt: '2026-11-01T13:00:00Z',
      },
    ],
  ])('%s -> VALIDATION_ERROR', async (_n, body) => {
    await expectValidation(body);
  });
});

describe('deposito: caminho feliz e papel', () => {
  it('soma ao saldo e grava uma linha de extrato', async () => {
    const alice = await h.seedUser('bidder');
    const r = await h.deposit.execute(alice, { amount: reais(250) });
    expect(r).toEqual({ total: reais(250), committed: 0, available: reais(250), replayed: false });
    const ledger = await db.pool.query(
      `SELECT kind, amount_cents, total_after_cents FROM wallet_ledger WHERE user_id = $1`,
      [alice.id],
    );
    expect(ledger.rows).toEqual([
      { kind: 'deposit', amount_cents: String(reais(250)), total_after_cents: String(reais(250)) },
    ]);
  });

  it('leiloeiro nao deposita', async () => {
    const seller = await h.seedUser('seller');
    await expect(h.deposit.execute(seller, { amount: reais(10) })).rejects.toMatchObject({
      code: 'ONLY_BIDDERS_CAN_DEPOSIT',
    });
    expect((await h.walletOf(seller.id)).total).toBe(0);
  });

  it('o disponivel respeita o que esta comprometido em lances', async () => {
    const seller = await h.seedUser('seller');
    const alice = await h.seedUser('bidder');
    await h.deposit.execute(alice, { amount: reais(500) });
    const lot = await h.newLot(seller);
    await h.placeBid.execute({ actor: alice, lotId: lot.id, amount: reais(200) });
    const r = await h.deposit.execute(alice, { amount: reais(100) });
    expect(r).toMatchObject({ total: reais(600), committed: reais(200), available: reais(400) });
  });
});

describe('deposito: limites e entrada hostil', () => {
  it.each([
    ['zero', 0],
    ['negativo', -1],
    ['decimal', 10.5],
    ['string', '100'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['2^53', 2 ** 53],
    ['null', null],
    ['undefined', undefined],
    ['array', [100]],
    ['objeto', { amount: 100 }],
    ['booleano', true],
  ])('valor invalido (%s) -> VALIDATION_ERROR e saldo intacto', async (_n, amount) => {
    const alice = await h.seedUser('bidder');
    await expect(h.deposit.execute(alice, { amount })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect((await h.walletOf(alice.id)).total).toBe(0);
  });

  it('o teto por deposito e exato: R$ 100.000,00 passa, +1 centavo nao', async () => {
    const alice = await h.seedUser('bidder');
    await expect(
      h.deposit.execute(alice, { amount: MAX_SINGLE_DEPOSIT_CENTS }),
    ).resolves.toBeDefined();
    await expect(
      h.deposit.execute(alice, { amount: MAX_SINGLE_DEPOSIT_CENTS + 1 }),
    ).rejects.toMatchObject({
      code: 'DEPOSIT_TOO_LARGE',
    });
    expect((await h.walletOf(alice.id)).total).toBe(MAX_SINGLE_DEPOSIT_CENTS);
  });

  it('o teto de saldo da carteira e exato: R$ 10.000.000,00 passa, +1 centavo nao', async () => {
    const alice = await h.seedUser('bidder');
    await h.fund(alice, MAX_WALLET_BALANCE_CENTS);
    expect((await h.walletOf(alice.id)).total).toBe(MAX_WALLET_BALANCE_CENTS);
    await expect(h.deposit.execute(alice, { amount: 1 })).rejects.toMatchObject({
      code: 'WALLET_LIMIT_EXCEEDED',
    });
    expect((await h.walletOf(alice.id)).total).toBe(MAX_WALLET_BALANCE_CENTS);
  });
});

describe('deposito: idempotencia (duplo clique e retry de rede nao duplicam saldo)', () => {
  it('mesma chave: soma uma vez e marca replayed', async () => {
    const alice = await h.seedUser('bidder');
    const key = 'deposito-aaaa-0001';
    const a = await h.deposit.execute(alice, { amount: reais(100), idempotencyKey: key });
    const b = await h.deposit.execute(alice, { amount: reais(100), idempotencyKey: key });
    expect(a.replayed).toBe(false);
    expect(b).toMatchObject({ replayed: true, total: reais(100) });
    expect((await h.walletOf(alice.id)).total).toBe(reais(100));
  });

  it('mesma chave com OUTRO valor -> IDEMPOTENCY_KEY_REUSED', async () => {
    const alice = await h.seedUser('bidder');
    const key = 'deposito-aaaa-0002';
    await h.deposit.execute(alice, { amount: reais(100), idempotencyKey: key });
    await expect(
      h.deposit.execute(alice, { amount: reais(101), idempotencyKey: key }),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect((await h.walletOf(alice.id)).total).toBe(reais(100));
  });

  it('o escopo da chave e a OPERACAO: a mesma chave em lance e em deposito sao independentes', async () => {
    const seller = await h.seedUser('seller');
    const alice = await h.seedUser('bidder');
    await h.fund(alice, reais(1_000));
    const lot = await h.newLot(seller);
    const key = 'compartilhada-0001';
    const bidResult = await h.placeBid.execute({
      actor: alice,
      lotId: lot.id,
      amount: reais(100),
      idempotencyKey: key,
    });
    expect(bidResult).toMatchObject({ accepted: true, replayed: false });

    // O deposito com a mesma chave e uma operacao nova (aplicada UMA vez; repeti-la e replay).
    const first = await h.deposit.execute(alice, { amount: reais(50), idempotencyKey: key });
    const again = await h.deposit.execute(alice, { amount: reais(50), idempotencyKey: key });
    expect([first.replayed, again.replayed]).toEqual([false, true]);
    expect((await h.walletOf(alice.id)).total).toBe(reais(1_050));

    // E o lance continua idempotente na sua propria chave.
    const bidAgain = await h.placeBid.execute({
      actor: alice,
      lotId: lot.id,
      amount: reais(100),
      idempotencyKey: key,
    });
    expect(bidAgain).toMatchObject({ accepted: true, replayed: true });
  });

  it('pessoas diferentes podem usar a mesma chave sem colidir', async () => {
    const a = await h.seedUser('bidder');
    const b = await h.seedUser('bidder');
    const key = 'mesma-chave-0001';
    await h.deposit.execute(a, { amount: reais(10), idempotencyKey: key });
    const r = await h.deposit.execute(b, { amount: reais(20), idempotencyKey: key });
    expect(r).toMatchObject({ replayed: false, total: reais(20) });
  });

  it.each([['curta'], ['tem espaco na chave'], ['a'.repeat(101)], ['chave;DROP TABLE x'], [42]])(
    'chave invalida (%s) -> VALIDATION_ERROR',
    async (key) => {
      const alice = await h.seedUser('bidder');
      await expect(
        h.deposit.execute(alice, { amount: reais(10), idempotencyKey: key }),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    },
  );

  it('10 requisicoes simultaneas com a mesma chave: soma UMA vez', async () => {
    const alice = await h.seedUser('bidder');
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        h.deposit.execute(alice, { amount: reais(100), idempotencyKey: 'paralelo-0001' }),
      ),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect((await h.walletOf(alice.id)).total).toBe(reais(100));
  });

  it('20 depositos simultaneos com chaves distintas: nenhuma atualizacao se perde', async () => {
    const alice = await h.seedUser('bidder');
    await Promise.all(
      Array.from({ length: 20 }, () => h.deposit.execute(alice, { amount: reais(100) })),
    );
    expect((await h.walletOf(alice.id)).total).toBe(reais(2_000));
    const rows = await db.pool.query(
      `SELECT count(*)::int AS n FROM wallet_ledger WHERE user_id = $1`,
      [alice.id],
    );
    expect(rows.rows[0].n).toBe(20);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { ClevelandCatalog } from '../../src/adapters/outbound/catalog/cleveland-catalog.js';
import type { ClevelandCatalogOptions } from '../../src/adapters/outbound/catalog/cleveland-catalog.js';
import { OFFLINE_ITEMS } from '../../src/adapters/outbound/catalog/offline-catalog.data.js';
import { CatalogUnavailableError, NotFoundError } from '../../src/application/errors.js';
import {
  FakeUpstream,
  artwork,
  itemBody,
  jsonResponse,
  searchBody,
  snapshot,
} from '../support/fake-upstream.js';
import type { Handler } from '../support/fake-upstream.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const OFFLINE = [
  snapshot(901, 'Paisagem Offline', 'Claude Monet'),
  snapshot(902, 'Retrato Offline'),
  snapshot(903, 'Natureza Morta Offline'),
];

function setup(handler: Handler, over: Partial<ClevelandCatalogOptions> = {}) {
  const clock = { t: 1_000_000 };
  const up = new FakeUpstream(handler);
  const sleeps: number[] = [];
  const warn = vi.fn();
  const catalog = new ClevelandCatalog({
    fetch: up.fetch,
    now: () => clock.t,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
    logger: { warn },
    offlineItems: OFFLINE,
    timeoutMs: 100,
    retries: 0,
    breakerFailureThreshold: 3,
    breakerOpenMs: 30_000,
    ...over,
  });
  return { catalog, up, clock, sleeps, warn };
}

const ok =
  (...ids: number[]): Handler =>
  () =>
    jsonResponse(
      searchBody(
        ids.map((id) => artwork(id)),
        ids.length,
      ),
    );
const down: Handler = () => new Response('boom', { status: 500 });

describe('busca: chamada a API', () => {
  it('monta a URL com os filtros fixos (CC0, com imagem, paginacao) e devolve o resultado', async () => {
    const { catalog, up } = setup(() => jsonResponse(searchBody([artwork(1), artwork(2)], 18)));
    const result = await catalog.search('monet', 1);
    expect(result).toMatchObject({ total: 18, page: 1, pageSize: 12, degraded: false });
    expect(result.items.map((i) => i.sourceId)).toEqual(['1', '2']);

    const url = new URL(up.calls[0]!.url);
    expect(url.origin + url.pathname).toBe('https://openaccess-api.clevelandart.org/api/artworks/');
    const p = up.params(0);
    expect(Object.fromEntries(p)).toMatchObject({
      q: 'monet',
      has_image: '1',
      cc0: '1',
      limit: '12',
      skip: '0',
    });
    expect(p.get('fields')).toContain('creators');
  });

  it('termo vazio nao envia q; a pagina vira skip', async () => {
    const { catalog, up } = setup(ok(1));
    await catalog.search('   ', 3);
    expect(up.params(0).has('q')).toBe(false);
    expect(up.params(0).get('skip')).toBe('24');
  });

  it.each([
    'Monet & Sons #1 100% ação "x"',
    'a&limit=999',
    'a&cc0=0&has_image=0',
    'x=1;y=2',
    '../../etc/passwd',
    '😀 emoji',
    'quebra\nde linha',
  ])('termo hostil %j vai codificado: nao injeta parametro', async (q) => {
    const { catalog, up } = setup(ok(1));
    await catalog.search(q, 1);
    const p = up.params(0);
    expect(p.getAll('q')).toEqual([q.trim()]);
    expect(p.getAll('limit')).toEqual(['12']);
    expect(p.getAll('cc0')).toEqual(['1']);
    expect(p.getAll('has_image')).toEqual(['1']);
  });

  it('transitorio: 500 e depois 200 -> sucesso normal (nao degradado), com backoff', async () => {
    const { catalog, up, sleeps } = setup(
      (_u, i) =>
        i === 0 ? new Response('x', { status: 500 }) : jsonResponse(searchBody([artwork(1)])),
      {
        retries: 1,
      },
    );
    const result = await catalog.search('a', 1);
    expect(result.degraded).toBe(false);
    expect(up.calls).toHaveLength(2);
    expect(sleeps).toEqual([188]); // 250 * 0.75
  });

  it('erro definitivo (403) nao e repetido', async () => {
    const { catalog, up } = setup(() => new Response('x', { status: 403 }), { retries: 3 });
    const result = await catalog.search('a', 1);
    expect(result.degraded).toBe(true);
    expect(up.calls).toHaveLength(1);
  });
});

describe('busca: cache', () => {
  it('chamada repetida dentro do prazo nao vai a API (e ignora caixa e espacos)', async () => {
    const { catalog, up } = setup(ok(1, 2));
    await catalog.search('Monet', 1);
    await catalog.search('  monet ', 1);
    await catalog.search('MONET', 1);
    expect(up.calls).toHaveLength(1);
    await catalog.search('monet', 2);
    await catalog.search('outro', 1);
    expect(up.calls).toHaveLength(3);
  });

  it('depois do prazo de frescor consulta de novo', async () => {
    const { catalog, up, clock } = setup(ok(1));
    await catalog.search('a', 1);
    clock.t += 10 * MIN - 1;
    await catalog.search('a', 1);
    expect(up.calls).toHaveLength(1);
    clock.t += 2;
    await catalog.search('a', 1);
    expect(up.calls).toHaveLength(2);
  });

  it('chamadas simultaneas iguais viram UMA so ao upstream', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { catalog, up } = setup(async () => {
      await gate;
      return jsonResponse(searchBody([artwork(1)]));
    });
    const all = Promise.all(Array.from({ length: 25 }, () => catalog.search('monet', 1)));
    await new Promise((r) => setTimeout(r, 10));
    release();
    const results = await all;
    expect(up.calls).toHaveLength(1);
    expect(new Set(results.map((r) => r.items[0]?.sourceId)).size).toBe(1);
  });

  it('o inflight e liberado mesmo na falha (a proxima chamada tenta de novo)', async () => {
    const { catalog, up } = setup((_u, i) =>
      i === 0 ? new Response('x', { status: 500 }) : jsonResponse(searchBody([artwork(1)])),
    );
    expect((await catalog.search('a', 1)).degraded).toBe(true);
    expect((await catalog.search('a', 1)).degraded).toBe(false);
    expect(up.calls).toHaveLength(2);
  });

  it('o cache e limitado (LRU): termos arbitrarios nao crescem a memoria sem fim', async () => {
    const { catalog, up } = setup(ok(1), { cacheEntries: 3 });
    for (const q of ['a', 'b', 'c', 'd', 'e']) await catalog.search(q, 1);
    expect(up.calls).toHaveLength(5);
    await catalog.search('e', 1); // recente: segue em cache
    expect(up.calls).toHaveLength(5);
    await catalog.search('a', 1); // o mais antigo foi expulso
    expect(up.calls).toHaveLength(6);
  });
});

describe('busca: degradacao em camadas (cache vencido -> offline)', () => {
  it('API caiu e ha cache vencido: serve o cache, marcado como degradado', async () => {
    const { catalog, up, clock } = setup((_u, i) =>
      i === 0
        ? jsonResponse(searchBody([artwork(1), artwork(2)], 2))
        : new Response('x', { status: 503 }),
    );
    const fresh = await catalog.search('monet', 1);
    expect(fresh.degraded).toBe(false);
    clock.t += 11 * MIN;
    const stale = await catalog.search('monet', 1);
    expect(up.calls).toHaveLength(2);
    expect(stale).toMatchObject({ degraded: true, total: 2 });
    expect(stale.items.map((i) => i.sourceId)).toEqual(['1', '2']);
  });

  it('cache velho demais (alem de 24h) nao serve: cai para o catalogo offline', async () => {
    const { catalog, clock } = setup((_u, i) =>
      i === 0 ? jsonResponse(searchBody([artwork(1)])) : new Response('x', { status: 500 }),
    );
    await catalog.search('monet', 1);
    clock.t += 25 * HOUR;
    const result = await catalog.search('monet', 1);
    expect(result.degraded).toBe(true);
    expect(result.items.map((i) => i.sourceId)).toEqual(['901']); // "monet" casa o artista do item offline
  });

  it('sem cache nenhum: offline filtra por titulo ou artista, sem diferenciar caixa', async () => {
    const { catalog } = setup(down);
    expect((await catalog.search('PAISAGEM', 1)).items.map((i) => i.sourceId)).toEqual(['901']);
    expect((await catalog.search('retrato', 1)).items.map((i) => i.sourceId)).toEqual(['902']);
    const none = await catalog.search('zzzz', 1);
    expect(none).toMatchObject({ items: [], total: 0, degraded: true });
  });

  it('sem termo: lista o offline inteiro, paginado', async () => {
    const { catalog } = setup(down, { pageSize: 2 });
    const p1 = await catalog.search('', 1);
    const p2 = await catalog.search('', 2);
    const p3 = await catalog.search('', 3);
    expect([p1.items.length, p2.items.length, p3.items.length]).toEqual([2, 1, 0]);
    expect([p1.total, p2.total, p3.total]).toEqual([3, 3, 3]);
    expect(p1).toMatchObject({ page: 1, pageSize: 2, degraded: true });
  });

  it('o catalogo offline embutido de producao e valido e cobre uma pagina inteira', async () => {
    const real = new ClevelandCatalog({
      fetch: new FakeUpstream(down).fetch,
      retries: 0,
      offlineItems: OFFLINE_ITEMS,
    });
    const page = await real.search('', 1);
    expect(page.degraded).toBe(true);
    expect(page.items).toHaveLength(12);
    expect(page.total).toBeGreaterThanOrEqual(30);
    for (const item of OFFLINE_ITEMS) {
      expect(item.sourceId).toMatch(/^[0-9]{1,12}$/);
      expect(new URL(item.imageUrl!).hostname).toBe('openaccess-cdn.clevelandart.org');
    }
    expect(new Set(OFFLINE_ITEMS.map((i) => i.sourceId)).size).toBe(OFFLINE_ITEMS.length);
  });

  it('rede caida e timeout tambem degradam (nunca propagam erro na busca)', async () => {
    const network = setup(() => Promise.reject(new TypeError('fetch failed')));
    expect((await network.catalog.search('a', 1)).degraded).toBe(true);
    const hang = setup(() => new Promise<Response>(() => undefined), { timeoutMs: 30 });
    expect((await hang.catalog.search('a', 1)).degraded).toBe(true);
    expect(hang.warn.mock.calls[0]![0]).toMatchObject({ operation: 'search', kind: 'timeout' });
  });

  it('registra o motivo do fallback sem vazar o termo digitado', async () => {
    const { catalog, warn } = setup(down);
    await catalog.search('termo-privado-do-usuario', 1);
    expect(warn).toHaveBeenCalledTimes(1);
    const [data, message] = warn.mock.calls[0]!;
    expect(data).toMatchObject({ operation: 'search', kind: 'http', status: 500 });
    expect(JSON.stringify([data, message])).not.toContain('termo-privado');
  });
});

describe('circuit breaker no catalogo', () => {
  it('apos N falhas para de chamar a API (responde na hora, pelo fallback) e volta depois do periodo', async () => {
    let healthy = false;
    const { catalog, up, clock } = setup(() =>
      healthy ? jsonResponse(searchBody([artwork(1)])) : new Response('x', { status: 500 }),
    );

    for (const q of ['a', 'b', 'c']) expect((await catalog.search(q, 1)).degraded).toBe(true);
    expect(up.calls).toHaveLength(3);

    // Circuito aberto: nenhuma chamada nova, mas a busca continua respondendo (offline).
    for (const q of ['d', 'e', 'f', 'g']) expect((await catalog.search(q, 1)).degraded).toBe(true);
    expect(up.calls).toHaveLength(3);
    await expect(catalog.search('retrato', 1)).resolves.toMatchObject({
      items: [expect.objectContaining({ sourceId: '902' })],
    });

    // Passou o periodo e a sonda falha: reabre.
    clock.t += 30_000;
    await catalog.search('h', 1);
    expect(up.calls).toHaveLength(4);
    await catalog.search('i', 1);
    expect(up.calls).toHaveLength(4);

    // Passou de novo, API saudavel: a sonda fecha o circuito.
    healthy = true;
    clock.t += 30_000;
    expect((await catalog.search('j', 1)).degraded).toBe(false);
    expect((await catalog.search('k', 1)).degraded).toBe(false);
    expect(up.calls).toHaveLength(6);
  });

  it('item inexistente (404) e resposta valida: milhares de 404 nao abrem o circuito', async () => {
    const { catalog, up } = setup((url) =>
      url.includes('/artworks/?')
        ? jsonResponse(searchBody([artwork(1)]))
        : new Response('nao', { status: 404 }),
    );
    for (let i = 1; i <= 20; i++) {
      await expect(catalog.getItem(String(100_000 + i))).rejects.toBeInstanceOf(NotFoundError);
    }
    expect((await catalog.search('a', 1)).degraded).toBe(false);
    expect(up.calls).toHaveLength(21);
  });

  it('payload invalido conta como falha (a API mudou ou foi adulterada)', async () => {
    const { catalog, up } = setup(() => jsonResponse({ info: { total: 'x' }, data: {} }));
    for (const q of ['a', 'b', 'c']) await catalog.search(q, 1);
    await catalog.search('d', 1);
    expect(up.calls).toHaveLength(3);
  });
});

describe('payloads hostis na busca', () => {
  it('itens com imagem javascript:/http/terceiro ou sem CC0 sao filtrados; os bons ficam', async () => {
    const { catalog } = setup(() =>
      jsonResponse(
        searchBody(
          [
            artwork(1),
            artwork(2, { images: { web: { url: 'javascript:alert(1)' } } }),
            artwork(3, {
              images: { web: { url: 'http://openaccess-cdn.clevelandart.org/x.jpg' } },
            }),
            artwork(4, { images: { web: { url: 'https://evil.example/x.jpg' } } }),
            artwork(5, { share_license_status: 'Copyrighted' }),
            artwork(6),
          ],
          99,
        ),
      ),
    );
    const result = await catalog.search('a', 1);
    expect(result.degraded).toBe(false);
    expect(result.items.map((i) => i.sourceId)).toEqual(['1', '6']);
    expect(result.total).toBe(99);
  });

  it.each([
    [
      'HTML de bloqueio (200 text/html)',
      () => new Response('<html>blocked</html>', { headers: { 'content-type': 'text/html' } }),
    ],
    ['JSON truncado', () => jsonResponse('{"info":{"total":1},"data":[')],
    [
      'resposta gigante',
      () => jsonResponse(JSON.stringify({ info: { total: 1 }, data: [], lixo: 'x'.repeat(5_000) })),
    ],
    ['array no lugar do objeto', () => jsonResponse([])],
    ['null', () => jsonResponse('null')],
  ])('%s -> degrada para o offline, sem erro', async (_n, handler) => {
    const { catalog } = setup(handler, { maxBytes: 4_000 });
    const result = await catalog.search('a', 1);
    expect(result.degraded).toBe(true);
    expect(result.items.length).toBeGreaterThanOrEqual(0);
  });
});

describe('getItem', () => {
  it('busca o item, mapeia e guarda em cache', async () => {
    const { catalog, up } = setup(() =>
      jsonResponse(itemBody(artwork(135382, { title: 'The Red Kerchief' }))),
    );
    const item = await catalog.getItem('135382');
    expect(item).toMatchObject({
      source: 'cleveland',
      sourceId: '135382',
      title: 'The Red Kerchief',
    });
    expect(up.calls[0]!.url).toMatch(/\/artworks\/135382\?fields=/);
    await catalog.getItem('135382');
    expect(up.calls).toHaveLength(1);
  });

  it('o item vindo de uma busca ja esta em cache: escolher e criar lote nao gasta outra chamada', async () => {
    const { catalog, up } = setup(ok(7, 8));
    await catalog.search('a', 1);
    await expect(catalog.getItem('7')).resolves.toMatchObject({ sourceId: '7' });
    expect(up.calls).toHaveLength(1);
  });

  it.each([
    'abc',
    '../x',
    '1/../2',
    '',
    '1e3',
    '12 3',
    '١٢٣',
    '1234567890123',
    '-1',
    '1%2F2',
    '1?x=1',
    '0x10',
    '1.5',
  ])('id invalido %j -> ITEM_NOT_FOUND e NENHUMA chamada externa', async (id) => {
    const { catalog, up } = setup(ok(1));
    const error = await catalog.getItem(id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).code).toBe('ITEM_NOT_FOUND');
    expect(up.calls).toHaveLength(0);
  });

  it('404 -> ITEM_NOT_FOUND', async () => {
    const { catalog } = setup(() => new Response('nao', { status: 404 }));
    await expect(catalog.getItem('999')).rejects.toMatchObject({ code: 'ITEM_NOT_FOUND' });
  });

  it('item sem CC0 ou sem imagem segura -> ITEM_NOT_FOUND (nao vira lote)', async () => {
    const a = setup(() =>
      jsonResponse(itemBody(artwork(5, { share_license_status: 'Copyrighted' }))),
    );
    await expect(a.catalog.getItem('5')).rejects.toBeInstanceOf(NotFoundError);
    const b = setup(() => jsonResponse(itemBody(artwork(5, { images: null }))));
    await expect(b.catalog.getItem('5')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('resposta de OUTRO item e tratada como falha do upstream (nunca vira o item pedido)', async () => {
    const { catalog } = setup(() => jsonResponse(itemBody(artwork(6))));
    await expect(catalog.getItem('5')).rejects.toBeInstanceOf(CatalogUnavailableError);
  });

  it('API fora e item desconhecido -> CATALOG_UNAVAILABLE (503)', async () => {
    const { catalog } = setup(down);
    const error = await catalog.getItem('123456').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CatalogUnavailableError);
    expect((error as CatalogUnavailableError).code).toBe('CATALOG_UNAVAILABLE');
  });

  it('API fora mas o item esta no catalogo offline -> serve o offline', async () => {
    const { catalog } = setup(down);
    await expect(catalog.getItem('901')).resolves.toMatchObject({ title: 'Paisagem Offline' });
  });

  it('API fora mas ha cache vencido -> serve o cache', async () => {
    const { catalog, clock } = setup((_u, i) =>
      i === 0 ? jsonResponse(itemBody(artwork(55))) : new Response('x', { status: 500 }),
    );
    await catalog.getItem('55');
    clock.t += 2 * HOUR;
    await expect(catalog.getItem('55')).resolves.toMatchObject({ sourceId: '55' });
  });

  it('chamadas simultaneas ao mesmo item viram uma so', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { catalog, up } = setup(async () => {
      await gate;
      return jsonResponse(itemBody(artwork(9)));
    });
    const all = Promise.all(Array.from({ length: 15 }, () => catalog.getItem('9')));
    await new Promise((r) => setTimeout(r, 10));
    release();
    await all;
    expect(up.calls).toHaveLength(1);
  });

  it('o id vai na URL codificado e nunca altera o host nem o caminho', async () => {
    const { catalog, up } = setup(() => jsonResponse(itemBody(artwork(42))));
    await catalog.getItem('42');
    const url = new URL(up.calls[0]!.url);
    expect(url.host).toBe('openaccess-api.clevelandart.org');
    expect(url.pathname).toBe('/api/artworks/42');
  });
});

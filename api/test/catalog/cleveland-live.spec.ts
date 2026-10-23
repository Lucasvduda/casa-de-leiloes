import { describe, expect, it } from 'vitest';
import { ClevelandCatalog } from '../../src/adapters/outbound/catalog/cleveland-catalog.js';
import { NotFoundError } from '../../src/application/errors.js';

/**
 * Contrato com a API REAL do Cleveland Museum of Art. Fica desligado por padrao (o CI nao pode
 * depender de rede externa). Rode `LIVE_CATALOG=1 npm run test:unit -w api` para checar se o
 * formato da API mudou antes de uma entrega.
 */
describe.skipIf(process.env['LIVE_CATALOG'] !== '1')('API real do Cleveland (contrato)', () => {
  const catalog = () => new ClevelandCatalog({ offlineItems: [], retries: 2, timeoutMs: 10_000 });

  it('busca devolve itens CC0 com imagem segura e total coerente, sem degradar', async () => {
    const result = await catalog().search('monet', 1);
    expect(result.degraded).toBe(false);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.total).toBeGreaterThanOrEqual(result.items.length);
    for (const item of result.items) {
      expect(item.source).toBe('cleveland');
      expect(item.imageUrl).toMatch(/^https:\/\/openaccess-cdn\.clevelandart\.org\//);
      expect(item.title.length).toBeGreaterThan(0);
    }
  });

  it('termo com espaco e acento funciona', async () => {
    const result = await catalog().search('still life', 1);
    expect(result.degraded).toBe(false);
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('o item de uma busca existe no endpoint de item e e o mesmo', async () => {
    const c = catalog();
    const first = (await c.search('landscape', 1)).items[0]!;
    const direct = await new ClevelandCatalog({ offlineItems: [], timeoutMs: 10_000 }).getItem(
      first.sourceId,
    );
    expect(direct).toEqual(first);
  });

  it('id inexistente -> ITEM_NOT_FOUND', async () => {
    await expect(catalog().getItem('999999999')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('pagina alem do fim: lista vazia, nao erro', async () => {
    const result = await catalog().search('monet', 100);
    expect(result.degraded).toBe(false);
    expect(result.items).toEqual([]);
  });
});

import { CatalogUnavailableError, NotFoundError } from '../../src/application/errors.js';
import type { Catalog, CatalogSearchResult, ItemSnapshot } from '../../src/application/ports.js';

/** Catalogo em memoria para os testes de HTTP (o adapter real tem a propria suite, com fetch falso). */
export class FakeCatalog implements Catalog {
  down = false;
  readonly calls: { method: 'search' | 'getItem'; arg: string }[] = [];
  private readonly items = new Map<string, ItemSnapshot>();

  constructor() {
    for (let i = 1; i <= 30; i++) {
      this.items.set(String(1000 + i), {
        source: 'cleveland',
        sourceId: String(1000 + i),
        sourceUrl: `https://clevelandart.org/art/${1000 + i}`,
        title: i % 2 === 0 ? `Paisagem numero ${i}` : `Retrato numero ${i}`,
        imageUrl: `https://openaccess-cdn.clevelandart.org/${1000 + i}/${1000 + i}_web.jpg`,
        attributes: { Artista: i % 3 === 0 ? 'Claude Monet' : 'Artista Anonimo', Data: '1890' },
      });
    }
  }

  search(query: string, page: number): Promise<CatalogSearchResult> {
    this.calls.push({ method: 'search', arg: query });
    if (this.down) return Promise.reject(new CatalogUnavailableError());
    const all = [...this.items.values()].filter(
      (i) =>
        query === '' ||
        i.title.toLowerCase().includes(query.toLowerCase()) ||
        (i.attributes.Artista ?? '').toLowerCase().includes(query.toLowerCase()),
    );
    const pageSize = 12;
    return Promise.resolve({
      items: all.slice((page - 1) * pageSize, page * pageSize),
      total: all.length,
      page,
      pageSize,
      degraded: false,
    });
  }

  getItem(sourceId: string): Promise<ItemSnapshot> {
    this.calls.push({ method: 'getItem', arg: sourceId });
    if (this.down) return Promise.reject(new CatalogUnavailableError());
    const item = this.items.get(sourceId);
    if (item === undefined) {
      return Promise.reject(
        new NotFoundError('ITEM_NOT_FOUND', 'Item nao encontrado no catalogo.'),
      );
    }
    return Promise.resolve(item);
  }
}

import { describe, expect, it } from 'vitest';
import {
  cleanText,
  mapArtwork,
  parseItemResponse,
  parseSearchResponse,
  safeUrl,
} from '../../src/adapters/outbound/catalog/cleveland-mapper.js';
import { UpstreamError } from '../../src/adapters/outbound/catalog/resilient-fetch.js';
import { artwork, itemBody, searchBody } from '../support/fake-upstream.js';

describe('mapArtwork: item valido', () => {
  it('traduz o formato do Cleveland para o snapshot do leilao', () => {
    expect(mapArtwork(artwork(135382, { title: 'The Red Kerchief' }))).toEqual({
      source: 'cleveland',
      sourceId: '135382',
      sourceUrl: 'https://clevelandart.org/art/135382',
      title: 'The Red Kerchief',
      imageUrl: 'https://openaccess-cdn.clevelandart.org/135382/135382_web.jpg',
      attributes: {
        Artista: 'Claude Monet (French, 1840–1926)',
        Data: 'c. 1890',
        Tipo: 'Painting',
        Cultura: 'France, 19th century',
        Departamento: 'Pintura Europeia',
      },
    });
  });

  it('campos opcionais ausentes ou nulos viram atributos omitidos, nao "null"', () => {
    const item = mapArtwork(
      artwork(7, {
        creators: null,
        creation_date: null,
        type: undefined,
        culture: [],
        department: '   ',
      }),
    );
    expect(item).not.toBeNull();
    expect(item!.attributes).toEqual({});
  });

  it('ignora campos desconhecidos (a API devolve muito mais coisa)', () => {
    const item = mapArtwork(
      artwork(8, { tombstone: 'x'.repeat(5000), exhibitions: { current: [] }, extra: 1 }),
    );
    expect(item).not.toBeNull();
    expect(JSON.stringify(item)).not.toContain('tombstone');
  });
});

describe('mapArtwork: item que nao serve e descartado', () => {
  it.each([
    ['sem licenca', { share_license_status: null }],
    ['licenca restrita', { share_license_status: 'Copyrighted' }],
    ['licenca com caixa diferente', { share_license_status: 'cc0' }],
    ['sem imagem', { images: null }],
    ['imagem sem web', { images: { web: null } }],
    [
      'imagem em http',
      { images: { web: { url: 'http://openaccess-cdn.clevelandart.org/a.jpg' } } },
    ],
    ['imagem em host de terceiro', { images: { web: { url: 'https://evil.example/a.jpg' } } }],
    ['imagem javascript:', { images: { web: { url: 'javascript:alert(1)' } } }],
    ['imagem data:', { images: { web: { url: 'data:image/svg+xml,<svg onload=alert(1)>' } } }],
    [
      'imagem com credenciais',
      { images: { web: { url: 'https://user:pw@openaccess-cdn.clevelandart.org/a.jpg' } } },
    ],
    [
      'imagem em subdominio parecido',
      { images: { web: { url: 'https://openaccess-cdn.clevelandart.org.evil.example/a.jpg' } } },
    ],
    ['titulo ausente', { title: null }],
    ['titulo so de espacos e controle', { title: ' \u0000\u200B \n ' }],
    ['id negativo', { id: -1 }],
    ['id zero', { id: 0 }],
    ['id decimal', { id: 1.5 }],
    ['id texto', { id: '12' }],
    ['id gigante', { id: 10 ** 15 }],
  ])('%s', (_name, over) => {
    expect(mapArtwork(artwork(1, over))).toBeNull();
  });

  it.each([null, undefined, 42, 'texto', [], {}])(
    'entrada nao-objeto (%j) -> null, sem lancar',
    (raw) => {
      expect(mapArtwork(raw)).toBeNull();
    },
  );

  it('URL da pagina de terceiro vira null, mas o item continua valido', () => {
    const item = mapArtwork(artwork(2, { url: 'https://evil.example/art/2' }));
    expect(item).not.toBeNull();
    expect(item!.sourceUrl).toBeNull();
  });
});

describe('limpeza de texto vindo de fora', () => {
  it('remove controle, marcadores bidi e zero-width; colapsa espacos', () => {
    expect(cleanText('  Mona\u0000\u0007  Lisa\u202E gnp.exe\u2066\u200B  ', 100)).toBe(
      'Mona Lisa gnp.exe',
    );
    expect(cleanText('a\r\nb\tc', 100)).toBe('a b c');
  });

  it('trunca com reticencias sem passar do limite', () => {
    const text = cleanText('x'.repeat(10_000), 200)!;
    expect(text).toHaveLength(200);
    expect(text.endsWith('…')).toBe(true);
  });

  it('mantem acentos e emoji', () => {
    expect(cleanText('Coração de Jesús 🎨', 100)).toBe('Coração de Jesús 🎨');
  });

  it.each([null, undefined, 5, {}, [], ''])('valor invalido (%j) -> null', (value) => {
    expect(cleanText(value, 10)).toBeNull();
  });

  it('titulo gigante e HTML chegam como TEXTO inofensivo e limitado', () => {
    const item = mapArtwork(
      artwork(3, { title: `<img src=x onerror=alert(1)>${'a'.repeat(5000)}` }),
    )!;
    expect(item.title.length).toBeLessThanOrEqual(200);
    expect(item.title.startsWith('<img')).toBe(true); // texto cru: a UI escapa; aqui so limitamos
  });
});

describe('safeUrl', () => {
  const hosts = new Set(['cdn.exemplo.org']);

  it('aceita https no host permitido e normaliza', () => {
    expect(safeUrl('https://cdn.exemplo.org/a b.jpg', hosts)).toBe(
      'https://cdn.exemplo.org/a%20b.jpg',
    );
  });

  it.each([
    'http://cdn.exemplo.org/a.jpg',
    'https://cdn.exemplo.org.evil.test/a.jpg',
    'https://evil.test/cdn.exemplo.org/a.jpg',
    'https://cdn.exemplo.org@evil.test/a.jpg',
    '//cdn.exemplo.org/a.jpg',
    'ftp://cdn.exemplo.org/a.jpg',
    'not a url',
    '',
    `https://cdn.exemplo.org/${'a'.repeat(400)}`,
  ])('rejeita %s', (url) => {
    expect(safeUrl(url, hosts)).toBeNull();
  });

  it.each([null, undefined, 1, {}])('rejeita nao-string (%j)', (value) => {
    expect(safeUrl(value, hosts)).toBeNull();
  });
});

describe('envelopes da API', () => {
  it('busca: descarta itens invalidos e preserva o total informado pela API', () => {
    const body = searchBody(
      [
        artwork(1),
        artwork(2, { share_license_status: 'Copyrighted' }),
        { lixo: true },
        artwork(3, { images: { web: { url: 'javascript:alert(1)' } } }),
        artwork(4),
      ],
      180,
    );
    const { items, total } = parseSearchResponse(body);
    expect(items.map((i) => i.sourceId)).toEqual(['1', '4']);
    expect(total).toBe(180);
  });

  it.each([
    ['sem info', { data: [] }],
    ['sem data', { info: { total: 1 } }],
    ['data nao e lista', { info: { total: 1 }, data: {} }],
    ['total negativo', { info: { total: -1 }, data: [] }],
    ['total texto', { info: { total: '1' }, data: [] }],
    ['total decimal', { info: { total: 1.5 }, data: [] }],
    ['nulo', null],
    ['texto', 'oi'],
  ])('busca com envelope invalido (%s) -> UpstreamError payload', (_n, body) => {
    expect(() => parseSearchResponse(body)).toThrowError(UpstreamError);
    try {
      parseSearchResponse(body);
    } catch (error) {
      expect((error as UpstreamError).kind).toBe('payload');
    }
  });

  it('item: devolve o snapshot, ou null quando o item nao serve, ou erro se o envelope e invalido', () => {
    expect(parseItemResponse(itemBody(artwork(9)))?.sourceId).toBe('9');
    expect(parseItemResponse(itemBody(artwork(9, { share_license_status: null })))).toBeNull();
    expect(() => parseItemResponse({ resultado: artwork(9) })).toThrowError(UpstreamError);
    expect(() => parseItemResponse(null)).toThrowError(UpstreamError);
  });
});

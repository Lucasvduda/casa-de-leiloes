import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/adapters/inbound/http/app.js';
import { serveWebApp } from '../src/adapters/inbound/http/middlewares/web-app.js';

const INDEX =
  '<!doctype html><html><head><title>Casa de Leiloes</title></head><body><div id="root"></div></body></html>';

let outer: string;
let dist: string;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  outer = mkdtempSync(join(tmpdir(), 'leilao-web-spec-'));
  dist = join(outer, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), INDEX);
  writeFileSync(join(dist, 'favicon.ico'), 'ico');
  writeFileSync(join(dist, 'assets', 'app-4f9a1c.js'), 'console.log("app")');
  writeFileSync(join(dist, 'assets', 'app-4f9a1c.css'), 'body{margin:0}');
  writeFileSync(join(dist, '.env'), 'SEGREDO_DOTFILE=1');
  // Um arquivo dentro de uma pasta com nome de rota do servidor: /api/* nunca vem do disco.
  mkdirSync(join(dist, 'api'));
  writeFileSync(join(dist, 'api', 'vazou.txt'), 'DEVERIA_SER_API');
  // Fora do dist: nao pode ser alcancavel por traversal.
  writeFileSync(join(outer, 'segredo.txt'), 'SEGREDO_FORA_DO_DIST');
  app = createApp({
    logger: pino({ level: 'silent' }),
    readinessProbe: async () => true,
    webDistDir: dist,
  });
});

afterAll(() => rmSync(outer, { recursive: true, force: true }));

const html = (path: string) =>
  request(app).get(path).set('accept', 'text/html,application/xhtml+xml');

describe('index e rotas do React (fallback de SPA)', () => {
  it('/ entrega o index.html sem cache', async () => {
    const res = await html('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Casa de Leiloes');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('rota do app (/lotes/123, /minha-conta) recebe o index.html', async () => {
    for (const path of ['/lotes/123', '/minha-conta', '/lotes/abc/auditoria']) {
      const res = await html(path);
      expect(res.status, path).toBe(200);
      expect(res.text, path).toContain('id="root"');
      expect(res.headers['cache-control']).toBe('no-cache');
    }
  });

  it('HEAD tambem funciona (verificadores de disponibilidade)', async () => {
    const res = await request(app).head('/lotes/1').set('accept', 'text/html');
    expect(res.status).toBe(200);
  });

  it('/index.html direto nunca fica em cache', async () => {
    const res = await request(app).get('/index.html');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('prefixo parecido com o da API (/api-docs) e rota do app, nao da API', async () => {
    expect((await html('/api-docs')).text).toContain('id="root"');
    expect((await html('/healthy')).text).toContain('id="root"');
  });
});

describe('cache dos arquivos estaticos', () => {
  it('assets com hash: 1 ano e imutavel', async () => {
    for (const file of ['app-4f9a1c.js', 'app-4f9a1c.css']) {
      const res = await request(app).get(`/assets/${file}`);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    }
  });

  it('outros arquivos (favicon): 1 hora', async () => {
    const res = await request(app).get('/favicon.ico');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
  });
});

describe('o que NUNCA deve devolver o HTML do app', () => {
  it('arquivo inexistente: 404 JSON (nao mascara um .js quebrado com HTML)', async () => {
    for (const path of ['/assets/nao-existe.js', '/nada.css', '/robots.txt']) {
      const res = await html(path);
      expect(res.status, path).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
  });

  it('cliente que nao pediu HTML (fetch/curl de API) recebe 404 JSON', async () => {
    const res = await request(app).get('/lotes/123').set('accept', 'application/json');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('/api/* inexistente: 404 JSON padrao, mesmo pedindo HTML', async () => {
    for (const path of ['/api/nao-existe', '/api', '/api/lots/x/y/z']) {
      const res = await html(path);
      expect(res.status, path).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
  });

  it('o namespace do servidor nunca vem do disco, mesmo existindo um arquivo la', async () => {
    const res = await request(app).get('/api/vazou.txt');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('DEVERIA_SER_API');
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('escrita em rota do app: 404 JSON (so GET/HEAD entregam o app)', async () => {
    const res = await request(app)
      .post('/lotes/123')
      .set('content-type', 'application/json')
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('/health continua sendo da API', async () => {
    expect((await html('/health')).body).toEqual({ status: 'ok' });
  });
});

describe('seguranca dos arquivos', () => {
  it('traversal nao alcanca arquivos fora do dist', async () => {
    const attempts = [
      '/..%2fsegredo.txt',
      '/%2e%2e/segredo.txt',
      '/assets/..%2f..%2fsegredo.txt',
      '/..%5csegredo.txt',
      '/%2e%2e%2fsegredo.txt',
    ];
    for (const path of attempts) {
      const res = await request(app).get(path).set('accept', 'text/html');
      expect(res.text ?? '', path).not.toContain('SEGREDO_FORA_DO_DIST');
      expect([200, 400, 403, 404], path).toContain(res.status);
    }
  });

  it('dotfiles nao sao servidos', async () => {
    const res = await request(app).get('/.env');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('SEGREDO_DOTFILE');
  });

  it('byte nulo e caminho malformado nao derrubam nem vazam', async () => {
    for (const path of ['/%00', '/assets/%00.js', '/%E0%A4%A']) {
      const res = await request(app).get(path).set('accept', 'text/html');
      expect(res.status, path).toBeLessThan(500);
    }
  });
});

describe('CSP e cabecalhos', () => {
  it('permite so o proprio site e as imagens CC0 do museu; sem eval, sem inline script, sem plugin', async () => {
    const csp = String((await html('/')).headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("img-src 'self' data: https://openaccess-cdn.clevelandart.org");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  it('os cabecalhos de seguranca tambem valem para os arquivos estaticos', async () => {
    const res = await request(app).get('/assets/app-4f9a1c.js');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['content-security-policy']).toBeDefined();
  });
});

describe('configuracao', () => {
  it('pasta sem index.html: falha no boot com mensagem clara', () => {
    const empty = mkdtempSync(join(tmpdir(), 'leilao-web-empty-'));
    try {
      expect(() => serveWebApp(empty)).toThrow(/WEB_DIST_DIR invalido/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('build dentro de uma pasta oculta (/.cache/app/dist) continua servindo o app', async () => {
    const hidden = join(outer, '.oculto', 'app', 'dist');
    mkdirSync(hidden, { recursive: true });
    writeFileSync(join(hidden, 'index.html'), INDEX);
    const hiddenApp = createApp({
      logger: pino({ level: 'silent' }),
      readinessProbe: async () => true,
      webDistDir: hidden,
    });
    const home = await request(hiddenApp).get('/').set('accept', 'text/html');
    expect(home.status).toBe(200);
    expect(home.text).toContain('Casa de Leiloes');
    expect((await request(hiddenApp).get('/lotes/9').set('accept', 'text/html')).status).toBe(200);
  });

  it('build dentro de uma pasta chamada "assets": so o que esta em dist/assets e imutavel', async () => {
    const tricky = join(outer, 'assets', 'site', 'dist');
    mkdirSync(join(tricky, 'assets'), { recursive: true });
    writeFileSync(join(tricky, 'index.html'), INDEX);
    writeFileSync(join(tricky, 'favicon.ico'), 'ico');
    writeFileSync(join(tricky, 'assets', 'app-1.js'), 'x');
    const trickyApp = createApp({
      logger: pino({ level: 'silent' }),
      readinessProbe: async () => true,
      webDistDir: tricky,
    });
    expect((await request(trickyApp).get('/favicon.ico')).headers['cache-control']).toBe(
      'public, max-age=3600',
    );
    expect((await request(trickyApp).get('/index.html')).headers['cache-control']).toBe('no-cache');
    expect((await request(trickyApp).get('/assets/app-1.js')).headers['cache-control']).toContain(
      'immutable',
    );
  });

  it('sem webDistDir a API nao serve nada alem de /api, /health e /ready', async () => {
    const bare = createApp({ logger: pino({ level: 'silent' }), readinessProbe: async () => true });
    const res = await request(bare).get('/').set('accept', 'text/html');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

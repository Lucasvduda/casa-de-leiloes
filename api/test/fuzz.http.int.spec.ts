import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import request from 'supertest';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HOUR, FakeClock, createHarness, reais } from './support/harness.js';
import type { Harness } from './support/harness.js';
import { Client, createHttpHarness } from './support/http-harness.js';
import type { HttpHarness } from './support/http-harness.js';
import { createTestDb } from './support/test-db.js';
import type { TestDb } from './support/test-db.js';

/**
 * Blindagem da superficie HTTP:
 *  1. lista fechada de rotas (rota nova sem revisao de seguranca quebra o teste);
 *  2. fuzz deterministico: entrada hostil em TODA rota, com TODOS os papeis, nunca gera 5xx,
 *     vazamento de stack/SQL nem estado inconsistente (dinheiro e cadeias de hash).
 */

let db: TestDb;
let http: HttpHarness;
let core: Harness;
const clock = new FakeClock();

beforeAll(async () => {
  db = await createTestDb();
  http = createHttpHarness(db, { clock });
  core = createHarness(db, clock);
});

afterAll(async () => {
  await db.close();
});

// ---------------------------------------------------------------------------------------------
// 1. Lista fechada de rotas
// ---------------------------------------------------------------------------------------------

/** Toda rota publicada pelo app. Mudou? Atualize aqui E a matriz de autorizacao E o fuzz abaixo. */
const EXPECTED_ROUTES = [
  'GET /api/auth/me',
  'GET /api/catalog/search',
  'GET /api/lots',
  'GET /api/lots/:id',
  'GET /api/lots/:id/audit',
  'GET /api/lots/:id/events',
  'GET /api/me/bids',
  'GET /api/me/lots',
  'GET /api/me/wins',
  'GET /api/receipts/:code',
  'GET /api/wallet',
  'GET /health',
  'GET /ready',
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'POST /api/auth/register',
  'POST /api/lots',
  'POST /api/lots/:id/bids',
  'POST /api/lots/:id/cancel',
  'POST /api/wallet/deposits',
] as const;

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
  handle?: { stack?: Layer[] };
}

function collectRoutes(): string[] {
  const found: string[] = [];
  const walk = (stack: Layer[], prefix: string, depth: number): void => {
    for (const layer of stack) {
      if (layer.route !== undefined) {
        for (const method of Object.keys(layer.route.methods)) {
          found.push(`${method.toUpperCase()} ${prefix}${layer.route.path}`);
        }
      } else if (layer.handle?.stack !== undefined) {
        // O unico sub-roteador do app e o da API, montado em /api.
        walk(layer.handle.stack, depth === 0 ? '/api' : prefix, depth + 1);
      }
    }
  };
  const router = (http.app as unknown as { router: { stack: Layer[] } }).router;
  walk(router.stack, '', 0);
  return found.sort();
}

describe('superficie HTTP: lista fechada de rotas', () => {
  it('o app expoe exatamente as rotas revisadas (nenhuma a mais, nenhuma esquecida)', () => {
    expect(collectRoutes()).toEqual([...EXPECTED_ROUTES].sort());
  });

  it('toda rota de negocio autenticada tem linha na matriz de autorizacao (ou teste proprio)', () => {
    const matrix = readFileSync(resolve(__dirname, 'api-lots.http.int.spec.ts'), 'utf8');
    // Cobertas por specs dedicados: auth (cadastro/login/me) e SSE.
    const dedicated = new Set([
      'POST /api/auth/login',
      'POST /api/auth/register',
      'GET /api/auth/me',
      'GET /api/lots/:id/events',
      'GET /health',
      'GET /ready',
    ]);
    const missing = EXPECTED_ROUTES.filter(
      (route) => !dedicated.has(route) && !matrix.includes(`route: '${route}'`),
    );
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Fuzz deterministico
// ---------------------------------------------------------------------------------------------

/** PRNG com semente fixa (mulberry32): a falha de hoje se repete amanha. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NASTY_STRINGS = [
  '',
  ' ',
  '\t\n',
  'a'.repeat(3000),
  '\u0000',
  'a\u0000b',
  '\u202Eevil',
  '\u200B',
  '😀'.repeat(200),
  "'; DROP TABLE users; --",
  "' OR '1'='1",
  '../../etc/passwd',
  '<script>alert(1)</script>',
  '%00',
  '%',
  '__proto__',
  'constructor',
  'toString',
  '${7*7}',
  '{{7*7}}',
  'NaN',
  'Infinity',
  '-1',
  '0',
  '1e309',
  '9'.repeat(400),
  '0x10',
  'null',
  'undefined',
  'true',
  'ａｂｃ',
  'Ünï©ödé',
  '\ud800',
];

const NASTY_NUMBERS = [
  0,
  -1,
  1,
  0.5,
  -0.0001,
  1e21,
  -1e21,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 2,
  2 ** 31,
  2 ** 32,
  2 ** 63,
  100,
  500_000,
];

function nasty(rng: () => number, depth = 0): unknown {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rng() * list.length)] as T;
  const kind = Math.floor(rng() * (depth > 2 ? 5 : 8));
  switch (kind) {
    case 0:
      return null;
    case 1:
      return rng() < 0.5;
    case 2:
      return pick(NASTY_NUMBERS);
    case 3:
    case 4:
      return pick(NASTY_STRINGS);
    case 5:
      return Array.from({ length: Math.floor(rng() * 4) }, () => nasty(rng, depth + 1));
    case 6: {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < Math.floor(rng() * 4); i += 1)
        obj[pick(NASTY_STRINGS)] = nasty(rng, depth + 1);
      return obj;
    }
    default:
      // __proto__ como chave PROPRIA (JSON.parse cria, literal nao).
      return JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}}}');
  }
}

/** Corpo mais provavel de passar na 1a validacao: 1 campo valido + lixo nos demais. */
function bodyFor(route: string, rng: () => number, ctx: Ctx): unknown {
  const junk = () => nasty(rng);
  const mix = (valid: Record<string, unknown>): unknown => {
    const body: Record<string, unknown> = { ...valid };
    for (const key of Object.keys(valid)) if (rng() < 0.25) body[key] = junk();
    if (rng() < 0.3) body[`extra${Math.floor(rng() * 5)}`] = junk();
    if (rng() < 0.05) return junk();
    return body;
  };
  const now = clock.now().getTime();
  switch (route) {
    case 'POST /api/auth/register':
      return mix({
        email: `fuzz-${Math.floor(rng() * 1e9)}@teste.local`,
        displayName: 'Fuzz',
        password: 'Senha-Forte-Do-Teste-42',
        role: 'bidder',
      });
    case 'POST /api/auth/login':
      return mix({ email: ctx.knownEmail, password: 'errada-0123456789' });
    case 'POST /api/lots':
      return mix({
        sourceId: '1001',
        startingBid: reais(100),
        minIncrement: reais(5),
        startsAt: new Date(now).toISOString(),
        endsAt: new Date(now + HOUR).toISOString(),
      });
    case 'POST /api/lots/:id/bids':
      return mix({ amount: reais(1_000 + Math.floor(rng() * 50)) });
    case 'POST /api/wallet/deposits':
      return mix({ amount: reais(1 + Math.floor(rng() * 50)) });
    default:
      return rng() < 0.5 ? {} : junk();
  }
}

interface Ctx {
  knownEmail: string;
  lotId: string;
  sacrificialLotId: string;
}

const BAD_IDS = [
  '',
  '0',
  '-1',
  'abc',
  '00000000-0000-4000-8000-000000000000',
  '11111111-1111-1111-1111-111111111111',
  'A'.repeat(22),
  'A'.repeat(300),
  '%00',
  '%',
  '../admin',
  '1; DROP TABLE lots',
  '\u202E',
  '😀',
  '__proto__',
];

/** encodeURIComponent que aceita surrogate solto (o cliente HTTP nao consegue enviar esse byte). */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const enc = (value: string): string => encodeURIComponent(value.replace(LONE_SURROGATE, '\ufffd'));

/** Valor aceito como cabecalho HTTP (o cliente recusa o resto antes de enviar). */
const headerSafe = (value: string): boolean => /^[\x21-\x7e]*$/.test(value);

const QUERY_KEYS = ['phase', 'q', 'sort', 'page', 'pageSize', 'before', 'limit', 'id', 'x'];

function queryString(rng: () => number): string {
  const parts: string[] = [];
  const count = Math.floor(rng() * 5);
  for (let i = 0; i < count; i += 1) {
    const key = QUERY_KEYS[Math.floor(rng() * QUERY_KEYS.length)] as string;
    const raw = nasty(rng);
    const value = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const form = Math.floor(rng() * 4);
    // Formas que o parser `qs` transforma em array/objeto: ?page[]=1&page[]=2, ?page[a]=1
    if (form === 0) parts.push(`${key}[]=${enc(value)}&${key}[]=2`);
    else if (form === 1) parts.push(`${key}[a]=${enc(value)}`);
    else parts.push(`${key}=${enc(value)}`);
  }
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

const LEAK =
  /node_modules|\.ts:\d|\.js:\d|SELECT |INSERT |UPDATE |pg_|stack|argon2|password_hash|ECONN|syntax error at/i;

interface Actor {
  name: string;
  client: Client | null;
}

/** Campanha longa fora do CI: FUZZ_SEED=7 FUZZ_ITERATIONS=300 npm run test:int -- fuzz. */
const SEED_OFFSET = Number(process.env.FUZZ_SEED ?? 0) * 1_000_003;

const ROUTES: { method: 'GET' | 'POST'; path: string }[] = EXPECTED_ROUTES.filter(
  (r) => r !== 'GET /health' && r !== 'GET /ready',
).map((r) => {
  const [method, path] = r.split(' ') as ['GET' | 'POST', string];
  return { method, path };
});

describe('fuzz: entrada hostil em toda rota, com todos os papeis', () => {
  const ITERATIONS = Number(process.env.FUZZ_ITERATIONS ?? 60);
  const results = { total: 0, byStatus: new Map<number, number>() };
  let actors: Actor[] = [];
  let ctx: Ctx;

  beforeAll(async () => {
    const seller = new Client(http.app);
    await seller.register({ role: 'seller', displayName: 'Casa Fuzz' });
    const bidder = new Client(http.app);
    const { body } = await bidder.register({ role: 'bidder', displayName: 'Licitante Fuzz' });
    for (let i = 0; i < 3; i += 1)
      await bidder.post('/api/wallet/deposits', { amount: reais(100_000) });

    const now = clock.now().getTime();
    const mk = async (): Promise<string> => {
      const res = await seller.post('/api/lots', {
        sourceId: '1001',
        startingBid: reais(100),
        minIncrement: reais(5),
        startsAt: new Date(now).toISOString(),
        endsAt: new Date(now + 6 * HOUR).toISOString(),
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.lot.id as string;
    };
    ctx = { knownEmail: body.email, lotId: await mk(), sacrificialLotId: await mk() };
    actors = [
      { name: 'anonimo', client: null },
      { name: 'licitante', client: bidder },
      { name: 'leiloeiro', client: seller },
    ];
  });

  async function fire(
    actor: Actor,
    method: 'GET' | 'POST',
    path: string,
    rng: () => number,
  ): Promise<Response & { sent: string }> {
    const isSse = path.endsWith('/events');
    // Id valido so nas rotas em que isso nao abre stream nem cancela o lote principal.
    const goodId = path.endsWith('/cancel') ? ctx.sacrificialLotId : ctx.lotId;
    const useValidId = !isSse && rng() < 0.4;
    const id = useValidId ? goodId : (BAD_IDS[Math.floor(rng() * BAD_IDS.length)] as string);
    const url =
      path
        .replace(':id', enc(id))
        .replace(':code', enc(BAD_IDS[Math.floor(rng() * BAD_IDS.length)] as string)) +
      (method === 'GET' ? queryString(rng) : '');

    // Cancelar o lote de sacrificio so no PRIMEIRO acerto; depois responde 409 (tambem valido).
    const client = actor.client;
    const req: request.Test =
      method === 'GET'
        ? client !== null
          ? client.get(url)
          : request(http.app).get(url)
        : client !== null
          ? client.agent.post(url)
          : request(http.app).post(url);

    let sentBody = '';
    if (method === 'POST') {
      const csrfMode = rng();
      if (client?.csrfToken !== null && client?.csrfToken !== undefined && csrfMode < 0.85) {
        req.set('X-CSRF-Token', csrfMode < 0.05 ? 'x'.repeat(500) : client.csrfToken);
      } else if (csrfMode > 0.95) {
        const junk = NASTY_STRINGS[Math.floor(rng() * NASTY_STRINGS.length)] ?? '';
        if (headerSafe(junk)) req.set('X-CSRF-Token', junk);
      }
      if (rng() < 0.6) {
        const key = NASTY_STRINGS[Math.floor(rng() * NASTY_STRINGS.length)] as string;
        // Cabecalho com caractere invalido nem chega ao servidor (o cliente HTTP recusa).
        if (/^[\x21-\x7e]*$/.test(key)) req.set('Idempotency-Key', key);
      }
      req.set('Content-Type', 'application/json');
      const body = bodyFor(`${method} ${path}`, rng, ctx);
      sentBody = JSON.stringify(body);
      req.send(sentBody);
    }
    const res = await req.timeout({ response: 15_000, deadline: 20_000 });
    return Object.assign(res, { sent: `${url} ${sentBody}` });
  }

  for (const { method, path } of ROUTES) {
    it(`${method} ${path}: ${ITERATIONS} entradas hostis por papel, nunca 5xx nem vazamento`, async () => {
      const failures: string[] = [];
      for (const [index, actor] of actors.entries()) {
        const rng = prng(
          0xc0ffee + SEED_OFFSET + index * 7919 + path.length * 31 + (method === 'POST' ? 1 : 0),
        );
        for (let i = 0; i < ITERATIONS; i += 1) {
          const res = await fire(actor, method, path, rng);
          results.total += 1;
          results.byStatus.set(res.status, (results.byStatus.get(res.status) ?? 0) + 1);
          const text = res.text ?? '';
          const where = `${actor.name} ${method} ${path} -> ${res.status}`;
          if (res.status >= 500)
            failures.push(
              `${where} (5xx) ${text.slice(0, 200)} ENTRADA: ${res.sent.slice(0, 600)}`,
            );
          if (LEAK.test(text)) failures.push(`${where} vazou: ${text.slice(0, 200)}`);
          if (res.status >= 400) {
            const err = res.body?.error as Record<string, unknown> | undefined;
            const okShape =
              err !== undefined &&
              typeof err.code === 'string' &&
              typeof err.message === 'string' &&
              typeof err.requestId === 'string';
            if (!okShape) failures.push(`${where} sem contrato de erro: ${text.slice(0, 200)}`);
          }
        }
      }
      expect(failures).toEqual([]);
    }, 120_000);
  }

  it('depois de tudo: dinheiro conservado, extrato coerente e todas as cadeias integras', async () => {
    await core.assertInvariants();
    expect(results.total).toBe(ROUTES.length * actors.length * ITERATIONS);
    // Prova de que o fuzz exercitou caminhos diferentes (nao foi tudo 401 ou tudo 400).
    const statuses = [...results.byStatus.keys()];
    if (process.env.FUZZ_VERBOSE !== undefined) {
      process.stdout.write(`fuzz: ${JSON.stringify(Object.fromEntries(results.byStatus))}\n`);
    }
    expect(statuses.some((s) => s >= 200 && s < 300)).toBe(true);
    expect(statuses.filter((s) => s >= 400 && s < 500).length).toBeGreaterThanOrEqual(4);
  });

  it('o servidor continua saudavel depois do fuzz', async () => {
    const res = await request(http.app).get('/api/lots');
    expect(res.status).toBe(200);
    expect(Object.prototype.hasOwnProperty.call({}, 'polluted')).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

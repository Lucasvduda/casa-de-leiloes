import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_TTL_MS } from '../src/application/usecases/auth.js';
import { FakeClock } from './support/harness.js';
import {
  Client,
  LOOSE_RATE_LIMITS,
  STRONG_PASSWORD,
  createHttpHarness,
  sha256,
  uniqueEmail,
} from './support/http-harness.js';
import type { HttpHarness } from './support/http-harness.js';
import { createTestDb } from './support/test-db.js';
import type { TestDb } from './support/test-db.js';

let db: TestDb;
let h: HttpHarness;

beforeAll(async () => {
  db = await createTestDb();
  h = createHttpHarness(db);
});

afterAll(async () => {
  await db.close();
});

const newClient = () => new Client(h.app);

/** Valor cru do cookie de sessao a partir do Set-Cookie. */
function cookieValue(res: request.Response, name = 'leilao_sid'): string | null {
  const raw = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const line = raw.find((c) => c.startsWith(`${name}=`));
  if (line === undefined) return null;
  const value = line.slice(name.length + 1).split(';')[0] ?? '';
  return value === '' ? null : value;
}

const setCookieLine = (res: request.Response, name = 'leilao_sid'): string =>
  ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${name}=`)) ??
  '';

describe('cadastro', () => {
  it('cria conta, abre sessao e NAO devolve hash nem dado interno', async () => {
    const c = newClient();
    const { res, body } = await c.register({ displayName: 'Maria Souza', role: 'seller' });
    expect(res.status).toBe(201);
    expect(res.body.user).toEqual({
      id: expect.any(String),
      email: body.email,
      displayName: 'Maria Souza',
      role: 'seller',
    });
    expect(res.body.csrfToken).toEqual(expect.any(String));
    expect(JSON.stringify(res.body)).not.toMatch(/argon2|password|hash/i);
  });

  it('grava a senha com argon2id e o token de sessao SO como hash', async () => {
    const c = newClient();
    const { res, body } = await c.register();
    const stored = await db.pool.query(`SELECT password_hash FROM users WHERE email = $1`, [
      body.email,
    ]);
    expect(stored.rows[0].password_hash).toMatch(/^\$argon2id\$v=19\$/);
    expect(stored.rows[0].password_hash).not.toContain(body.password);

    const token = cookieValue(res);
    expect(token).not.toBeNull();
    const sessions = await db.pool.query(`SELECT id_hash FROM sessions WHERE user_id = $1`, [
      c.userId,
    ]);
    expect(sessions.rows.map((r) => r.id_hash)).toEqual([sha256(token as string)]);
    expect(JSON.stringify(sessions.rows)).not.toContain(token as string);
  });

  it('cria a carteira zerada junto com a conta', async () => {
    const c = newClient();
    await c.register();
    const w = await db.pool.query(
      `SELECT total_cents, committed_cents FROM wallets WHERE user_id = $1`,
      [c.userId],
    );
    expect(w.rows).toEqual([{ total_cents: '0', committed_cents: '0' }]);
  });

  it('cookie: httpOnly, SameSite=Lax, Path=/, com validade', async () => {
    const { res } = await newClient().register();
    const line = setCookieLine(res);
    expect(line).toMatch(/HttpOnly/i);
    expect(line).toMatch(/SameSite=Lax/i);
    expect(line).toMatch(/Path=\//);
    expect(line).toMatch(/Expires=/i);
    expect(line).not.toMatch(/Secure/i); // ambiente de teste e HTTP
  });

  it('em producao o cookie e Secure e usa o prefixo __Host-', async () => {
    const prod = createHttpHarness(db, { cookieName: '__Host-leilao_sid', cookieSecure: true });
    const res = await request(prod.app).post('/api/auth/register').send({
      email: uniqueEmail(),
      displayName: 'Prod',
      password: STRONG_PASSWORD,
      role: 'bidder',
    });
    const line = setCookieLine(res, '__Host-leilao_sid');
    expect(line).toMatch(/Secure/i);
    expect(line).toMatch(/HttpOnly/i);
    expect(line).not.toMatch(/Domain=/i); // exigencia do prefixo __Host-
  });

  it('e-mail e normalizado (aparado, minusculo) e a unicidade ignora maiusculas', async () => {
    const email = uniqueEmail('Mixed');
    const a = await newClient().register({ email: `  ${email.toUpperCase()}  ` });
    expect(a.res.status).toBe(201);
    expect(a.res.body.user.email).toBe(email.toLowerCase());

    const dup = await newClient().register({ email });
    expect(dup.res.status).toBe(409);
    expect(dup.res.body.error.code).toBe('EMAIL_TAKEN');

    const login = await newClient().login(email.toUpperCase());
    expect(login.status).toBe(200);
  });

  it('10 cadastros simultaneos com o mesmo e-mail: exatamente 1 vence, os demais 409 (nunca 500)', async () => {
    const email = uniqueEmail('race');
    const results = await Promise.all(
      Array.from({ length: 10 }, () => newClient().register({ email })),
    );
    const statuses = results.map((r) => r.res.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(9);
    const users = await db.pool.query(`SELECT 1 FROM users WHERE email = $1`, [email]);
    expect(users.rowCount).toBe(1);
  });

  it.each([
    ['e-mail sem arroba', { email: 'semarroba' }, 'email'],
    ['e-mail vazio', { email: '' }, 'email'],
    ['e-mail gigante', { email: `${'a'.repeat(250)}@teste.local` }, 'email'],
    ['senha curta (7)', { password: 'Ab1!xyz' }, 'password'],
    ['senha gigante (129)', { password: 'a1'.repeat(65) }, 'password'],
    ['senha comum', { password: 'password' }, 'password'],
    ['senha comum com maiusculas', { password: 'Senha123' }, 'password'],
    ['senha repetitiva', { password: 'aaaaaaaaaa' }, 'password'],
    ['senha so de dois caracteres alternados', { password: 'abababababab' }, 'password'],
    ['nome com 1 caractere', { displayName: 'A' }, 'displayName'],
    ['nome so de espacos', { displayName: '     ' }, 'displayName'],
    ['nome so de caracteres de controle', { displayName: '\u0000\u0007\n' }, 'displayName'],
    ['nome com 61 caracteres', { displayName: 'x'.repeat(61) }, 'displayName'],
    ['papel admin', { role: 'admin' }, 'role'],
    ['papel vazio', { role: '' }, 'role'],
    ['papel numerico', { role: 1 }, 'role'],
  ])('recusa: %s', async (_name, override, field) => {
    const { res } = await newClient().register(override as never);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toHaveProperty(field);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it.each([
    ['sem corpo', undefined],
    ['null', null],
    ['array', []],
    ['string', 'texto'],
  ])('corpo %s -> 400 VALIDATION_ERROR', async (_n, body) => {
    const res = await request(h.app)
      .post('/api/auth/register')
      .set('Content-Type', 'application/json')
      .send(body as never);
    expect([400]).toContain(res.status);
  });

  it('campos extras (isAdmin, id, role forjado em outro campo) sao ignorados', async () => {
    const c = newClient();
    const { res } = await c.register({
      isAdmin: true,
      id: '11111111-1111-4111-8111-111111111111',
      passwordHash: 'x',
    } as never);
    expect(res.status).toBe(201);
    expect(res.body.user.id).not.toBe('11111111-1111-4111-8111-111111111111');
    const row = await db.pool.query(`SELECT password_hash FROM users WHERE id = $1`, [c.userId]);
    expect(row.rows[0].password_hash).toMatch(/^\$argon2id\$/);
  });

  it('senha com unicode, emoji e 128 caracteres e aceita e funciona no login', async () => {
    const password = `Sénha-🔐-${'ç'.repeat(100)}`.slice(0, 128);
    const email = uniqueEmail();
    expect((await newClient().register({ email, password })).res.status).toBe(201);
    expect((await newClient().login(email, password)).status).toBe(200);
    expect((await newClient().login(email, `${password}x`.slice(0, 128) + 'y')).status).toBe(401);
  });

  it('senha com caracteres NUL nao quebra (nem vira 500)', async () => {
    const email = uniqueEmail();
    const password = `abc\u0000def-${'Z9'.repeat(5)}`;
    const { res } = await newClient().register({ email, password });
    expect([201, 400]).toContain(res.status);
  });

  it('login com e-mail contendo byte nulo ou controle -> 400 (regressao do fuzz: era 500)', async () => {
    for (const email of ['\u0000', 'a\u0000@b.cc', 'a@b.cc\u0007', 'a\n@b.cc']) {
      const res = await request(h.app)
        .post('/api/auth/login')
        .send({ email, password: 'x'.repeat(12) });
      expect(res.status, JSON.stringify(email)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('JSON malformado -> 400 INVALID_JSON; corpo gigante -> 413; tipo errado -> 415', async () => {
    const bad = await request(h.app)
      .post('/api/auth/register')
      .set('Content-Type', 'application/json')
      .send('{"email":');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_JSON');

    const big = await request(h.app)
      .post('/api/auth/register')
      .send({ email: 'x@y.zz', pad: 'x'.repeat(40_000) });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('PAYLOAD_TOO_LARGE');

    const text = await request(h.app)
      .post('/api/auth/register')
      .set('Content-Type', 'text/plain')
      .send('email=a');
    expect(text.status).toBe(415);
    const form = await request(h.app)
      .post('/api/auth/register')
      .type('form')
      .send({ email: 'a@b.cc' });
    expect(form.status).toBe(415);
  });
});

describe('login', () => {
  it('credenciais corretas abrem sessao; /me devolve o usuario', async () => {
    const reg = newClient();
    const { body } = await reg.register({ displayName: 'Joao Lima' });
    const c = newClient();
    const login = await c.login(body.email);
    expect(login.status).toBe(200);
    expect(login.body.user.displayName).toBe('Joao Lima');
    const me = await c.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(body.email);
    expect(me.body.csrfToken).toBe(c.csrfToken);
  });

  it('senha errada e e-mail inexistente dao a MESMA resposta (sem enumeracao de contas)', async () => {
    const { body } = await newClient().register();
    const wrongPassword = await newClient().login(body.email, 'senha-errada-12345');
    const unknownUser = await newClient().login(uniqueEmail('fantasma'), 'senha-errada-12345');
    for (const res of [wrongPassword, unknownUser]) {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    expect(wrongPassword.body.error.message).toBe(unknownUser.body.error.message);
  });

  it('e-mail inexistente tambem passa pelo argon2 (mesmo custo de tempo)', async () => {
    const { body } = await newClient().register();
    const before = h.hasher.verifiedHashes.length;
    await newClient().login(body.email, 'errada-errada-1');
    await newClient().login(uniqueEmail('fantasma'), 'errada-errada-1');
    const verified = h.hasher.verifiedHashes.slice(before);
    expect(verified).toHaveLength(2);
    // Nos dois casos o argon2 recebeu um hash real (mesmo custo), nunca um atalho vazio.
    for (const hash of verified) expect(hash).toMatch(/^\$argon2id\$v=19\$m=1024,t=1,p=1\$/);
  });

  it.each([
    ['sem senha', { email: 'a@b.cc' }],
    ['sem e-mail', { password: 'x' }],
    ['senha vazia', { email: 'a@b.cc', password: '' }],
    ['senha gigante', { email: 'a@b.cc', password: 'x'.repeat(129) }],
    ['e-mail como objeto (injecao NoSQL)', { email: { $ne: '' }, password: 'x' }],
    ['senha como array', { email: 'a@b.cc', password: ['x'] }],
    ['numero no lugar de string', { email: 12345, password: 12345 }],
  ])('entrada invalida (%s) -> 400', async (_n, body) => {
    const res = await request(h.app).post('/api/auth/login').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('injecao de SQL no e-mail e tratada como e-mail inexistente (401), sem erro de banco', async () => {
    const res = await newClient().login("' OR '1'='1' --");
    expect(res.status).toBe(401);
  });

  it('cada login gera um token NOVO (sem reaproveitar sessao)', async () => {
    const { body } = await newClient().register();
    const a = await request(h.app)
      .post('/api/auth/login')
      .send({ email: body.email, password: body.password });
    const b = await request(h.app)
      .post('/api/auth/login')
      .send({ email: body.email, password: body.password });
    expect(cookieValue(a)).not.toBe(cookieValue(b));
    expect(a.body.csrfToken).not.toBe(b.body.csrfToken);
  });

  it('mantem no maximo 10 sessoes por usuario; a mais antiga e invalidada', async () => {
    const { body } = await newClient().register();
    const tokens: string[] = [];
    for (let i = 0; i < 12; i++) {
      h.clock.advance(1_000);
      const res = await request(h.app)
        .post('/api/auth/login')
        .send({ email: body.email, password: body.password });
      tokens.push(cookieValue(res) as string);
    }
    const user = await db.pool.query(`SELECT id FROM users WHERE email = $1`, [body.email]);
    const count = await db.pool.query(
      `SELECT count(*)::int AS n FROM sessions WHERE user_id = $1`,
      [user.rows[0].id],
    );
    expect(count.rows[0].n).toBe(10);
    const oldest = await request(h.app)
      .get('/api/auth/me')
      .set('Cookie', `leilao_sid=${tokens[0]}`);
    const newest = await request(h.app)
      .get('/api/auth/me')
      .set('Cookie', `leilao_sid=${tokens[11]}`);
    expect(oldest.status).toBe(401);
    expect(newest.status).toBe(200);
  });
});

describe('sessao', () => {
  it('sem cookie: /me -> 401 UNAUTHENTICATED', async () => {
    const res = await request(h.app).get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it.each([
    ['lixo curto', 'abc'],
    ['token de tamanho certo mas inventado', 'A'.repeat(43)],
    ['caracteres perigosos', "'; DROP TABLE sessions; --"],
    ['gigante', 'x'.repeat(5000)],
    ['base64 padrao com +/=', `${'a'.repeat(40)}+/=`],
  ])('cookie invalido (%s) -> 401 e o cookie e limpo', async (_n, value) => {
    const res = await request(h.app)
      .get('/api/auth/me')
      .set('Cookie', `leilao_sid=${encodeURIComponent(value)}`);
    expect(res.status).toBe(401);
    expect(setCookieLine(res)).toMatch(/leilao_sid=;/);
  });

  it('logout invalida o token NO SERVIDOR: reaproveitar o cookie roubado nao funciona', async () => {
    const c = newClient();
    const { res } = await c.register();
    const stolen = cookieValue(res) as string;

    const out = await c.post('/api/auth/logout');
    expect(out.status).toBe(204);
    expect(setCookieLine(out)).toMatch(/leilao_sid=;/);

    const replay = await request(h.app).get('/api/auth/me').set('Cookie', `leilao_sid=${stolen}`);
    expect(replay.status).toBe(401);
    const left = await db.pool.query(`SELECT 1 FROM sessions WHERE id_hash = $1`, [sha256(stolen)]);
    expect(left.rowCount).toBe(0);
  });

  it('logout sem sessao e idempotente (204)', async () => {
    const res = await request(h.app).post('/api/auth/logout').send({});
    expect(res.status).toBe(204);
  });

  it('logout de uma sessao nao derruba as outras do mesmo usuario', async () => {
    const { body } = await newClient().register();
    const a = newClient();
    const b = newClient();
    await a.login(body.email);
    await b.login(body.email);
    await a.post('/api/auth/logout');
    expect((await b.get('/api/auth/me')).status).toBe(200);
  });

  it('sessao vence apos 7 dias: 401 e purga remove o registro', async () => {
    const clock = new FakeClock();
    const aged = createHttpHarness(db, { clock });
    const c = new Client(aged.app);
    await c.register();
    clock.advance(SESSION_TTL_MS - 1_000);
    expect((await c.get('/api/auth/me')).status).toBe(200);
    clock.advance(2_000);
    const expired = await c.get('/api/auth/me');
    expect(expired.status).toBe(401);
    expect(await aged.auth.purgeExpired()).toBeGreaterThanOrEqual(1);
  });
});

describe('protecao CSRF e guarda de escrita', () => {
  it('escrita com sessao e SEM X-CSRF-Token -> 403 CSRF_INVALID', async () => {
    const c = newClient();
    await c.register();
    const res = await c.agent.post('/api/auth/logout').send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_INVALID');
  });

  it('token CSRF errado (inclusive de outro usuario) -> 403', async () => {
    const a = newClient();
    const b = newClient();
    await a.register();
    await b.register();
    const res = await a.agent
      .post('/api/auth/logout')
      .set('X-CSRF-Token', b.csrfToken as string)
      .send({});
    expect(res.status).toBe(403);
    expect((await a.get('/api/auth/me')).status).toBe(200); // a sessao continua de pe
  });

  it('token CSRF correto passa', async () => {
    const c = newClient();
    await c.register();
    expect((await c.post('/api/auth/logout')).status).toBe(204);
  });

  it('GET nunca exige CSRF', async () => {
    const c = newClient();
    await c.register();
    expect((await c.agent.get('/api/auth/me')).status).toBe(200);
  });

  it('Origin de outro site -> 403; mesma origem passa', async () => {
    const c = newClient();
    await c.register();
    const evil = await c.post('/api/auth/logout', {}, { Origin: 'https://site-malicioso.example' });
    expect(evil.status).toBe(403);
    expect(evil.body.error.code).toBe('CROSS_ORIGIN_REQUEST');

    const invalid = await c.post('/api/auth/logout', {}, { Origin: 'isso-nao-e-url' });
    expect(invalid.status).toBe(403);

    const same = await c.post(
      '/api/auth/logout',
      {},
      { Host: 'leilao.test', Origin: 'https://leilao.test' },
    );
    expect(same.status).toBe(204);
  });

  it('Sec-Fetch-Site: cross-site -> 403; same-origin passa', async () => {
    const c = newClient();
    await c.register();
    const cross = await c.post('/api/auth/logout', {}, { 'Sec-Fetch-Site': 'cross-site' });
    expect(cross.status).toBe(403);
    expect(cross.body.error.code).toBe('CROSS_SITE_REQUEST');
    const same = await c.post('/api/auth/logout', {}, { 'Sec-Fetch-Site': 'same-origin' });
    expect(same.status).toBe(204);
  });

  it('login CSRF: formulario de outro site (urlencoded/text) e recusado antes de qualquer logica', async () => {
    const { body } = await newClient().register();
    for (const type of ['application/x-www-form-urlencoded', 'text/plain', 'multipart/form-data']) {
      const res = await request(h.app)
        .post('/api/auth/login')
        .set('Content-Type', type)
        .send(`email=${body.email}&password=${body.password}`);
      expect(res.status, type).toBe(415);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
  });

  it('PUT, PATCH e DELETE tambem passam pela guarda', async () => {
    const c = newClient();
    await c.register();
    for (const method of ['put', 'patch', 'delete'] as const) {
      const res = await c.agent[method]('/api/auth/logout')
        .set('Content-Type', 'text/plain')
        .send('x');
      expect(res.status, method).toBe(415);
    }
  });
});

describe('cabecalhos e contrato da API', () => {
  it('toda resposta /api tem Cache-Control: no-store e cabecalhos de seguranca', async () => {
    const res = await request(h.app).get('/api/auth/me');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('rota inexistente sob /api -> 404 JSON com requestId', async () => {
    const res = await request(h.app).get('/api/nao-existe');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({
      code: 'NOT_FOUND',
      requestId: res.headers['x-request-id'],
    });
  });

  it('erro nunca vaza stack, caminho de arquivo ou SQL', async () => {
    const res = await request(h.app).post('/api/auth/login').send({ email: "x'", password: 'y' });
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.ts|node_modules|SELECT|pg_|stack/i);
  });
});

describe('limites de taxa', () => {
  const tight = (over: Partial<typeof LOOSE_RATE_LIMITS>) => ({ ...LOOSE_RATE_LIMITS, ...over });

  it('forca bruta em UMA conta: apos N falhas, ate a senha certa fica bloqueada (429)', async () => {
    const t = createHttpHarness(db, {
      rateLimits: tight({ loginFailuresPerAccount: { windowMs: 60_000, limit: 3 } }),
    });
    const { body } = await new Client(t.app).register();
    const attempt = (password: string) =>
      request(t.app).post('/api/auth/login').send({ email: body.email, password });

    for (let i = 0; i < 3; i++) expect((await attempt('errada-errada-1')).status).toBe(401);
    const blocked = await attempt(body.password);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(blocked.headers['retry-after'] ?? blocked.headers['ratelimit']).toBeDefined();
  });

  it('logins que DAO CERTO nao consomem a cota de falhas', async () => {
    const t = createHttpHarness(db, {
      rateLimits: tight({ loginFailuresPerAccount: { windowMs: 60_000, limit: 2 } }),
    });
    const { body } = await new Client(t.app).register();
    for (let i = 0; i < 6; i++) {
      const res = await request(t.app)
        .post('/api/auth/login')
        .send({ email: body.email, password: body.password });
      expect(res.status).toBe(200);
    }
  });

  it('varredura de varias contas pelo mesmo IP e barrada pelo limite por IP', async () => {
    const t = createHttpHarness(db, {
      rateLimits: tight({ loginFailuresPerIp: { windowMs: 60_000, limit: 4 } }),
    });
    for (let i = 0; i < 4; i++) {
      const res = await request(t.app)
        .post('/api/auth/login')
        .send({ email: uniqueEmail('alvo'), password: 'x-errada-1' });
      expect(res.status).toBe(401);
    }
    const res = await request(t.app)
      .post('/api/auth/login')
      .send({ email: uniqueEmail('alvo'), password: 'x-errada-1' });
    expect(res.status).toBe(429);
  });

  it('cadastro em massa por IP e limitado', async () => {
    const t = createHttpHarness(db, {
      rateLimits: tight({ register: { windowMs: 60_000, limit: 3 } }),
    });
    for (let i = 0; i < 3; i++) expect((await new Client(t.app).register()).res.status).toBe(201);
    expect((await new Client(t.app).register()).res.status).toBe(429);
  });

  it('teto geral da API por IP devolve 429 em JSON', async () => {
    const t = createHttpHarness(db, { rateLimits: tight({ api: { windowMs: 60_000, limit: 5 } }) });
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await request(t.app).get('/api/auth/me')).status;
    expect(last).toBe(429);
  });
});

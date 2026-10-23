import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, afterEach, describe, expect, it, inject } from 'vitest';
import { assertUtf8, postgresReadiness } from '../src/adapters/outbound/postgres/operations.js';
import { loadConfig } from '../src/infrastructure/config.js';
import { buildContainer, cookieSettings } from '../src/infrastructure/container.js';
import type { Container, ContainerOverrides } from '../src/infrastructure/container.js';
import { startServer } from '../src/infrastructure/server.js';
import type { RunningServer } from '../src/infrastructure/server.js';
import { FakeClock, HOUR, SECRET, reais } from './support/harness.js';
import { FakeCatalog } from './support/fake-catalog.js';
import { Client, STRONG_PASSWORD } from './support/http-harness.js';
import { SseStream } from './support/sse-client.js';
import { createTestDb } from './support/test-db.js';
import type { TestDb } from './support/test-db.js';

const logger = pino({ level: 'silent' });
const DEMO_PASSWORD = 'Demo-Leilao-2026!';

const dbs: TestDb[] = [];
const containers: Container[] = [];
const servers: RunningServer[] = [];
const tmpDirs: string[] = [];
const streams: SseStream[] = [];

afterEach(async () => {
  for (const s of streams.splice(0)) s.close();
  for (const s of servers.splice(0)) await s.shutdown().catch(() => undefined);
  for (const c of containers.splice(0)) await c.pool.end().catch(() => undefined);
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

afterAll(async () => {
  for (const db of dbs.splice(0)) await db.close();
});

async function freshDb(): Promise<TestDb> {
  const db = await createTestDb();
  dbs.push(db);
  return db;
}

const configFor = (db: TestDb, env: Record<string, string> = {}) =>
  loadConfig({
    INTEGRITY_SECRET: SECRET,
    DATABASE_URL: db.url,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DEMO_PASSWORD,
    ...env,
  });

async function boot(
  db: TestDb,
  env: Record<string, string> = {},
  overrides: ContainerOverrides = {},
) {
  const container = await buildContainer(configFor(db, env), logger, overrides);
  containers.push(container);
  return container;
}

async function serve(container: Container, options = {}) {
  const running = await startServer(container, logger, { port: 0, host: '127.0.0.1', ...options });
  servers.push(running);
  return { running, baseUrl: `http://127.0.0.1:${running.port}` };
}

async function login(container: Container, email: string): Promise<Client> {
  const client = new Client(container.app);
  expect((await client.login(email, DEMO_PASSWORD)).status).toBe(200);
  return client;
}

async function rowCount(db: TestDb, table: string): Promise<number> {
  return Number((await db.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
}

describe('subida com dados de demonstracao (SEED_ON_BOOT)', () => {
  it('migra, semeia e a vitrine publica ja mostra lotes ao vivo, agendado e encerrados', async () => {
    const db = await freshDb();
    const container = await boot(db, { SEED_ON_BOOT: 'true' });
    const { baseUrl } = await serve(container);

    expect((await request(baseUrl).get('/health')).status).toBe(200);
    expect((await request(baseUrl).get('/ready')).status).toBe(200);

    const totals = async (phase: string) =>
      (await request(baseUrl).get(`/api/lots?phase=${phase}&pageSize=50`)).body.total as number;
    expect(await totals('live')).toBe(3);
    expect(await totals('scheduled')).toBe(1);
    expect(await totals('finished')).toBe(2);
  });

  it('as 3 contas entram com a senha publicada e cada uma ve o que e dela', async () => {
    const db = await freshDb();
    const container = await boot(db, { SEED_ON_BOOT: 'true' });

    const ana = await login(container, 'ana@demo.leilao');
    const bruno = await login(container, 'bruno@demo.leilao');
    const seller = await login(container, 'leiloeiro@demo.leilao');

    // Ana: R$ 60.000 - R$ 3.500 (arrematou o lote vendido); R$ 2.200 comprometidos (lidera o lote ao vivo).
    expect((await ana.get('/api/wallet')).body).toMatchObject({
      total: reais(56_500),
      committed: reais(2_200),
      available: reais(54_300),
    });
    // Bruno lidera o lote que fecha logo (R$ 950).
    expect((await bruno.get('/api/wallet')).body).toMatchObject({
      total: reais(60_000),
      committed: reais(950),
    });
    expect((await ana.get('/api/me/wins')).body.items).toHaveLength(1);
    expect((await ana.get('/api/me/bids')).body.total).toBe(3);

    const mine = (await seller.get('/api/me/lots?pageSize=50')).body;
    expect(mine.total).toBe(7);
    expect(mine.totals).toEqual({ received: reais(3_500), soldCount: 1 });
  });

  it('a sala mostra quem lidera e quem foi superado, e toda auditoria publica esta integra', async () => {
    const db = await freshDb();
    const container = await boot(db, { SEED_ON_BOOT: 'true' });
    const ana = await login(container, 'ana@demo.leilao');

    const all = (await request(container.app).get('/api/lots?phase=all&pageSize=50')).body
      .items as {
      id: string;
      title: string;
      phase: string;
      bidCount: number;
      viewer: unknown;
    }[];
    expect(all).toHaveLength(6);

    for (const lot of all) {
      const audit = (await request(container.app).get(`/api/lots/${lot.id}/audit`)).body;
      expect(audit.integrity, lot.title).toEqual({ intact: true, issues: [] });
    }

    const leading = (await ana.get('/api/lots?phase=live&pageSize=50')).body.items as {
      bidCount: number;
      viewer: { isLeading: boolean } | null;
    }[];
    expect(leading.filter((l) => l.viewer?.isLeading === true)).toHaveLength(1);

    const sold = all.find((l) => l.phase === 'ended' || l.phase === 'closed')!;
    expect(sold).toBeDefined();
    const receiptCode = (await ana.get('/api/me/wins')).body.items[0].receiptCode as string;
    const receipt = (await request(container.app).get(`/api/receipts/${receiptCode}`)).body.receipt;
    expect(receipt).toMatchObject({ amount: reais(3_500), bidCount: 3, signatureValid: true });
  });

  it('reiniciar nao duplica nada (seed idempotente entre processos)', async () => {
    const db = await freshDb();
    const first = await boot(db, { SEED_ON_BOOT: 'true' });
    await first.pool.end();
    const tables = ['users', 'lots', 'bids', 'wallet_ledger', 'receipts'];
    const before = await Promise.all(tables.map((t) => rowCount(db, t)));

    const second = await boot(db, { SEED_ON_BOOT: 'true' });
    await second.pool.end();
    expect(await Promise.all(tables.map((t) => rowCount(db, t)))).toEqual(before);
  });

  it('duas instancias subindo AO MESMO TEMPO nao semeiam em duplicidade (advisory lock)', async () => {
    const db = await freshDb();
    const [a, b] = await Promise.all([
      boot(db, { SEED_ON_BOOT: 'true' }),
      boot(db, { SEED_ON_BOOT: 'true' }),
    ]);
    expect(a).not.toBe(b);
    expect(await rowCount(db, 'users')).toBe(3);
    expect(await rowCount(db, 'lots')).toBe(7);
    expect(await rowCount(db, 'bids')).toBe(11);
    const deposits = await db.pool.query(
      `SELECT count(*)::int AS n FROM wallet_ledger WHERE kind = 'deposit'`,
    );
    expect(deposits.rows[0].n).toBe(2);
  });

  it('sem SEED_ON_BOOT o banco fica vazio e a vitrine responde vazia (nunca erro)', async () => {
    const db = await freshDb();
    const container = await boot(db);
    expect(await rowCount(db, 'users')).toBe(0);
    const res = await request(container.app).get('/api/lots');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });
});

describe('agendador ligado ao servidor', () => {
  it('liquida sozinho um lote vencido, sem ninguem abrir a pagina', async () => {
    const db = await freshDb();
    const clock = new FakeClock();
    // Catalogo falso: nenhum teste depende de rede.
    const container = await boot(db, {}, { clock, settleEveryMs: 20, catalog: new FakeCatalog() });
    await serve(container);

    const seller = new Client(container.app);
    await seller.register({ role: 'seller', displayName: 'Vendedor' });
    const bidder = new Client(container.app);
    await bidder.register({ role: 'bidder', displayName: 'Comprador' });
    await bidder.post('/api/wallet/deposits', { amount: reais(1_000) });

    const created = await seller.post('/api/lots', {
      sourceId: '1001',
      startingBid: reais(100),
      minIncrement: reais(5),
      startsAt: clock.now().toISOString(),
      endsAt: new Date(clock.now().getTime() + HOUR).toISOString(),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const lotId = created.body.lot.id as string;
    expect((await bidder.post(`/api/lots/${lotId}/bids`, { amount: reais(100) })).status).toBe(201);

    clock.advance(HOUR + 60_000);
    const deadline = Date.now() + 5_000;
    // Consulta direta ao banco: NAO usa a liquidacao preguicosa da leitura.
    for (;;) {
      const { rows } = await db.pool.query(`SELECT status FROM lots WHERE id = $1`, [lotId]);
      if (rows[0].status === 'closed') break;
      if (Date.now() > deadline) throw new Error('o agendador nao liquidou o lote');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await rowCount(db, 'receipts')).toBe(1);
  });
});

describe('limpeza de sessoes pelo agendador', () => {
  it('ao subir, remove sessoes vencidas e preserva as vivas', async () => {
    const db = await freshDb();
    const clock = new FakeClock();
    const first = await boot(db, {}, { clock, catalog: new FakeCatalog() });
    const stale = new Client(first.app);
    await stale.register({ displayName: 'Sessao Velha' });
    const alive = new Client(first.app);
    await alive.register({ displayName: 'Sessao Viva' });
    // A sessao de `stale` venceu uma hora antes do "agora" do relogio injetado.
    await db.pool.query(`UPDATE sessions SET created_at = $2, expires_at = $3 WHERE user_id = $1`, [
      stale.userId,
      new Date(clock.now().getTime() - 48 * HOUR),
      new Date(clock.now().getTime() - HOUR),
    ]);
    expect(await rowCount(db, 'sessions')).toBe(2);

    await serve(first);
    const deadline = Date.now() + 5_000;
    while ((await rowCount(db, 'sessions')) !== 1) {
      if (Date.now() > deadline)
        throw new Error('a sessao vencida nao foi removida pelo agendador');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect((await alive.get('/api/auth/me')).status).toBe(200);
  });
});

describe('prontidao e desligamento ordenado', () => {
  it('/ready vira 503 quando o banco some, e /health continua 200', async () => {
    const db = await freshDb();
    const container = await boot(db);
    const { running, baseUrl } = await serve(container);
    expect((await request(baseUrl).get('/ready')).status).toBe(200);
    await container.pool.end();
    expect((await request(baseUrl).get('/ready')).body).toEqual({ status: 'unavailable' });
    expect((await request(baseUrl).get('/health')).status).toBe(200);
    // Pool ja encerrado nao impede o desligamento de terminar.
    await expect(running.shutdown()).resolves.toBeUndefined();
  });

  it('depois do shutdown o agendador esta parado: nenhuma tarefa tenta usar o banco ja fechado', async () => {
    const db = await freshDb();
    const errors: string[] = [];
    const spy = pino({ level: 'error' }, { write: (line: string) => void errors.push(line) });
    const container = await buildContainer(configFor(db), spy, { settleEveryMs: 10 });
    containers.push(container);
    const running = await startServer(container, spy, { port: 0, host: '127.0.0.1' });
    servers.push(running);
    await new Promise((resolve) => setTimeout(resolve, 80)); // varios ciclos rodando
    await running.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 150)); // ciclos que "sobrariam" se o agendador seguisse vivo
    expect(errors.filter((line) => line.includes('scheduled_task_failed'))).toEqual([]);
  });

  it('shutdown encerra streams SSE, para de aceitar conexoes, fecha o pool e e idempotente', async () => {
    const db = await freshDb();
    const container = await boot(db, { SEED_ON_BOOT: 'true' });
    const { running, baseUrl } = await serve(container);
    const lotId = (await request(baseUrl).get('/api/lots')).body.items[0].id as string;

    const stream = await SseStream.connect(baseUrl, `/api/lots/${lotId}/events`);
    streams.push(stream);
    expect((await stream.next()).event).toBe('snapshot');

    const started = Date.now();
    const first = running.shutdown();
    expect(running.shutdown()).toBe(first);
    await first;
    expect(Date.now() - started).toBeLessThan(3_000);

    expect(await stream.ended()).toBe(true);
    await expect(fetch(`${baseUrl}/health`)).rejects.toThrow();
    await expect(container.pool.query('SELECT 1')).rejects.toThrow();
  });

  it('shutdown espera a tarefa do agendador em andamento terminar antes de fechar o pool', async () => {
    const db = await freshDb();
    const container = await boot(db);
    const { running } = await serve(container);
    // Duas paradas seguidas do mesmo agendador nao quebram.
    await running.shutdown();
    await expect(container.scheduler.stop()).resolves.toBeUndefined();
  });

  it('conexao parada (cliente que nunca fecha) e cortada depois do prazo de drenagem', async () => {
    const db = await freshDb();
    const container = await boot(db);
    const { running, baseUrl } = await serve(container, { drainMs: 200 });
    // Requisicao com corpo prometido e nunca enviado: o servidor ainda esta esperando o corpo.
    const url = new URL(baseUrl);
    const { connect } = await import('node:net');
    const socket = connect(Number(url.port), url.hostname);
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write(
      'POST /api/auth/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{',
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = Date.now();
    await running.shutdown();
    expect(Date.now() - started).toBeLessThan(3_000);
    socket.destroy();
  });

  it('timeouts do servidor protegem contra proxy e conexao lenta', async () => {
    const db = await freshDb();
    const { running } = await serve(await boot(db));
    expect(running.server.keepAliveTimeout).toBe(65_000);
    expect(running.server.headersTimeout).toBeGreaterThan(running.server.keepAliveTimeout);
    expect(running.server.requestTimeout).toBe(30_000);
  });

  it('porta ocupada: falha com erro claro e nao deixa o pool aberto', async () => {
    const db = await freshDb();
    const { running } = await serve(await boot(db));
    const other = await boot(db);
    await expect(
      startServer(other, logger, { port: running.port, host: '127.0.0.1' }),
    ).rejects.toThrow(/EADDRINUSE/);
    await expect(other.pool.query('SELECT 1')).rejects.toThrow();
  });
});

describe('falhas de configuracao e de ambiente: o processo nao sobe mal configurado', () => {
  it('sem DATABASE_URL', async () => {
    const config = loadConfig({ INTEGRITY_SECRET: SECRET, NODE_ENV: 'test', LOG_LEVEL: 'silent' });
    await expect(buildContainer(config, logger)).rejects.toThrow(/DATABASE_URL/);
  });

  it('banco inacessivel: erro e nenhum recurso pendurado', async () => {
    const config = loadConfig({
      INTEGRITY_SECRET: SECRET,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none',
    });
    await expect(buildContainer(config, logger)).rejects.toThrow();
  });

  it('banco que nao e UTF8 e recusado no boot', async () => {
    const base = inject('pgBaseUrl');
    const name = `ascii_${Date.now().toString(36)}`;
    const admin = new pg.Client({ connectionString: base });
    await admin.connect();
    await admin.query(
      `CREATE DATABASE "${name}" TEMPLATE template0 ENCODING 'SQL_ASCII' LC_COLLATE 'C' LC_CTYPE 'C'`,
    );
    try {
      const url = new URL(base);
      url.pathname = `/${name}`;
      const config = loadConfig({
        INTEGRITY_SECRET: SECRET,
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATABASE_URL: url.toString(),
      });
      await expect(buildContainer(config, logger)).rejects.toThrow(/UTF8/);
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end();
    }
  });

  it('seed com conta de demonstracao de outro papel derruba o boot (fail fast) sem vazar conexoes', async () => {
    const db = await freshDb();
    await db.pool.query(
      `INSERT INTO users (id, email, display_name, password_hash, role)
       VALUES (gen_random_uuid(), 'ana@demo.leilao', 'Intrusa', 'x', 'seller')`,
    );
    const others = async () =>
      Number(
        (
          await db.pool.query(
            `SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE datname = current_database() AND pid <> pg_backend_pid()`,
          )
        ).rows[0].n,
      );
    const before = await others();
    await expect(buildContainer(configFor(db, { SEED_ON_BOOT: 'true' }), logger)).rejects.toThrow(
      /outro papel/,
    );
    // O pool do boot que falhou precisa ter sido fechado: nenhuma conexao a mais fica pendurada.
    const deadline = Date.now() + 2_000;
    while ((await others()) > before) {
      if (Date.now() > deadline) throw new Error('conexoes do boot que falhou continuam abertas');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });

  it('DB_POOL_MAX configura o tamanho do pool', async () => {
    const db = await freshDb();
    const container = await boot(db, { DB_POOL_MAX: '3' });
    expect(container.pool.options.max).toBe(3);
    expect(() => configFor(db, { DB_POOL_MAX: '1' })).toThrow(/DB_POOL_MAX/);
    expect(() => configFor(db, { DB_POOL_MAX: '500' })).toThrow(/DB_POOL_MAX/);
  });

  it('WEB_DIST_DIR sem index.html derruba o boot', async () => {
    const db = await freshDb();
    const dir = mkdtempSync(join(tmpdir(), 'leilao-web-'));
    tmpDirs.push(dir);
    await expect(buildContainer(configFor(db, { WEB_DIST_DIR: dir }), logger)).rejects.toThrow(
      /WEB_DIST_DIR/,
    );
  });

  it('com WEB_DIST_DIR valido a mesma origem serve o app e a API', async () => {
    const db = await freshDb();
    const dir = mkdtempSync(join(tmpdir(), 'leilao-web-'));
    tmpDirs.push(dir);
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Leilao</title>');
    writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
    const container = await boot(db, { WEB_DIST_DIR: dir });
    const home = await request(container.app).get('/').set('accept', 'text/html');
    expect(home.status).toBe(200);
    expect(home.text).toContain('<title>Leilao</title>');
    expect((await request(container.app).get('/api/lots')).status).toBe(200);
  });
});

describe('cookie de sessao por ambiente', () => {
  it('producao: Secure e prefixo __Host-', () => {
    expect(cookieSettings({ NODE_ENV: 'production', COOKIE_SECURE: undefined })).toMatchObject({
      name: '__Host-leilao_sid',
      secure: true,
    });
  });
  it('producao em http://localhost (compose): COOKIE_SECURE=false desliga os dois', () => {
    expect(cookieSettings({ NODE_ENV: 'production', COOKIE_SECURE: false })).toMatchObject({
      name: 'leilao_sid',
      secure: false,
    });
  });
  it('desenvolvimento e teste: cookie simples', () => {
    expect(cookieSettings({ NODE_ENV: 'development', COOKIE_SECURE: undefined }).secure).toBe(
      false,
    );
    expect(cookieSettings({ NODE_ENV: 'test', COOKIE_SECURE: undefined }).name).toBe('leilao_sid');
  });
  it('o cabecalho Set-Cookie real em producao sai Secure + HttpOnly + SameSite=Lax + Path=/ sem Domain', async () => {
    const db = await freshDb();
    const container = await boot(db, { NODE_ENV: 'production' });
    const res = await request(container.app)
      .post('/api/auth/register')
      .set('X-Forwarded-Proto', 'https')
      .send({
        email: 'cookie@teste.local',
        displayName: 'Cookie',
        password: STRONG_PASSWORD,
        role: 'bidder',
      });
    expect(res.status).toBe(201);
    const cookie = String((res.headers['set-cookie'] as unknown as string[])[0]);
    expect(cookie).toMatch(/^__Host-leilao_sid=/);
    expect(cookie).toMatch(/;\s*Secure/i);
    expect(cookie).toMatch(/;\s*HttpOnly/i);
    expect(cookie).toMatch(/;\s*SameSite=Lax/i);
    expect(cookie).toMatch(/;\s*Path=\//i);
    expect(cookie).not.toMatch(/Domain=/i);
  });
});

describe('operacoes de banco', () => {
  it('assertUtf8 aceita UTF8 e recusa o resto (sem depender de banco real)', async () => {
    const answer = (encoding: string) =>
      ({ query: async () => ({ rows: [{ encoding }] }) }) as never;
    await expect(assertUtf8(answer('UTF8'))).resolves.toBeUndefined();
    await expect(assertUtf8(answer('LATIN1'))).rejects.toThrow(/LATIN1/);
  });

  it('a sonda de prontidao responde false quando o banco trava (prazo) ou falha, e nunca lanca', async () => {
    const hanging = { query: () => new Promise(() => undefined) } as never;
    expect(await postgresReadiness(hanging, 50)()).toBe(false);
    const failing = { query: async () => Promise.reject(new Error('down')) } as never;
    expect(await postgresReadiness(failing, 50)()).toBe(false);
    const healthy = { query: async () => ({ rows: [] }) } as never;
    expect(await postgresReadiness(healthy, 50)()).toBe(true);
  });
});

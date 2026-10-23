/**
 * Teste de fumaca do BUILD compilado (`dist/`), com processo real e banco real.
 *
 * Os testes automatizados rodam sobre `src/` via vitest; este confirma o que eles nao enxergam:
 * o caminho das migracoes a partir de `dist/`, o boot com NODE_ENV=production, o seed, a API e o
 * SSE funcionando de ponta a ponta no processo que o Docker vai executar.
 *
 * Uso (na pasta api, depois de `npm run build`):  npm run smoke:dist
 * Usa TEST_DATABASE_URL se existir; senao sobe um Postgres embutido temporario.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const API = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'segredo-do-smoke-0123456789abcdef0123456789';
const PASSWORD = 'Demo-Leilao-2026!';

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a !== null ? a.port : 0;
      s.close(() => res(port));
    });
  });
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FALHOU: ${message}`);
  process.stdout.write(`  ok  ${message}\n`);
}

async function main(): Promise<void> {
  let stopPg: (() => Promise<void>) | undefined;
  let baseUrl = process.env.TEST_DATABASE_URL ?? '';
  if (baseUrl === '') {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    const dir = mkdtempSync(join(tmpdir(), 'leilao-smoke-pg-'));
    const port = await freePort();
    const server = new EmbeddedPostgres({
      databaseDir: dir,
      user: 'postgres',
      password: 'postgres',
      port,
      persistent: false,
      onLog: () => undefined,
      onError: () => undefined,
    });
    await server.initialise();
    await server.start();
    baseUrl = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
    stopPg = async () => {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    };
  }

  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  const dbName = `smoke_${Date.now().toString(36)}`;
  await admin.query(
    `CREATE DATABASE "${dbName}" TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`,
  );
  const dbUrl = new URL(baseUrl);
  dbUrl.pathname = `/${dbName}`;

  const port = await freePort();
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    DATABASE_URL: dbUrl.toString(),
    INTEGRITY_SECRET: SECRET,
    SEED_ON_BOOT: 'true',
    COOKIE_SECURE: 'false',
    LOG_LEVEL: 'info',
  };
  const logs: string[] = [];
  const child = spawn(process.execPath, ['dist/main.js'], { cwd: API, env });
  child.stdout.on('data', (d: Buffer) => logs.push(String(d)));
  child.stderr.on('data', (d: Buffer) => logs.push(String(d)));
  const exited = new Promise<number | null>((res) => child.once('exit', (code) => res(code)));

  const base = `http://127.0.0.1:${port}`;
  let failed = false;
  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const r = await fetch(`${base}/ready`).catch(() => null);
      if (r?.ok) break;
      if (Date.now() > deadline) throw new Error('servidor nao ficou pronto em 60 s');
      await new Promise((r2) => setTimeout(r2, 200));
    }
    check(
      true,
      'processo de producao subiu e /ready respondeu 200 (migracoes + seed aplicados a partir de dist/)',
    );

    const live = (await (await fetch(`${base}/api/lots?phase=live`)).json()) as {
      total: number;
      items: { id: string; title: string }[];
    };
    check(live.total === 3, 'vitrine publica lista os 3 lotes ao vivo do seed');

    const login = async (email: string) => {
      const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: PASSWORD }),
      });
      check(res.status === 200, `login de ${email}`);
      const cookie = res.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ');
      const body = (await res.json()) as { csrfToken: string };
      return { cookie, csrf: body.csrfToken };
    };
    const bruno = await login('bruno@demo.leilao');

    const room = (await (await fetch(`${base}/api/lots?phase=live`)).json()) as {
      items: { id: string; bidCount: number; minimumNextBid: number }[];
    };
    const empty = room.items.find((lot) => lot.bidCount === 0);
    check(empty !== undefined, 'existe um lote ao vivo sem lances para o teste');

    // SSE: abre a sala e confere o snapshot; depois da o lance e espera o evento.
    const abort = new AbortController();
    const sse = await fetch(`${base}/api/lots/${empty.id}/events`, {
      headers: { accept: 'text/event-stream', cookie: bruno.cookie },
      signal: abort.signal,
    });
    check(
      sse.status === 200 && String(sse.headers.get('content-type')).includes('text/event-stream'),
      'SSE abre com content-type correto',
    );
    const reader = sse.body!.getReader();
    const decoder = new TextDecoder();
    let received = '';
    const readUntil = async (needle: string): Promise<void> => {
      const limit = Date.now() + 10_000;
      while (!received.includes(needle)) {
        if (Date.now() > limit)
          throw new Error(`evento ${needle} nao chegou. Recebido: ${received}`);
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream terminou antes de ${needle}`);
        received += decoder.decode(value);
      }
    };
    await readUntil('event: snapshot');
    check(true, 'SSE entrega o snapshot da sala');

    const bid = await fetch(`${base}/api/lots/${empty.id}/bids`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: bruno.cookie,
        'x-csrf-token': bruno.csrf,
      },
      body: JSON.stringify({ amount: empty.minimumNextBid }),
    });
    check(bid.status === 201, 'lance via HTTP aceito (201)');
    await readUntil('event: bid');
    check(
      received.includes('"mine":true'),
      'SSE entrega o lance ao vivo, marcado como meu para quem deu',
    );
    abort.abort();

    const audit = (await (await fetch(`${base}/api/lots/${empty.id}/audit`)).json()) as {
      integrity: { intact: boolean };
    };
    check(audit.integrity.intact, 'auditoria publica do lote confirma a cadeia integra');

    const seed = spawnSync(process.execPath, ['dist/seed-cli.js'], {
      cwd: API,
      env,
      encoding: 'utf8',
    });
    check(seed.status === 0, 'seed:prod roda de novo sem erro (idempotente)');
    const after = (await (await fetch(`${base}/api/lots?phase=all&pageSize=50`)).json()) as {
      total: number;
    };
    check(after.total === 6, 'seed repetido nao duplicou lotes');

    check(logs.join('').includes('"msg":"server_listening"'), 'log estruturado JSON em producao');
    check(!logs.join('').includes('leiloeiro@demo.leilao'), 'e-mails nao aparecem nos logs');
  } catch (error) {
    failed = true;
    process.stderr.write(
      `\n${error instanceof Error ? error.message : String(error)}\n--- logs do servidor ---\n${logs.join('')}\n`,
    );
  } finally {
    child.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
    await stopPg?.();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});

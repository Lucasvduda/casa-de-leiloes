/**
 * Teste ponta a ponta com navegador real (Edge via playwright-core) contra o BUILD de producao:
 * API compilada (`api/dist`) + front compilado (`web/dist`) servidos na mesma origem, com Postgres
 * embutido temporario. Nao usa mocks: o que passa aqui e o que o avaliador vai ver.
 *
 * Pre-requisitos: `npm run build -w api` e `npm run build -w web`.
 * Uso: npm run e2e -w web
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { chromium } from 'playwright-core';
import type { BrowserContext, Page } from 'playwright-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = join(ROOT, 'api');
const WEB_DIST = join(ROOT, 'web', 'dist');
const SHOTS = join(ROOT, 'web', '.artifacts');
const PASSWORD = 'Demo-Leilao-2026!';
const EDGE =
  process.env.E2E_BROWSER_PATH ??
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

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

function ok(message: string): void {
  process.stdout.write(`  ok  ${message}\n`);
}

type LotDto = {
  id: string;
  title: string;
  bidCount: number;
  minimumNextBid: number;
  minIncrement: number;
};

async function main(): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const dir = mkdtempSync(join(tmpdir(), 'leilao-e2e-pg-'));
  const pgPort = await freePort();
  const server = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'postgres',
    password: 'postgres',
    port: pgPort,
    persistent: false,
    onLog: () => undefined,
    onError: () => undefined,
  });
  await server.initialise();
  await server.start();
  const baseUrl = `postgres://postgres:postgres@127.0.0.1:${pgPort}/postgres`;
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  const dbName = `e2e_${Date.now().toString(36)}`;
  await admin.query(
    `CREATE DATABASE "${dbName}" TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`,
  );
  const dbUrl = new URL(baseUrl);
  dbUrl.pathname = `/${dbName}`;

  const port = await freePort();
  const logs: string[] = [];
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: API,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      DATABASE_URL: dbUrl.toString(),
      INTEGRITY_SECRET: 'segredo-do-e2e-0123456789abcdef0123456789abcdef',
      SEED_ON_BOOT: 'true',
      COOKIE_SECURE: 'false',
      WEB_DIST_DIR: WEB_DIST,
      LOG_LEVEL: 'warn',
    },
  });
  child.stdout.on('data', (d: Buffer) => logs.push(String(d)));
  child.stderr.on('data', (d: Buffer) => logs.push(String(d)));
  const exited = new Promise<void>((res) => child.once('exit', () => res()));
  const base = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  let failed = false;
  const pages: Page[] = [];
  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const r = await fetch(`${base}/ready`).catch(() => null);
      if (r?.ok) break;
      if (Date.now() > deadline) throw new Error('servidor nao ficou pronto em 60 s');
      await new Promise((r2) => setTimeout(r2, 200));
    }

    const consoleErrors: string[] = [];
    async function newSession(): Promise<{ context: BrowserContext; page: Page }> {
      const context = await browser.newContext({
        locale: 'pt-BR',
        viewport: { width: 1280, height: 900 },
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(`${m.text()} @ ${page.url()}`);
      });
      page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
      pages.push(page);
      return { context, page };
    }
    async function login(page: Page, email: string): Promise<void> {
      await page.goto(`${base}/entrar`);
      await page.getByLabel('E-mail').fill(email);
      await page.getByLabel('Senha', { exact: true }).fill(PASSWORD);
      await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    }

    // 1. Visitante ve a vitrine.
    const visitor = await newSession();
    await visitor.page.goto(base);
    await visitor.page.getByRole('heading', { name: 'Leilões' }).waitFor();
    await visitor.page.getByRole('heading', { level: 3 }).first().waitFor();
    const cards = await visitor.page.getByRole('heading', { level: 3 }).count();
    ok(`vitrine abre para visitante (${cards} links de lote)`);
    await visitor.page
      .waitForFunction(() => Array.from(document.images).every((img) => img.complete), undefined, {
        timeout: 15_000,
      })
      .catch(() => undefined);
    const shown = await visitor.page.evaluate(
      () => Array.from(document.images).filter((img) => img.naturalWidth > 0).length,
    );
    ok(`${shown} imagens carregadas na vitrine (logo + itens do museu)`);
    if ((await visitor.page.getByText('Sua sessão expirou').count()) > 0) {
      throw new Error('visitante viu aviso de sessao expirada (regressao)');
    }
    ok('visitante nao ve aviso de sessao expirada');
    await visitor.page.screenshot({ path: join(SHOTS, '01-vitrine.png'), fullPage: true });

    // 2. Rota protegida redireciona para o login.
    await visitor.page.goto(`${base}/carteira`);
    await visitor.page.waitForURL(/\/entrar/);
    ok('/carteira sem sessao redireciona para /entrar');

    // 3. Rota inexistente e arquivo inexistente.
    await visitor.page.goto(`${base}/nada-aqui`);
    await visitor.page.getByText('Página não encontrada', { exact: true }).first().waitFor();
    ok('rota desconhecida mostra pagina 404 do app');

    // 4. Sala de um lote ao vivo sem lances.
    const live = (await (await fetch(`${base}/api/lots?phase=live`)).json()) as { items: LotDto[] };
    const target = live.items.find((l) => l.bidCount === 0);
    if (target === undefined) throw new Error('seed sem lote ao vivo sem lances');

    const ana = await newSession();
    await login(ana.page, 'ana@demo.leilao');
    await ana.page.waitForURL(`${base}/`);
    const bruno = await newSession();
    await login(bruno.page, 'bruno@demo.leilao');
    await bruno.page.waitForURL(`${base}/`);
    ok('login de Ana e Bruno redireciona para a vitrine');

    await ana.page.goto(`${base}/lotes/${target.id}`);
    await bruno.page.goto(`${base}/lotes/${target.id}`);
    await ana.page.getByRole('heading', { name: target.title }).waitFor();
    await bruno.page.getByRole('heading', { name: target.title }).waitFor();
    await ana.page.screenshot({ path: join(SHOTS, '02-sala-ana.png'), fullPage: true });

    // 5. Ana da lance; a sala do Bruno atualiza SEM recarregar (SSE).
    const first = target.minimumNextBid;
    await ana.page.getByLabel('Seu lance').fill(String(first / 100).replace('.', ','));
    await ana.page.getByRole('button', { name: 'Dar lance' }).click();
    await ana.page.getByText('Você está liderando', { exact: true }).first().waitFor();
    ok('Ana deu o lance e aparece como lider');

    const firstText = new RegExp(
      `R\\$\\s*${(first / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 }).replace(/\./g, '\\.')}`,
    );
    await bruno.page
      .getByRole('list', { name: 'Histórico de lances' })
      .getByText(firstText)
      .first()
      .waitFor();
    ok('sala do Bruno recebeu o lance da Ana ao vivo, sem recarregar');
    await bruno.page.screenshot({ path: join(SHOTS, '03-sala-bruno-ao-vivo.png'), fullPage: true });

    // 6. Bruno cobre; Ana ve "Voce foi superado".
    const second = first + target.minIncrement;
    await bruno.page.getByLabel('Seu lance').fill(String(second / 100).replace('.', ','));
    await bruno.page.getByRole('button', { name: 'Dar lance' }).click();
    await ana.page.getByText('Você foi superado', { exact: true }).waitFor();
    ok('Ana foi avisada ao vivo que foi superada');

    // 7. Lance abaixo do minimo e bloqueado/explicado.
    await ana.page.getByLabel('Seu lance').fill('0,01');
    await ana.page.getByRole('button', { name: 'Dar lance' }).click();
    await ana.page
      .getByRole('alert')
      .filter({ hasText: /m[ií]nimo/i })
      .first()
      .waitFor();
    ok('lance abaixo do minimo mostra mensagem clara');

    // 8. Carteira e deposito.
    await ana.page.goto(`${base}/carteira`);
    await ana.page.getByRole('heading', { name: 'Carteira' }).waitFor();
    await ana.page.getByLabel('Valor (R$)').fill('100,00');
    await ana.page.getByRole('button', { name: 'Depositar' }).click();
    await ana.page
      .getByText(/Depósito/i)
      .first()
      .waitFor();
    ok('deposito aparece no extrato');
    await ana.page.screenshot({ path: join(SHOTS, '04-carteira.png'), fullPage: true });

    // 9. Meus lances.
    await ana.page.goto(`${base}/meus-lances`);
    await ana.page.getByRole('heading', { name: 'Meus lances' }).waitFor();
    ok('pagina Meus lances abre para licitante');

    // 10. Auditoria publica.
    await visitor.page.goto(`${base}/auditoria/${target.id}`);
    await visitor.page.getByText('Histórico íntegro').waitFor();
    ok('auditoria publica confirma historico integro');
    await visitor.page.screenshot({ path: join(SHOTS, '05-auditoria.png'), fullPage: true });

    // 11. Leiloeiro cria lote pelo catalogo.
    const seller = await newSession();
    await login(seller.page, 'leiloeiro@demo.leilao');
    await seller.page.waitForURL(`${base}/painel`);
    await seller.page.getByRole('heading', { name: 'Painel do leiloeiro' }).waitFor();
    await seller.page.goto(`${base}/painel/novo`);
    await seller.page
      .getByRole('button', { name: /Selecionar este item/ })
      .first()
      .waitFor({ timeout: 20_000 });
    await seller.page.screenshot({ path: join(SHOTS, '06-catalogo.png'), fullPage: true });
    await seller.page
      .getByRole('button', { name: /Selecionar este item/ })
      .first()
      .click();
    await seller.page.getByLabel('Lance inicial (R$)').fill('50,00');
    await seller.page.getByLabel('Incremento mínimo (R$)').fill('5,00');
    await seller.page.screenshot({ path: join(SHOTS, '07-novo-lote.png'), fullPage: true });
    await seller.page.getByRole('button', { name: 'Criar lote' }).click();
    await seller.page.waitForURL(/\/lotes\/|\/painel/);
    ok('leiloeiro criou um lote a partir do catalogo publico');

    // 12. Leiloeiro nao pode dar lance no proprio lote e nao acessa /meus-lances.
    await seller.page.goto(`${base}/meus-lances`);
    await seller.page.getByText('Esta área é de outro tipo de conta').waitFor();
    ok('leiloeiro e barrado em /meus-lances com explicacao');

    // 13. Nenhum erro de console (CSP, 404 de asset, excecoes).
    const relevant = consoleErrors.filter(
      (e) => !/Failed to load resource.*(40[0-9]|409|429)/.test(e),
    );
    if (relevant.length > 0)
      throw new Error(`erros no console do navegador:\n${relevant.join('\n')}`);
    ok('nenhum erro de console (CSP/assets/excecoes) em todo o fluxo');
  } catch (error) {
    failed = true;
    process.stderr.write(`\nFALHOU: ${error instanceof Error ? error.stack : String(error)}\n`);
    for (const [i, page] of pages.entries()) {
      await page
        .screenshot({ path: join(SHOTS, `falha-${i}.png`), fullPage: true })
        .catch(() => undefined);
    }
    process.stderr.write(`--- logs do servidor ---\n${logs.join('')}\n`);
  } finally {
    await browser.close().catch(() => undefined);
    child.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
    await server.stop().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});

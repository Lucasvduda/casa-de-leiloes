/**
 * Verificacao por mutacao da subida da aplicacao: seed, operacoes de banco, servidor/desligamento,
 * raiz de composicao e servidor de arquivos do front.
 *
 * Remove uma defesa por vez e exige que ALGUM teste falhe. Cada arquivo e restaurado ao final.
 * Cada mutacao roda primeiro a suite mais barata que a cobre (`--bail 1`: para no 1o teste que falha)
 * e so cai para as seguintes se ela nao pegar.
 *
 * Uso (na pasta api): node scripts/mutation-check-boot.mjs [prefixo]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEED = `${API}/src/application/seed/demo-data.ts`;
const OPS = `${API}/src/adapters/outbound/postgres/operations.ts`;
const SERVER = `${API}/src/infrastructure/server.ts`;
const CONTAINER = `${API}/src/infrastructure/container.ts`;
const APP = `${API}/src/adapters/inbound/http/app.ts`;
const WEB = `${API}/src/adapters/inbound/http/middlewares/web-app.ts`;

const SUITES = {
  web: ['vitest', 'run', '--bail', '1', 'test/web-app.spec.ts'],
  seed: [
    'vitest',
    'run',
    '--config',
    'vitest.int.config.ts',
    '--bail',
    '1',
    'test/seed.int.spec.ts',
  ],
  boot: [
    'vitest',
    'run',
    '--config',
    'vitest.int.config.ts',
    '--bail',
    '1',
    'test/boot.int.spec.ts',
  ],
};

/** [nome, arquivo, [[de, para], ...], [suites em ordem]] */
const mutations = [
  // ----- seed -----
  [
    'd01 papel da conta existente nao conferido',
    SEED,
    [['if (found.role !== account.role) {', 'if (false) {']],
    ['seed'],
  ],
  [
    'd02 deposito sem chave de idempotencia',
    SEED,
    [['idempotencyKey: `${KEY_VERSION}:deposit:${name}`,', '']],
    ['seed'],
  ],
  [
    'd03 lance sem chave de idempotencia',
    SEED,
    [['idempotencyKey: `${KEY_VERSION}:${template.key}:${index + 1}`,', '']],
    ['seed'],
  ],
  [
    'd04 lotes existentes nao sao procurados',
    SEED,
    [['let lotId = existing.get(item.title);', 'let lotId: string | undefined = undefined;']],
    ['seed'],
  ],
  [
    'd05 lotes vencidos nao sao liquidados',
    SEED,
    [['if (template.endsAtOffsetMs < 0) await deps.settle.execute(lotId);', '']],
    ['seed'],
  ],
  [
    'd06 paginacao do painel ignorada',
    SEED,
    [['if (page >= result.totalPages) break;', 'break;']],
    ['seed'],
  ],
  [
    'd07 lance recusado em lote novo e engolido',
    SEED,
    [['if (isNew) {', 'if (false) {']],
    ['seed'],
  ],
  [
    'd08 lote criado sempre no presente',
    SEED,
    [['clock.set(Math.min(startsAt, startedAt));', 'clock.set(startedAt);']],
    ['seed'],
  ],
  [
    'd09 lances sem instante proprio',
    SEED,
    [['clock.set(startedAt + bid.atOffsetMs);', '']],
    ['seed'],
  ],
  ['d10 contagem de contas criadas', SEED, [['usersCreated += 1;', '']], ['seed']],
  [
    'd11 titulos existentes nao registrados',
    SEED,
    [['for (const lot of result.items) byTitle.set(lot.title, lot.id);', '']],
    ['seed'],
  ],

  // ----- operacoes de banco -----
  [
    'o01 advisory lock nunca liberado',
    OPS,
    [["await client.query('SELECT pg_advisory_unlock($1)', [lockId]).catch(() => undefined);", '']],
    ['boot'],
  ],
  [
    'o02 advisory lock nao adquirido',
    OPS,
    [["await client.query('SELECT pg_advisory_lock($1)', [lockId]);", '']],
    ['boot'],
  ],
  [
    'o03 codificacao do banco nao verificada',
    OPS,
    [["if (encoding.toUpperCase() !== 'UTF8') {", 'if (false) {']],
    ['boot'],
  ],
  [
    'o04 prazo da sonda vira "pronto"',
    OPS,
    [
      [
        'timer = setTimeout(() => resolve(false), timeoutMs);',
        'timer = setTimeout(() => resolve(true), timeoutMs);',
      ],
    ],
    ['boot'],
  ],
  [
    'o05 erro da sonda vira "pronto"',
    OPS,
    [['.catch(() => false);', '.catch(() => true);']],
    ['boot'],
  ],

  // ----- servidor e desligamento -----
  [
    'v01 keep-alive abaixo do balanceador',
    SERVER,
    [['server.keepAliveTimeout = 65_000;', '']],
    ['boot'],
  ],
  ['v02 headersTimeout removido', SERVER, [['server.headersTimeout = 66_000;', '']], ['boot']],
  [
    'v03 requestTimeout removido (slowloris)',
    SERVER,
    [['server.requestTimeout = 30_000;', '']],
    ['boot'],
  ],
  ['v04 SSE nao encerrado no desligamento', SERVER, [['hub.close();', '']], ['boot']],
  [
    'v05 conexoes ociosas nao varridas',
    SERVER,
    [
      [
        'const sweep = setInterval(() => server.closeIdleConnections(), 25);',
        'const sweep = setInterval(() => undefined, 25);',
      ],
    ],
    ['boot'],
  ],
  [
    'v06 conexoes presas nunca cortadas',
    SERVER,
    [
      [
        'const cutoff = setTimeout(() => server.closeAllConnections(), drainMs);',
        'const cutoff = setTimeout(() => undefined, drainMs);',
      ],
    ],
    ['boot'],
  ],
  [
    'v07 agendador nao parado no desligamento',
    SERVER,
    [['const stopped = scheduler.stop();', 'const stopped = Promise.resolve();']],
    ['boot'],
  ],
  [
    'v08 desligamento nao idempotente',
    SERVER,
    [['shuttingDown ??= (async () => {', 'shuttingDown = (async () => {']],
    ['boot'],
  ],
  [
    'v09 pool ja encerrado quebra o desligamento',
    SERVER,
    [
      [
        "await pool.end().catch((err: unknown) => logger.warn({ err }, 'pool_end_failed'));",
        'await pool.end();',
      ],
    ],
    ['boot'],
  ],
  [
    'v10 porta ocupada deixa o pool aberto',
    SERVER,
    [['await pool.end().catch(() => undefined);', '']],
    ['boot'],
  ],
  ['v11 agendador nunca iniciado', SERVER, [['scheduler.start();', '']], ['boot']],

  // ----- composicao -----
  [
    'c01 cookie sem prefixo __Host-',
    CONTAINER,
    [["name: secure ? '__Host-leilao_sid' : 'leilao_sid',", "name: 'leilao_sid',"]],
    ['boot'],
  ],
  [
    'c02 COOKIE_SECURE ignorado',
    CONTAINER,
    [
      [
        "const secure = config.COOKIE_SECURE ?? config.NODE_ENV === 'production';",
        "const secure = config.NODE_ENV === 'production';",
      ],
    ],
    ['boot'],
  ],
  ['c03 UTF8 nao exigido no boot', CONTAINER, [['await assertUtf8(pool);', '']], ['boot']],
  [
    'c04 boot que falha deixa o pool aberto',
    CONTAINER,
    [['await pool.end().catch(() => undefined);', '']],
    ['boot'],
  ],
  [
    'c05 seed sempre ligado',
    CONTAINER,
    [['if (config.SEED_ON_BOOT || overrides.forceSeed === true) {', 'if (true) {']],
    ['boot'],
  ],
  [
    'c06 WEB_DIST_DIR nao repassado',
    CONTAINER,
    [['...(config.WEB_DIST_DIR !== undefined ? { webDistDir: config.WEB_DIST_DIR } : {}),', '']],
    ['boot'],
  ],
  [
    'c07 limpeza de sessoes fora do agendador',
    CONTAINER,
    [['purgeSessionsTask(auth),', '']],
    ['boot'],
  ],
  [
    'c08 DB_POOL_MAX ignorado',
    CONTAINER,
    [['createPool(config.DATABASE_URL, config.DB_POOL_MAX)', 'createPool(config.DATABASE_URL)']],
    ['boot'],
  ],
  [
    'c09 prontidao nao consulta o banco',
    CONTAINER,
    [['readinessProbe: postgresReadiness(pool),', 'readinessProbe: async () => true,']],
    ['boot'],
  ],

  // ----- app (CSP e montagem do front) -----
  [
    'a01 imagens do museu bloqueadas pela CSP',
    APP,
    [["'img-src': [\"'self'\", 'data:', ...IMAGE_HOSTS],", "'img-src': [\"'self'\", 'data:'],"]],
    ['web'],
  ],
  [
    'a02 upgrade-insecure-requests ligado',
    APP,
    [["'upgrade-insecure-requests': null,", '']],
    ['web'],
  ],
  ['a03 front nao montado', APP, [['app.use(serveWebApp(deps.webDistDir));', '']], ['web', 'boot']],

  // ----- servidor de arquivos do front -----
  [
    'w01 cache imutavel removido',
    WEB,
    [
      [
        "res.setHeader('Cache-Control', `public, max-age=${ONE_YEAR_S}, immutable`);",
        "res.setHeader('Cache-Control', 'no-cache');",
      ],
    ],
    ['web'],
  ],
  ['w02 dotfiles servidos', WEB, [["dotfiles: 'ignore',", "dotfiles: 'allow',"]], ['web']],
  ['w03 fallback responde em /api', WEB, [[' || isServerPath(req.path)) {', ') {']], ['web']],
  [
    'w04 fallback responde a arquivo inexistente',
    WEB,
    [["if (looksLikeFile || !req.accepts('html')) {", 'if (false) {']],
    ['web'],
  ],
  [
    'w05 fallback responde a escrita',
    WEB,
    [
      [
        "if ((req.method !== 'GET' && req.method !== 'HEAD') || isServerPath(req.path)) {",
        'if (isServerPath(req.path)) {',
      ],
    ],
    ['web'],
  ],
  [
    'w06 index.html servido com cache',
    WEB,
    [["if (relativePath === 'index.html') noStore(res);", 'if (false) noStore(res);']],
    ['web'],
  ],
  [
    'w07 fallback sem no-cache',
    WEB,
    [['    noStore(res);\n    // `root`', '    // `root`']],
    ['web'],
  ],
  [
    'w08 /api servido do disco',
    WEB,
    [
      [
        'if (isServerPath(req.path)) next();\n    else files(req, res, next);',
        'files(req, res, next);',
      ],
    ],
    ['web'],
  ],
  [
    'w09 index.html ausente nao detectado',
    WEB,
    [['if (!existsSync(indexFile)) {', 'if (false) {']],
    ['web'],
  ],
  [
    'w10 cache usa caminho absoluto',
    WEB,
    [
      [
        "const relativePath = relative(root, filePath).split(sep).join('/');",
        'const relativePath = filePath;',
      ],
    ],
    ['web'],
  ],
  [
    'w11 sendFile sem root',
    WEB,
    [
      [
        "res.sendFile('index.html', { root, dotfiles: 'deny' },",
        "res.sendFile(indexFile, { dotfiles: 'deny' },",
      ],
    ],
    ['web'],
  ],
];

function caught(args) {
  const r = spawnSync('npx', args, { cwd: API, shell: true, encoding: 'utf8' });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const m = /Tests\s+(\d+) failed/.exec(out);
  if (m) return `${m[1]} teste(s) falharam`;
  if (r.status !== 0) return 'suite quebrou';
  return null;
}

const only = process.argv[2];
let survivors = 0;
let ran = 0;

for (const [name, file, pairs, suites] of mutations) {
  if (only !== undefined && !name.startsWith(only)) continue;
  ran++;
  const original = readFileSync(file, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  let mutated = original;
  let applicable = true;
  for (const [from, to] of pairs) {
    const f = from.replaceAll('\n', eol);
    if (!mutated.includes(f)) applicable = false;
    mutated = mutated.replace(f, () => to.replaceAll('\n', eol));
  }
  if (!applicable) {
    console.log(`SKIP       ${name}: trecho nao encontrado (atualize o script)`);
    survivors++;
    continue;
  }
  writeFileSync(file, mutated);
  try {
    let hit = null;
    let by = '';
    for (const suite of suites) {
      hit = caught(SUITES[suite]);
      if (hit) {
        by = suite;
        break;
      }
    }
    if (hit) console.log(`PEGOU      ${name} (${hit} em ${by})`);
    else {
      console.log(`SOBREVIVEU ${name}`);
      survivors++;
    }
  } finally {
    writeFileSync(file, original);
  }
}
console.log(`\nSobreviventes: ${survivors} de ${ran}`);
process.exit(survivors === 0 ? 0 : 1);

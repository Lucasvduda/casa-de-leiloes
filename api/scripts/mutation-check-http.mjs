/**
 * Verificacao por mutacao da camada HTTP.
 *
 * Para cada defesa (autorizacao, privacidade, validacao, limites), remove-a do codigo, roda a suite
 * que deveria proteger aquele comportamento e exige que ela FALHE. Se um teste continuar verde sem
 * a defesa, ele nao protege nada. Cada arquivo e restaurado ao final (mesmo em caso de erro).
 *
 * Uso (na pasta api): node scripts/mutation-check-http.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const R = `${API}/src/adapters/inbound/http/routes`;
const RM = `${API}/src/adapters/outbound/postgres/pg-auction-read-model.ts`;
const Q = `${API}/src/application/usecases/auction-queries.ts`;

const mutations = [
  [
    'm01 limite de lances removido',
    `${R}/lots-routes.ts`,
    "requireRole('bidder'), limiters.bid,",
    "requireRole('bidder'),",
    'api-catalog',
  ],
  [
    'm02 regex de sourceId frouxa',
    `${R}/lots-routes.ts`,
    '/^[A-Za-z0-9_.-]{1,100}$/',
    '/^.{1,100}$/',
    'api-lots',
  ],
  [
    'm03 Idempotency-Key descartada',
    `${R}/lots-routes.ts`,
    "idempotencyKey: req.get('idempotency-key'),",
    'idempotencyKey: undefined,',
    'api-lots',
  ],
  [
    'm04 item vindo do cliente',
    `${R}/lots-routes.ts`,
    'await catalog.getItem(sourceId)',
    '((req.body).item ?? (await catalog.getItem(sourceId)))',
    'api-lots',
  ],
  [
    'm05 criar lote sem papel de leiloeiro',
    `${R}/lots-routes.ts`,
    "router.post('/lots', requireRole('seller'),",
    "router.post('/lots', requireRole('bidder'),",
    'api-lots',
  ],
  [
    'm06 catalogo aberto a qualquer logado',
    `${R}/account-routes.ts`,
    "requireRole('seller'), limiters.catalog",
    'requireAuth, limiters.catalog',
    'api-lots',
  ],
  [
    'm07 deposito aberto a leiloeiro',
    `${R}/account-routes.ts`,
    "requireRole('bidder'), limiters.deposit",
    'requireAuth, limiters.deposit',
    'api-lots',
  ],
  [
    'm08 limite de deposito removido',
    `${R}/account-routes.ts`,
    "requireRole('bidder'), limiters.deposit,",
    "requireRole('bidder'),",
    'api-catalog',
  ],
  [
    'm09 LIKE sem escape',
    RM,
    'return value.replace(/[\\\\%_]/g, (ch) => `\\\\${ch}`);',
    'return value;',
    'api-listing',
  ],
  [
    'm10 preco ignora lance corrente',
    RM,
    'COALESCE(l.current_amount_cents, l.starting_bid_cents) ASC',
    'l.starting_bid_cents ASC',
    'api-listing',
  ],
  [
    'm11 sem desempate por id (newest)',
    RM,
    "'l.created_at DESC, l.id ASC'",
    "'l.created_at DESC'",
    'api-listing',
  ],
  [
    'm12 /me/bids mostra lotes de todos',
    RM,
    'AND b.bidder_id = ${bind(query.bidderId)})',
    'AND ${bind(query.bidderId)}::text IS NOT NULL)',
    'api-listing',
  ],
  [
    'm13 /me/wins mostra arremates de todos',
    RM,
    'r.winner_id = ${bind(query.wonBy)}',
    'r.winner_id IS NOT NULL AND ${bind(query.wonBy)}::text IS NOT NULL',
    'api-listing',
  ],
  [
    'm14 /me/lots mostra lotes de todos',
    RM,
    'l.seller_id = ${bind(query.sellerId)}',
    '${bind(query.sellerId)}::text IS NOT NULL',
    'api-listing',
  ],
  [
    'm15 extrato vaza movimentos alheios',
    RM,
    'WHERE e.user_id = $1 AND',
    'WHERE ($1::text IS NOT NULL) AND',
    'api-listing',
  ],
  [
    'm16 total errado alem da ultima pagina',
    RM,
    'if (first === undefined && query.page > 1)',
    'if (false)',
    'api-listing',
  ],
  [
    'm17 licitante exposto com id real',
    Q,
    'bidder: publicBidderRef(mac, bid.bidderId, lot.id),',
    'bidder: bid.bidderId,',
    'api-lots',
  ],
  [
    'm18 todo lance marcado como "meu"',
    Q,
    'mine: viewer !== null && bid.bidderId === viewer.id,',
    'mine: true,',
    'api-lots',
  ],
  [
    'm19 sala nao liquida lote vencido',
    Q,
    "snapshot.lot.status === 'open' && now.getTime() >= snapshot.lot.endsAt.getTime()",
    'false',
    'api-lots',
  ],
  ['m20 pageSize sem teto', Q, '.max(50)', '.max(5000)', 'api-listing'],
];

// Opcional: `node scripts/mutation-check-http.mjs m07` roda so as mutacoes cujo nome comeca assim.
const only = process.argv[2];

let survivors = 0;
for (const [name, file, from, to, spec] of mutations) {
  if (only !== undefined && !name.startsWith(only)) continue;
  const original = readFileSync(file, 'utf8');
  if (!original.includes(from)) {
    console.log(`SKIP       ${name}: trecho nao encontrado (atualize o script)`);
    survivors++;
    continue;
  }
  writeFileSync(file, original.replace(from, to));
  try {
    const r = spawnSync(
      'npx',
      ['vitest', 'run', '--config', 'vitest.int.config.ts', `test/${spec}.http.int.spec.ts`],
      {
        cwd: API,
        shell: true,
        encoding: 'utf8',
      },
    );
    const out = (r.stdout ?? '') + (r.stderr ?? '');
    const failed = /Tests\s+(\d+) failed/.exec(out);
    if (failed) console.log(`PEGOU      ${name} (${failed[1]} testes falharam)`);
    else {
      console.log(`SOBREVIVEU ${name}`);
      survivors++;
    }
  } finally {
    writeFileSync(file, original);
  }
}
console.log(`\nSobreviventes: ${survivors} de ${mutations.length}`);
process.exit(survivors === 0 ? 0 : 1);

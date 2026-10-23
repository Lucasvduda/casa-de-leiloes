/**
 * Verificacao por mutacao do front-end: remove UMA defesa por vez e exige que algum teste falhe.
 * Cada arquivo e restaurado ao final (mesmo se o script for interrompido).
 *
 * Uso (na pasta web): node scripts/mutation-check.mjs [prefixo]
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = (path) => `${WEB}/src/${path}`;

/** [nome, arquivo, [[de, para], ...], arquivos de teste que devem pegar] */
const mutations = [
  // ----- cliente HTTP -----
  [
    'c01 token CSRF nao enviado',
    src('api/client.ts'),
    [["if (csrf !== null) headers['X-CSRF-Token'] = csrf;", '']],
    ['api/client.spec.ts'],
  ],
  [
    'c02 escrita sem Content-Type JSON',
    src('api/client.ts'),
    [["headers['Content-Type'] = 'application/json';", '']],
    ['api/client.spec.ts'],
  ],
  [
    'c03 Idempotency-Key nao enviada',
    src('api/client.ts'),
    [
      [
        "if (req.idempotencyKey !== undefined) headers['Idempotency-Key'] = req.idempotencyKey;",
        '',
      ],
    ],
    ['api/client.spec.ts'],
  ],
  [
    'c04 401 nao avisa a aplicacao',
    src('api/client.ts'),
    [["if (response.status === 401 && error.code === 'UNAUTHENTICATED') {", 'if (false) {']],
    ['api/client.spec.ts', 'features/auth/session.spec.tsx'],
  ],
  // ----- sessao -----
  [
    's01 visitante recebe aviso de sessao expirada',
    src('features/auth/session.tsx'),
    [['if (!authenticatedRef.current) return;', '']],
    ['features/auth/session.spec.tsx'],
  ],
  [
    's02 open redirect //',
    src('features/auth/session.tsx'),
    [["|| next.startsWith('//')", '']],
    ['features/auth/session.spec.tsx'],
  ],
  [
    's03 open redirect com caractere de controle',
    src('features/auth/session.tsx'),
    [["if (next.charCodeAt(i) < 0x20) return '/';", '']],
    ['features/auth/session.spec.tsx'],
  ],
  [
    's04 servidor fora do ar vira "deslogado"',
    src('features/auth/session.tsx'),
    [["setStatus('error');", "setStatus('anonymous');"]],
    ['features/auth/session.spec.tsx'],
  ],
  [
    's05 login nao limpa o cache de quem estava antes',
    src('features/auth/session.tsx'),
    [['      queryClient.clear();\n      setUser(payload.user);', '      setUser(payload.user);']],
    ['features/auth/session.spec.tsx'],
  ],
  // ----- guardas de rota -----
  [
    'g01 papel nao conferido',
    src('app/guards.tsx'),
    [['if (role !== undefined && user.role !== role) {', 'if (false) {']],
    ['app/guards.spec.tsx'],
  ],
  [
    'g02 visitante entra em rota protegida',
    src('app/guards.tsx'),
    [["if (status !== 'authenticated' || user === null) {", 'if (false) {']],
    ['app/guards.spec.tsx'],
  ],
  // ----- sala de lances -----
  [
    'r01 evento duplicado reaplicado',
    src('features/lots/room-state.ts'),
    [['if (event.seq <= lot.bidCount) return lot;', '']],
    ['features/lots/room-state.spec.ts'],
  ],
  [
    'b01 lance igual ao minimo recusado',
    src('features/lots/BidPanel.tsx'),
    [['if (amount < lot.minimumNextBid) {', 'if (amount <= lot.minimumNextBid) {']],
    ['features/lots/BidPanel.spec.tsx'],
  ],
  [
    'b02 saldo exato recusado',
    src('features/lots/BidPanel.tsx'),
    [
      [
        'availableCents !== undefined && amount > availableCents',
        'availableCents !== undefined && amount >= availableCents',
      ],
    ],
    ['features/lots/BidPanel.spec.tsx'],
  ],
  [
    'b03 sem segunda confirmacao de valor incomum',
    src('features/lots/BidPanel.tsx'),
    [['if (unusual && !confirming) {', 'if (false) {']],
    ['features/lots/BidPanel.spec.tsx'],
  ],
  [
    'b04 chave de idempotencia nunca liberada apos rejeicao',
    src('features/lots/BidPanel.tsx'),
    [
      [
        '        intent.current.release();\n        setSubmitError(messageForError(error));',
        '        setSubmitError(messageForError(error));',
      ],
    ],
    ['features/lots/BidPanel.spec.tsx'],
  ],
  [
    'b05 chave nova a cada tentativa (reenvio duplica)',
    src('features/lots/BidPanel.tsx'),
    [
      [
        'const key = intent.current.keyFor(`${lot.id}:${amount}`);',
        'const key = crypto.randomUUID();',
      ],
    ],
    ['features/lots/BidPanel.spec.tsx'],
  ],
  [
    'b06 formulario aparece para quem lidera',
    src('features/lots/BidPanel.tsx'),
    [["if (status === 'leading') {", 'if (false) {']],
    ['features/lots/BidPanel.spec.tsx'],
  ],
  [
    'b07 leiloeiro ve formulario de lance',
    src('features/lots/BidPanel.tsx'),
    [["if (user.role === 'seller') {", 'if (false) {']],
    ['features/lots/BidPanel.spec.tsx'],
  ],
  // ----- dialogo -----
  [
    'd01 Esc nao cancela',
    src('components/ConfirmDialog.tsx'),
    [["if (event.key === 'Escape' && !loading) {", 'if (false) {']],
    ['components/ConfirmDialog.spec.tsx'],
  ],
  [
    'd02 foco nao entra no botao seguro',
    src('components/ConfirmDialog.tsx'),
    [['cancelRef.current?.focus();', '']],
    ['components/ConfirmDialog.spec.tsx'],
  ],
  [
    'd03 foco nao volta a quem abriu',
    src('components/ConfirmDialog.tsx'),
    [['return () => previous?.focus();', 'return undefined;']],
    ['components/ConfirmDialog.spec.tsx'],
  ],
  // ----- carteira / meus lances / boundary -----
  [
    'w01 limite de deposito aceita 1 centavo a mais',
    src('features/wallet/WalletPage.tsx'),
    [['if (amount > MAX_SINGLE_DEPOSIT_CENTS) {', 'if (amount > MAX_SINGLE_DEPOSIT_CENTS + 1) {']],
    ['features/wallet/WalletPage.spec.ts'],
  ],
  [
    'w02 teto da carteira ignora saldo atual',
    src('features/wallet/WalletPage.tsx'),
    [
      [
        'if (currentTotal + amount > MAX_WALLET_BALANCE_CENTS) {',
        'if (amount > MAX_WALLET_BALANCE_CENTS) {',
      ],
    ],
    ['features/wallet/WalletPage.spec.ts'],
  ],
  [
    'm01 cancelado mostrado como arrematado',
    src('features/bidder/MyBidsPage.tsx'),
    [
      [
        "if (phase === 'cancelled') return { label: 'Cancelado, valor devolvido', tone: 'danger' };",
        '',
      ],
    ],
    ['features/bidder/MyBidsPage.spec.ts'],
  ],
  [
    'r01 superado fora da janela de 50 deixa de ser superado',
    src('features/lots/room-state.ts'),
    [['lot.viewerDetail?.hasBid === true || ', '']],
    ['features/lots/room-state.spec.ts', 'features/lots/BidPanel.spec.tsx'],
  ],
  [
    'r02 posicao conta lances em vez de licitantes diferentes',
    src('features/lots/room-state.ts'),
    [['seen.add(bid.bidder);', 'seen.add(String(bid.seq));']],
    ['features/lots/room-state.spec.ts'],
  ],
  [
    'r03 lance novo de outro mantem a posicao velha',
    src('features/lots/room-state.ts'),
    [['return { ...detail, position: positionInWindow(bids) };', 'return detail;']],
    ['features/lots/room-state.spec.ts'],
  ],
  [
    'x01 cancelar aparece em lote com lances',
    src('features/lots/CancelLotButton.tsx'),
    [['if (bidCount > 0) {', 'if (false) {']],
    ['features/lots/BidPanel.spec.tsx'],
  ],
  [
    'e01 boundary nao captura o erro',
    src('app/ErrorBoundary.tsx'),
    [['return { failed: true };', 'return { failed: false };']],
    ['app/ErrorBoundary.spec.tsx'],
  ],
];

function run(files) {
  const r = spawnSync('npx', ['vitest', 'run', '--bail', '1', ...files], {
    cwd: WEB,
    shell: true,
    encoding: 'utf8',
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const m = /Tests\s+(\d+) failed/.exec(out);
  if (m) return `${m[1]} teste(s) falharam`;
  if (r.status !== 0) return 'suite quebrou';
  return null;
}

const only = process.argv[2];
let survivors = 0;
let ran = 0;

for (const [name, file, pairs, tests] of mutations) {
  if (only !== undefined && !name.startsWith(only)) continue;
  ran += 1;
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
    survivors += 1;
    continue;
  }
  writeFileSync(file, mutated);
  let result;
  try {
    result = run(tests);
  } finally {
    writeFileSync(file, original);
  }
  if (result === null) {
    survivors += 1;
    console.log(`SOBREVIVEU ${name}`);
  } else {
    console.log(`pego       ${name}: ${result}`);
  }
}

console.log(`\n${ran - survivors}/${ran} mutacoes pegas`);
process.exit(survivors === 0 ? 0 : 1);

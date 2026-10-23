/**
 * Verificacao por mutacao do tempo real: hub SSE, rota de eventos, agendador e quarentena de liquidacao.
 *
 * Remove uma defesa por vez, roda as suites (unitaria primeiro, integracao se a unitaria nao pegar) e
 * exige que ALGUM teste FALHE. Cada arquivo e restaurado ao final (mesmo se o script for interrompido
 * pelo erro, via finally).
 *
 * Uso (na pasta api): node scripts/mutation-check-realtime.mjs [prefixo]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HUB = `${API}/src/adapters/inbound/http/sse/lot-event-hub.ts`;
const ROUTE = `${API}/src/adapters/inbound/http/routes/events-routes.ts`;
const SCH = `${API}/src/infrastructure/scheduler.ts`;
const SETTLE = `${API}/src/application/usecases/settle-lot.ts`;

/** [nome, arquivo, [[de, para], ...]] */
const mutations = [
  // ----- hub -----
  [
    'h01 teto global de conexoes removido',
    HUB,
    [['if (this.total >= this.limits.maxConnections) {', 'if (false) {']],
  ],
  ['h02 teto por sala removido', HUB, [['>= this.limits.maxPerLot) {', '>= Infinity) {']]],
  ['h03 teto por IP removido', HUB, [['>= this.limits.maxPerIp) {', '>= Infinity) {']]],
  ['h04 hub fechado aceita conexao', HUB, [['if (this.closed) {', 'if (false) {']]],
  ['h05 lance repetido/antigo nao filtrado', HUB, [['if (event.seq <= conn.lastSeq) return;', '']]],
  [
    'h06 flag mine sempre verdadeira',
    HUB,
    [['mine: conn.viewer !== null && conn.viewer.id === event.bidderId,', 'mine: true,']],
  ],
  ['h07 outbid conta o proprio lance', HUB, [['conn.viewer.id !== event.bidderId,', 'true,']]],
  [
    'h08 consumidor lento nao derrubado antes de escrever',
    HUB,
    [['if (conn.sink.writableLength > this.limits.maxBufferedBytes) {', 'if (false) {']],
  ],
  [
    'h09 consumidor lento nao derrubado depois de escrever',
    HUB,
    [
      [
        "if (conn.sink.writableLength > this.limits.maxBufferedBytes) this.drop(conn, 'slow_consumer');",
        '',
      ],
    ],
  ],
  ['h10 falha de escrita nao derruba a conexao', HUB, [["this.drop(conn, 'write_failed');", '']]],
  [
    'h11 fila pendente sem limite',
    HUB,
    [['if (conn.pending.length >= this.limits.maxPendingEvents) {', 'if (false) {']],
  ],
  ['h12 remocao nao idempotente', HUB, [['conn.removed = true;', '']]],
  [
    'h13 contador por IP nunca decrementa',
    HUB,
    [['const ipCount = (this.perIp.get(conn.ip) ?? 1) - 1;', 'const ipCount = 99;']],
  ],
  ['h14 contador total nunca decrementa', HUB, [['this.total -= 1;', '']]],
  [
    'h15 vida maxima ignorada',
    HUB,
    [['if (now - conn.openedAt >= this.limits.maxLifetimeMs) {', 'if (false) {']],
  ],
  [
    'h16 desconexao durante o snapshot nao libera',
    HUB,
    [["params.signal?.addEventListener('abort', onAbort, { once: true });", '']],
  ],
  [
    'h17 lote encerrado abre stream',
    HUB,
    [["if (snapshot.phase === 'closed' || snapshot.phase === 'cancelled') {", 'if (false) {']],
  ],
  [
    'h18 erro no snapshot vaza a vaga',
    HUB,
    [['this.remove(conn);\n      throw error;', 'throw error;']],
  ],
  ['h19 close() nao marca hub como fechado', HUB, [['this.closed = true;', '']]],
  [
    'h20 eventos vazam entre salas',
    HUB,
    [
      [
        'const set = this.byLot.get(event.lotId);',
        'const set = this.byLot.values().next().value as Set<Connection> | undefined;',
      ],
    ],
  ],
  [
    'h21 fila pendente nunca entregue',
    HUB,
    [['for (const event of queued) {', 'for (const event of [] as AuctionEvent[]) {']],
  ],
  [
    'h22 corrida snapshot/lance (lastSeq ignora snapshot)',
    HUB,
    [['conn.lastSeq = snapshot.bidCount;', 'conn.lastSeq = 0;']],
  ],
  [
    'h23 batimento antes do snapshot',
    HUB,
    [['if (!conn.ready || conn.removed) continue;', 'if (conn.removed) continue;']],
  ],
  [
    'h24 evento final nao encerra o stream',
    HUB,
    [
      [
        '    this.remove(conn);\n    conn.sink.end();\n  }\n\n  private write',
        '    this.remove(conn);\n  }\n\n  private write',
      ],
    ],
  ],
  [
    'h25 cancelamento nao notificado',
    HUB,
    [["this.finish(conn, frame('cancelled', { serverNow }));", '']],
  ],
  [
    'h26 fechamento nao notificado',
    HUB,
    [["this.finish(conn, frame('closed', { sold: event.sold, serverNow }));", '']],
  ],
  [
    'h27 proximo lance minimo omitido',
    HUB,
    [['conn.minIncrement === null ? null : addCents(event.amount, conn.minIncrement)', 'null']],
  ],
  [
    'h28 dica de reconexao (retry) removida',
    HUB,
    [['params.sink.write(`retry: ${this.limits.retryMs}\\n\\n`);', '']],
  ],

  // ----- rota -----
  ['r01 no-transform removido', ROUTE, [["'no-cache, no-transform'", "'no-cache'"]]],
  ['r02 X-Accel-Buffering removido', ROUTE, [["res.setHeader('X-Accel-Buffering', 'no');", '']]],
  ['r03 fechamento da conexao nao aborta', ROUTE, [["res.on('close', () => abort.abort());", '']]],
  [
    'r04 lote encerrado nao responde 204',
    ROUTE,
    [["if (result.status === 'finished' && !res.headersSent) res.status(204).end();", '']],
  ],
  [
    'r05 espectador logado tratado como anonimo',
    ROUTE,
    [['viewer: req.auth?.actor ?? null,', 'viewer: null,']],
  ],
  [
    'r06 limite de taxa da rota removido',
    ROUTE,
    [["'/lots/:id/events', limiters.events,", "'/lots/:id/events',"]],
  ],

  // ----- agendador -----
  ['s01 laco morre depois da primeira execucao', SCH, [['this.schedule(task, task.everyMs);', '']]],
  [
    's02 log que lanca derruba a execucao',
    SCH,
    [
      [
        '} catch {\n        // Log com defeito nao pode derrubar o processo (rejeicao sem tratamento) nem parar o laco.\n      }',
        '} finally {\n      }',
      ],
    ],
  ],
  ['s03 stop() nao espera a execucao em curso', SCH, [['await Promise.all(running);', '']]],
  ['s04 timers mantem o processo vivo', SCH, [['timer.unref?.();', '']]],
  [
    's05 start() duplicado ou apos stop()',
    SCH,
    [['if (this.started || this.stopped) return;', 'if (false) return;']],
  ],
  [
    's06 reagenda depois do stop()',
    SCH,
    [['if (slot === undefined || this.stopped) return;', 'if (slot === undefined) return;']],
  ],
  ['s07 nomes duplicados aceitos', SCH, [['names.size !== tasks.length', 'false']]],
  ['s08 intervalo invalido aceito', SCH, [['task.everyMs < 1', 'false']]],
  [
    's09 runOnStart ignorado',
    SCH,
    [['task.runOnStart === false ? task.everyMs : 0', 'task.everyMs']],
  ],
  [
    's10 liquidacao nao repete enquanto a fila vem cheia',
    SCH,
    [['if (settled + failed.length < batchSize) return;', 'return;']],
  ],
  ['s11 sem teto de lotes por ciclo', SCH, [['batch < maxBatches;', 'true;']]],
  [
    's12 falha de liquidacao nao e registrada',
    SCH,
    [["logger.error({ lotId, err: error }, 'settle_due_lot_failed');", '']],
  ],

  // ----- quarentena de liquidacao -----
  [
    'q01 quarentena nunca expira',
    SETTLE,
    [['if (retryAt <= nowMs) this.quarantine.delete(lotId);', '']],
  ],
  [
    'q02 lote em quarentena volta a ser tentado',
    SETTLE,
    [['candidates.filter((id) => !this.quarantine.has(id))', 'candidates']],
  ],
  [
    'q03 lotes em quarentena ocupam o lote do ciclo',
    SETTLE,
    [['limit + this.quarantine.size', 'limit']],
  ],
  [
    'q04 quarentena sem limite de tamanho',
    SETTLE,
    [
      [
        'if (this.quarantine.size < (this.deps.maxQuarantined ?? MAX_QUARANTINED)) {',
        'if (true) {',
      ],
    ],
  ],
  [
    'q05 quarentena sem duracao',
    SETTLE,
    [['nowMs + (this.deps.failureCooldownMs ?? DEFAULT_COOLDOWN_MS)', '0']],
  ],
];

const UNIT = ['vitest', 'run', 'test/sse', 'test/scheduler.spec.ts'];
const INT = [
  'vitest',
  'run',
  '--config',
  'vitest.int.config.ts',
  'test/api-events.http.int.spec.ts',
  'test/scheduler.int.spec.ts',
  'test/settlement.int.spec.ts',
];

function failed(args) {
  const r = spawnSync('npx', args, { cwd: API, shell: true, encoding: 'utf8' });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const m = /Tests\s+(\d+) failed/.exec(out);
  // Erro de compilacao/execucao sem "Tests N failed" tambem conta como pego.
  if (m) return `${m[1]} testes falharam`;
  if (r.status !== 0) return 'suite quebrou';
  return null;
}

const only = process.argv[2];
let survivors = 0;
let ran = 0;

for (const [name, file, pairs] of mutations) {
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
    const hit = failed(UNIT) ?? failed(INT);
    if (hit) console.log(`PEGOU      ${name} (${hit})`);
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

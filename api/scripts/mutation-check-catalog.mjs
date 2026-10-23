/**
 * Verificacao por mutacao do adaptador de catalogo externo.
 *
 * Remove uma defesa por vez (SSRF, teto de bytes, breaker, cache, validacao de payload...), roda a
 * suite do catalogo e exige que ela FALHE. Cada arquivo e restaurado ao final.
 *
 * Uso (na pasta api): node scripts/mutation-check-catalog.mjs [prefixo]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = `${API}/src/adapters/outbound/catalog`;
const FETCH = `${DIR}/resilient-fetch.ts`;
const CAT = `${DIR}/cleveland-catalog.ts`;
const MAP = `${DIR}/cleveland-mapper.ts`;

/** [nome, arquivo, [[de, para], ...]] */
const mutations = [
  ['m01 redirect seguido (SSRF)', FETCH, [["redirect: 'error'", "redirect: 'follow'"]]],
  ['m02 teto de bytes na leitura removido', FETCH, [['if (size > maxBytes) {', 'if (false) {']]],
  ['m03 Content-Length ignorado', FETCH, [['declared > options.maxBytes', 'false']]],
  [
    'm04 content-type nao verificado',
    FETCH,
    [['if (!/json/i.test(', 'if (false && !/json/i.test(']],
  ],
  ['m05 timeout nao aborta a conexao', FETCH, [['controller.abort();', '']]],
  ['m07 retry tambem em erro definitivo', FETCH, [['!error.retryable ||', '']]],
  [
    'm08 429 nao e repetivel',
    FETCH,
    [['this.status === 429 || this.status >= 500', 'this.status >= 500']],
  ],
  [
    'm09 sonda unica do meio-aberto removida',
    FETCH,
    [
      [
        "if (state === 'open' || this.probing) return false;",
        "if (state === 'open') return false;",
      ],
    ],
  ],
  ['m10 sucesso nao zera falhas', FETCH, [['this.failures = 0;', '']]],
  [
    'm11 404 conta como falha do breaker',
    CAT,
    [
      [
        'if (error instanceof UpstreamNotFound) this.breaker.onSuccess();',
        'if (false) this.breaker.onSuccess();',
      ],
    ],
  ],
  [
    'm12 sem coalescencia de requisicoes',
    CAT,
    [['if (existing !== undefined) return existing as Promise<T>;', '']],
  ],
  [
    'm13 inflight nunca liberado',
    CAT,
    [['.finally(() => this.inflight.delete(key))', '.finally(() => undefined)']],
  ],
  ['m14 cache sem limite', CAT, [['while (this.entries.size > this.max)', 'while (false)']]],
  [
    'm15 id nao validado antes de chamar a API',
    CAT,
    [['if (!SOURCE_ID_PATTERN.test(sourceId)) throw itemNotFound();', '']],
  ],
  ['m16 item de outro id aceito', CAT, [['mapped.sourceId !== sourceId', 'false']]],
  [
    'm17 termo injetado sem codificar',
    CAT,
    [
      ["if (q !== '') params.set('q', q);", "const raw = q !== '' ? `&q=${q}` : '';"],
      ['?${params.toString()}`', '?${params.toString()}${raw}`'],
    ],
  ],
  [
    'm18 cache vencido nunca serve (sem stale-if-error)',
    CAT,
    [['cached !== undefined && cached.ageMs < this.o.staleMs', 'false']],
  ],
  ['m19 cache vencido serve para sempre', CAT, [['cached.ageMs < this.o.staleMs', 'true']]],
  ['m20 cache fresco nunca expira', CAT, [['cached.ageMs < this.o.freshMs', 'true']]],
  [
    'm21 fallback offline nao marca degradado',
    CAT,
    [
      [
        'this.toResult(this.searchOffline(q, page), page, true)',
        'this.toResult(this.searchOffline(q, page), page, false)',
      ],
    ],
  ],
  [
    'm22 busca nao alimenta cache de itens',
    CAT,
    [['for (const item of value.items) this.itemCache.set(item.sourceId, item);', '']],
  ],
  [
    'm23 item offline nao serve de fallback',
    CAT,
    [
      [
        'const offline = this.offline.find((item) => item.sourceId === sourceId);',
        'const offline = undefined as ItemSnapshot | undefined;',
      ],
    ],
  ],
  [
    'm24 NotFound vira indisponivel',
    CAT,
    [['if (error instanceof NotFoundError) throw error;', '']],
  ],
  ['m25 licenca CC0 nao exigida', MAP, [["art.share_license_status !== 'CC0'", 'false']]],
  ['m26 host da imagem nao conferido', MAP, [['if (!hosts.has(url.hostname)) return null;', '']]],
  ['m27 http aceito', MAP, [["if (url.protocol !== 'https:') return null;", '']]],
  [
    'm28 credenciais na URL aceitas',
    MAP,
    [["if (url.username !== '' || url.password !== '') return null;", '']],
  ],
  ['m29 bidi nao removido', MAP, [['\\u202A-\\u202E\\u2066-\\u2069', '']]],
  ['m30 texto sem limite de tamanho', MAP, [['text.length > max ?', 'false ?']]],
  [
    'm31 itens invalidos nao descartados',
    MAP,
    [['return item === null ? [] : [item];', 'return [item as never];']],
  ],
  [
    'm32 envelope de busca nao validado',
    MAP,
    [
      [
        "if (!parsed.success) throw new UpstreamError('resposta de busca fora do formato', 'payload');",
        '',
      ],
    ],
  ],
];

const only = process.argv[2];
let survivors = 0;
let ran = 0;

for (const [name, file, pairs] of mutations) {
  if (only !== undefined && !name.startsWith(only)) continue;
  ran++;
  const original = readFileSync(file, 'utf8');
  let mutated = original;
  let applicable = true;
  for (const [from, to] of pairs) {
    if (!mutated.includes(from)) applicable = false;
    mutated = mutated.replace(from, to);
  }
  if (!applicable) {
    console.log(`SKIP       ${name}: trecho nao encontrado (atualize o script)`);
    survivors++;
    continue;
  }
  writeFileSync(file, mutated);
  try {
    const r = spawnSync('npx', ['vitest', 'run', 'test/catalog'], {
      cwd: API,
      shell: true,
      encoding: 'utf8',
    });
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
console.log(`\nSobreviventes: ${survivors} de ${ran}`);
process.exit(survivors === 0 ? 0 : 1);

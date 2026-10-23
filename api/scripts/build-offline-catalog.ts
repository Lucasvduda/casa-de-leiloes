/**
 * Gera `offline-catalog.data.ts`: um recorte (CC0, com imagem) do acervo do Cleveland Museum of Art
 * embutido no codigo. E o ultimo degrau do fallback quando a API externa cai.
 *
 * Usa o PROPRIO adaptador de producao (mesma validacao, mesmo filtro CC0, mesma limpeza de texto), e
 * se recusa a gravar se qualquer resposta vier degradada: dado de fallback nunca vem de fallback.
 *
 * Uso: npm run catalog:offline -w api
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClevelandCatalog } from '../src/adapters/outbound/catalog/cleveland-catalog.js';
import type { ItemSnapshot } from '../src/application/ports.js';

const TARGET = 60;
const OUTPUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../src/adapters/outbound/catalog/offline-catalog.data.ts',
);

// Variedade de proposito: o seed e a demonstracao usam termos comuns.
const QUERIES = [
  'monet',
  'landscape',
  'portrait',
  'still life',
  'impressionism',
  'rembrandt',
  'picasso',
  'sculpture',
  'japan',
  'flowers',
  'sea',
  'mask',
  'vase',
  'cat',
  'horse',
  'night',
];

const catalog = new ClevelandCatalog({ offlineItems: [], retries: 2, timeoutMs: 8_000 });
const collected = new Map<string, ItemSnapshot>();

for (const query of QUERIES) {
  if (collected.size >= TARGET) break;
  const result = await catalog.search(query, 1);
  if (result.degraded) {
    throw new Error(
      `Resposta degradada para "${query}": a API externa nao esta saudavel. Nada foi gravado.`,
    );
  }
  // Maximo de 4 por termo para o recorte nao virar so "monet".
  for (const item of result.items.slice(0, 4)) {
    if (collected.size < TARGET) collected.set(item.sourceId, item);
  }
  console.log(`${query.padEnd(14)} +${Math.min(4, result.items.length)} (total ${collected.size})`);
}

if (collected.size < 30) throw new Error(`Poucos itens (${collected.size}). Nada foi gravado.`);

const items = [...collected.values()];
const body = `import type { ItemSnapshot } from '../../../application/ports.js';

/** Gerado por \`npm run catalog:offline -w api\` em ${new Date().toISOString().slice(0, 10)}. Nao editar a mao. Fonte: Cleveland Museum of Art Open Access (CC0). */
export const OFFLINE_ITEMS: readonly ItemSnapshot[] = ${JSON.stringify(items, null, 2)};
`;
writeFileSync(OUTPUT, body, 'utf8');
console.log(`\n${items.length} itens gravados em ${OUTPUT}`);

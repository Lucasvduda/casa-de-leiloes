import type { LotListParams, LotSort, PhaseFilter } from '../../api/types';

/** Abas da vitrine. O id e o que aparece na URL (em portugues, para o link ser legivel). */
export const TABS = [
  { id: 'ao-vivo', phase: 'live', label: 'Ao vivo' },
  { id: 'agendados', phase: 'scheduled', label: 'Agendados' },
  { id: 'encerrados', phase: 'finished', label: 'Encerrados' },
] as const satisfies readonly { id: string; phase: PhaseFilter; label: string }[];

export type TabId = (typeof TABS)[number]['id'];

export const SORT_OPTIONS: readonly { value: LotSort; label: string }[] = [
  { value: 'ending', label: 'Terminam primeiro' },
  { value: 'newest', label: 'Mais recentes' },
  { value: 'price_asc', label: 'Menor preço' },
  { value: 'price_desc', label: 'Maior preço' },
];

export interface ListState {
  tab: TabId;
  q: string;
  sort: LotSort;
  page: number;
}

const SORTS = new Set<string>(SORT_OPTIONS.map((o) => o.value));
const MAX_QUERY_LENGTH = 100;
const MAX_PAGE = 10_000;

/** Ordenacao padrao: o que acaba antes aparece primeiro; encerrados, do mais novo para o mais antigo. */
export const defaultSort = (tab: TabId): LotSort => (tab === 'encerrados' ? 'newest' : 'ending');

/**
 * Le a URL com desconfianca: valor desconhecido, fora de faixa ou gigante cai no padrao
 * (nunca vira erro de tela nem consulta absurda).
 */
export function parseListState(params: URLSearchParams): ListState {
  const tabParam = params.get('fase');
  const tab: TabId = TABS.some((t) => t.id === tabParam) ? (tabParam as TabId) : 'ao-vivo';

  const sortParam = params.get('ordem');
  const sort: LotSort =
    sortParam !== null && SORTS.has(sortParam) ? (sortParam as LotSort) : defaultSort(tab);

  const q = (params.get('busca') ?? '').trim().slice(0, MAX_QUERY_LENGTH);

  const rawPage = Number(params.get('pagina'));
  const page = Number.isInteger(rawPage) && rawPage >= 1 && rawPage <= MAX_PAGE ? rawPage : 1;

  return { tab, q, sort, page };
}

/** Escreve so o que difere do padrao: URL curta e estavel. */
export function toSearchParams(state: ListState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.tab !== 'ao-vivo') params.set('fase', state.tab);
  if (state.q !== '') params.set('busca', state.q);
  if (state.sort !== defaultSort(state.tab)) params.set('ordem', state.sort);
  if (state.page > 1) params.set('pagina', String(state.page));
  return params;
}

export const PAGE_SIZE = 12;

export function toApiParams(state: ListState): LotListParams {
  const phase = TABS.find((t) => t.id === state.tab)?.phase ?? 'live';
  return {
    phase,
    q: state.q === '' ? undefined : state.q,
    sort: state.sort,
    page: state.page,
    pageSize: PAGE_SIZE,
  };
}

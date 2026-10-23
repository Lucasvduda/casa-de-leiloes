import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api/endpoints';
import { keys } from '../../app/query-keys';
import {
  Button,
  EmptyState,
  LoadError,
  PageHeader,
  Pagination,
  SelectField,
  Skeleton,
  cn,
} from '../../components/ui';
import { messageForError } from '../../lib/messages';
import { serverClock } from '../../lib/server-time';
import { useDocumentTitle } from '../../lib/use-document-title';
import { useSession } from '../auth/session';
import { LotCard } from './LotCard';
import {
  SORT_OPTIONS,
  TABS,
  defaultSort,
  parseListState,
  toApiParams,
  toSearchParams,
} from './list-params';
import type { ListState, TabId } from './list-params';
import type { LotSort } from '../../api/types';

const LIVE_REFRESH_MS = 15_000;

function SearchForm({ initial, onSubmit }: { initial: string; onSubmit: (q: string) => void }) {
  function handle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get('q');
    onSubmit(typeof value === 'string' ? value.trim() : '');
  }
  return (
    <form onSubmit={handle} role="search" className="flex gap-2">
      <div className="flex-1">
        <label htmlFor="busca" className="sr-only">
          Buscar lotes
        </label>
        <input
          id="busca"
          name="q"
          type="search"
          defaultValue={initial}
          maxLength={100}
          placeholder="Buscar por título (ex.: vaso, espada)"
          className="block min-h-11 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-base placeholder:text-stone-400 focus:border-amber-500 dark:border-stone-700 dark:bg-stone-900"
        />
      </div>
      <Button type="submit" variant="secondary">
        Buscar
      </Button>
    </form>
  );
}

function GridSkeleton() {
  return (
    <div
      className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
      role="status"
      aria-label="Carregando lotes"
    >
      {Array.from({ length: 8 }, (_, i) => (
        <Skeleton key={i} className="h-72" />
      ))}
    </div>
  );
}

export function HomePage() {
  useDocumentTitle('Vitrine');
  const { viewerKey } = useSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const state = parseListState(searchParams);
  const apiParams = toApiParams(state);

  function update(patch: Partial<ListState>) {
    // Mudar filtro volta para a pagina 1 (a pagina 7 de outra busca nao existe).
    const next: ListState = { ...state, page: 1, ...patch };
    setSearchParams(toSearchParams(next));
  }

  const query = useQuery({
    queryKey: keys.lots(viewerKey, apiParams),
    queryFn: async ({ signal }) => {
      const result = await api.listLots(apiParams, signal);
      serverClock.sync(result.serverNow);
      return result;
    },
    placeholderData: keepPreviousData,
    refetchInterval: state.tab === 'ao-vivo' ? LIVE_REFRESH_MS : false,
  });

  const filtered = state.q !== '';
  const data = query.data;

  return (
    <>
      <PageHeader
        title="Leilões"
        subtitle="Itens do acervo aberto do Cleveland Museum of Art. Entre, adicione saldo e dê seus lances."
      />

      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Fase do leilão">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            aria-pressed={state.tab === tab.id}
            onClick={() => update({ tab: tab.id as TabId, sort: defaultSort(tab.id) })}
            className={cn(
              'min-h-11 rounded-full px-4 text-sm font-medium transition-colors',
              state.tab === tab.id
                ? 'bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900'
                : 'bg-stone-200 text-stone-800 hover:bg-stone-300 dark:bg-stone-800 dark:text-stone-200 dark:hover:bg-stone-700',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-[1fr_14rem]">
        <SearchForm key={state.q} initial={state.q} onSubmit={(q) => update({ q })} />
        <SelectField
          label="Ordenar por"
          value={state.sort}
          onChange={(e) => update({ sort: e.target.value as LotSort })}
          className="[&>label]:sr-only"
        >
          {SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectField>
      </div>

      {query.isPending && <GridSkeleton />}

      {query.isError && !data && (
        <LoadError
          message={messageForError(query.error)}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      )}

      {data !== undefined && (
        <div aria-busy={query.isFetching && query.isPlaceholderData}>
          {data.items.length === 0 ? (
            <EmptyState
              title={
                data.page > 1
                  ? 'Esta página não existe'
                  : filtered
                    ? 'Nenhum lote encontrado'
                    : 'Nenhum lote por aqui ainda'
              }
              action={
                data.page > 1 || filtered ? (
                  <Button
                    variant="secondary"
                    onClick={() => setSearchParams(toSearchParams({ ...state, q: '', page: 1 }))}
                  >
                    {filtered ? 'Limpar busca' : 'Voltar à primeira página'}
                  </Button>
                ) : undefined
              }
            >
              {filtered
                ? 'Tente outro termo ou limpe a busca.'
                : state.tab === 'ao-vivo'
                  ? 'Não há leilões ao vivo agora. Veja os agendados.'
                  : 'Volte em breve.'}
            </EmptyState>
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {data.items.map((lot) => (
                <LotCard key={lot.id} lot={lot} />
              ))}
            </ul>
          )}

          {query.isError && (
            <p role="alert" className="mt-4 text-sm text-red-600 dark:text-red-400">
              Não foi possível atualizar a lista agora. {messageForError(query.error)}
            </p>
          )}

          <Pagination
            page={data.page}
            totalPages={data.totalPages}
            onChange={(page) => {
              setSearchParams(toSearchParams({ ...state, page }));
              window.scrollTo({ top: 0 });
            }}
          />
        </div>
      )}
    </>
  );
}

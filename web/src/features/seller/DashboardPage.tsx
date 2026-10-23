import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api/endpoints';
import type { PhaseFilter } from '../../api/types';
import { keys } from '../../app/query-keys';
import {
  ButtonLink,
  Card,
  EmptyState,
  LoadError,
  PageHeader,
  Pagination,
  SelectField,
  Skeleton,
} from '../../components/ui';
import { messageForError } from '../../lib/messages';
import { formatBRL } from '../../lib/money';
import { serverClock, useServerNow } from '../../lib/server-time';
import { useDocumentTitle } from '../../lib/use-document-title';
import { useSession } from '../auth/session';
import { CancelLotButton } from '../lots/CancelLotButton';
import { LotRow } from '../lots/LotRow';
import { phaseAt } from '../lots/room-state';
import type { LotSummary } from '../../api/types';

const PAGE_SIZE = 10;

const FILTERS: { value: PhaseFilter; label: string }[] = [
  { value: 'all', label: 'Todos os lotes' },
  { value: 'live', label: 'Ao vivo' },
  { value: 'scheduled', label: 'Agendados' },
  { value: 'finished', label: 'Encerrados' },
  { value: 'cancelled', label: 'Cancelados' },
];
const FILTER_VALUES = new Set<string>(FILTERS.map((f) => f.value));

function RowActions({ lot }: { lot: LotSummary }) {
  const now = useServerNow();
  const phase = phaseAt(lot, now);
  // Encerrando ('ended') ainda pode ser cancelado ate o servidor liquidar; o servidor decide.
  const cancellable = lot.status === 'open' && phase !== 'closed' && phase !== 'cancelled';
  return (
    <>
      <Link
        to={`/auditoria/${lot.id}`}
        className="inline-flex min-h-11 items-center rounded-lg border border-stone-300 px-3 text-sm font-medium hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800"
      >
        Auditoria
      </Link>
      {cancellable && <CancelLotButton lotId={lot.id} title={lot.title} bidCount={lot.bidCount} />}
    </>
  );
}

export function DashboardPage() {
  useDocumentTitle('Painel do leiloeiro');
  const { viewerKey } = useSession();
  const [searchParams, setSearchParams] = useSearchParams();

  const rawFilter = searchParams.get('fase') ?? 'all';
  const phase = (FILTER_VALUES.has(rawFilter) ? rawFilter : 'all') as PhaseFilter;
  const rawPage = Number(searchParams.get('pagina'));
  const page = Number.isInteger(rawPage) && rawPage >= 1 && rawPage <= 10_000 ? rawPage : 1;
  const params = { phase, page, pageSize: PAGE_SIZE };

  const query = useQuery({
    queryKey: keys.myLots(viewerKey, params),
    queryFn: async ({ signal }) => {
      const result = await api.myLots(params, signal);
      serverClock.sync(result.serverNow);
      return result;
    },
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
  const data = query.data;

  function go(next: { phase?: PhaseFilter; page?: number }) {
    const nextPhase = next.phase ?? phase;
    const nextPage = next.page ?? 1;
    const out = new URLSearchParams();
    if (nextPhase !== 'all') out.set('fase', nextPhase);
    if (nextPage > 1) out.set('pagina', String(nextPage));
    setSearchParams(out);
  }

  return (
    <>
      <PageHeader
        title="Painel do leiloeiro"
        subtitle="Seus lotes, o resultado de cada um e o total recebido."
        actions={<ButtonLink to="/painel/novo">Novo lote</ButtonLink>}
      />

      {data !== undefined && (
        <div className="mb-6 grid gap-4 sm:grid-cols-2">
          <Card>
            <p className="text-xs text-stone-500 dark:text-stone-400">Total recebido</p>
            <p className="tabular mt-1 text-2xl font-bold">{formatBRL(data.totals.received)}</p>
          </Card>
          <Card>
            <p className="text-xs text-stone-500 dark:text-stone-400">Lotes vendidos</p>
            <p className="tabular mt-1 text-2xl font-bold">{data.totals.soldCount}</p>
          </Card>
        </div>
      )}

      <div className="mb-4 max-w-xs">
        <SelectField
          label="Mostrar"
          value={phase}
          onChange={(e) => go({ phase: e.target.value as PhaseFilter })}
        >
          {FILTERS.map((filter) => (
            <option key={filter.value} value={filter.value}>
              {filter.label}
            </option>
          ))}
        </SelectField>
      </div>

      {query.isPending && (
        <div className="space-y-3" role="status" aria-label="Carregando lotes">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      )}

      {query.isError && data === undefined && (
        <LoadError
          message={messageForError(query.error)}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      )}

      {data !== undefined &&
        (data.items.length === 0 ? (
          <EmptyState
            title={phase === 'all' ? 'Você ainda não criou lotes' : 'Nenhum lote nesta situação'}
            action={
              phase === 'all' ? (
                <ButtonLink to="/painel/novo">Criar o primeiro lote</ButtonLink>
              ) : undefined
            }
          >
            {phase === 'all'
              ? 'Escolha um item do catálogo do museu e abra o leilão.'
              : 'Mude o filtro para ver outros lotes.'}
          </EmptyState>
        ) : (
          <ul className="space-y-3">
            {data.items.map((lot) => (
              <LotRow key={lot.id} lot={lot} actions={<RowActions lot={lot} />} />
            ))}
          </ul>
        ))}

      {data !== undefined && (
        <Pagination
          page={data.page}
          totalPages={data.totalPages}
          onChange={(next) => go({ page: next })}
        />
      )}
    </>
  );
}

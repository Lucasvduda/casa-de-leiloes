import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api/endpoints';
import type { LotSummary } from '../../api/types';
import { keys } from '../../app/query-keys';
import {
  Badge,
  EmptyState,
  LoadError,
  PageHeader,
  Pagination,
  Skeleton,
  cn,
} from '../../components/ui';
import { messageForError } from '../../lib/messages';
import { serverClock, useServerNow } from '../../lib/server-time';
import { useDocumentTitle } from '../../lib/use-document-title';
import { useSession } from '../auth/session';
import { LotRow } from '../lots/LotRow';
import { phaseAt } from '../lots/room-state';

const PAGE_SIZE = 10;
const TABS = [
  { id: 'lances', label: 'Meus lances' },
  { id: 'arrematados', label: 'Arrematados' },
] as const;

type TabId = (typeof TABS)[number]['id'];

/** Situacao da pessoa naquele lote, so com o que a listagem sabe (lider ou nao, fase, comprovante). */
export function bidOutcome(
  lot: Pick<LotSummary, 'status' | 'startsAt' | 'endsAt' | 'viewer'>,
  nowMs: number,
): { label: string; tone: 'success' | 'warning' | 'neutral' | 'danger' } {
  const phase = phaseAt(lot, nowMs);
  const leading = lot.viewer?.isLeading === true;
  if (phase === 'cancelled') return { label: 'Cancelado, valor devolvido', tone: 'danger' };
  if (phase === 'closed') {
    return leading
      ? { label: 'Você arrematou', tone: 'success' }
      : { label: 'Não arrematado', tone: 'neutral' };
  }
  return leading
    ? { label: 'Você lidera', tone: 'success' }
    : { label: 'Você foi superado', tone: 'warning' };
}

function OutcomeBadge({ lot }: { lot: LotSummary }) {
  const now = useServerNow();
  const outcome = bidOutcome(lot, now);
  return <Badge tone={outcome.tone}>{outcome.label}</Badge>;
}

export function MyBidsPage() {
  useDocumentTitle('Meus lances');
  const { viewerKey } = useSession();
  const [searchParams, setSearchParams] = useSearchParams();

  const tab: TabId = searchParams.get('aba') === 'arrematados' ? 'arrematados' : 'lances';
  const rawPage = Number(searchParams.get('pagina'));
  const page = Number.isInteger(rawPage) && rawPage >= 1 && rawPage <= 10_000 ? rawPage : 1;
  const params = { page, pageSize: PAGE_SIZE };

  const query = useQuery({
    queryKey: tab === 'lances' ? keys.myBids(viewerKey, params) : keys.myWins(viewerKey, params),
    queryFn: async ({ signal }) => {
      const result = await (tab === 'lances'
        ? api.myBids(params, signal)
        : api.myWins(params, signal));
      serverClock.sync(result.serverNow);
      return result;
    },
    placeholderData: keepPreviousData,
    refetchInterval: tab === 'lances' ? 15_000 : false,
  });
  const data = query.data;

  function goTo(next: { tab?: TabId; page?: number }) {
    const params = new URLSearchParams();
    const nextTab = next.tab ?? tab;
    const nextPage = next.page ?? 1;
    if (nextTab === 'arrematados') params.set('aba', 'arrematados');
    if (nextPage > 1) params.set('pagina', String(nextPage));
    setSearchParams(params);
  }

  return (
    <>
      <PageHeader
        title="Meus lances"
        subtitle="Acompanhe onde você está liderando e o que já arrematou."
      />

      <div className="mb-4 flex gap-2" role="group" aria-label="Seção">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={tab === item.id}
            onClick={() => goTo({ tab: item.id })}
            className={cn(
              'min-h-11 rounded-full px-4 text-sm font-medium',
              tab === item.id
                ? 'bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900'
                : 'bg-stone-200 text-stone-800 hover:bg-stone-300 dark:bg-stone-800 dark:text-stone-200 dark:hover:bg-stone-700',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      {query.isPending && (
        <div className="space-y-3" role="status" aria-label="Carregando">
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
            title={tab === 'lances' ? 'Você ainda não deu nenhum lance' : 'Nenhum arremate ainda'}
            action={
              <Link
                to="/"
                className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-stone-950 hover:bg-amber-400"
              >
                Ver leilões ao vivo
              </Link>
            }
          >
            {tab === 'lances'
              ? 'Quando você der um lance, o lote aparece aqui.'
              : 'Os lotes que você ganhar aparecem aqui, com o comprovante.'}
          </EmptyState>
        ) : (
          <ul className="space-y-3">
            {data.items.map((lot) => (
              <LotRow
                key={lot.id}
                lot={lot}
                status={<OutcomeBadge lot={lot} />}
                actions={
                  lot.receiptCode !== null && lot.viewer?.isLeading === true ? (
                    <Link
                      to={`/comprovantes/${lot.receiptCode}`}
                      className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-medium hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800"
                    >
                      Comprovante
                    </Link>
                  ) : undefined
                }
              />
            ))}
          </ul>
        ))}

      {data !== undefined && (
        <Pagination
          page={data.page}
          totalPages={data.totalPages}
          onChange={(next) => goTo({ page: next })}
        />
      )}
    </>
  );
}

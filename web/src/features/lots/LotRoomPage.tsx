import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../api/endpoints';
import { isApiError } from '../../api/errors';
import type { BidAccepted, BidEventPayload, LotDetail } from '../../api/types';
import { invalidateLotLists, invalidateMoney, keys } from '../../app/query-keys';
import { useToast } from '../../components/toast';
import {
  Alert,
  Badge,
  ButtonLink,
  Card,
  EmptyState,
  LoadError,
  Skeleton,
  cn,
} from '../../components/ui';
import { formatDateTimeSeconds, formatTime, safeHttpUrl } from '../../lib/format';
import { messageForError } from '../../lib/messages';
import { formatBRL } from '../../lib/money';
import { serverClock, useServerNow } from '../../lib/server-time';
import { useDocumentTitle } from '../../lib/use-document-title';
import { useSession } from '../auth/session';
import { BidPanel } from './BidPanel';
import { Countdown, ItemImage, PhaseBadge } from './LotParts';
import { applyBid, bidAcceptedToEvent, hasGap, mergeLot, phaseAt } from './room-state';
import { useLotStream } from './use-lot-stream';
import type { StreamHandlers, StreamStatus } from './use-lot-stream';

const SETTLE_POLL_MS = 2_500;
const SETTLE_GRACE_MS = 300;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

function ConnectionBadge({ status }: { status: StreamStatus }) {
  if (status === 'off') return null;
  if (status === 'live') return <Badge tone="success">Tempo real ativo</Badge>;
  return <Badge tone="warning">{status === 'connecting' ? 'Conectando…' : 'Reconectando…'}</Badge>;
}

function ResultBlock({ lot }: { lot: LotDetail }) {
  const result = lot.result;
  if (result === null) return null;
  if (result.outcome === 'cancelled') {
    return (
      <Alert tone="danger" title="Leilão cancelado pelo leiloeiro">
        Nenhum item foi vendido e qualquer valor reservado foi devolvido.
      </Alert>
    );
  }
  if (result.outcome === 'no_winner') {
    return <Alert tone="info" title="Encerrado sem lances" />;
  }
  const iWon = lot.viewerDetail !== null && lot.viewerDetail.ref === result.winner;
  return (
    <Alert
      tone={iWon ? 'success' : 'info'}
      title={iWon ? 'Parabéns, você arrematou este lote!' : 'Lote arrematado'}
    >
      <p>
        Arrematado por <strong className="tabular">{formatBRL(result.amount)}</strong>
        {iWon ? '.' : ` por ${result.winner}.`}
      </p>
      <p className="mt-2">
        <Link to={`/comprovantes/${result.receiptCode}`} className="font-semibold underline">
          Ver comprovante
        </Link>
      </p>
    </Alert>
  );
}

function BidHistory({ lot }: { lot: LotDetail }) {
  if (lot.bids.length === 0) {
    return (
      <p className="text-sm text-stone-600 dark:text-stone-400">
        Ainda não há lances. Seja o primeiro!
      </p>
    );
  }
  return (
    <ol
      className="divide-y divide-stone-200 dark:divide-stone-800"
      aria-label="Histórico de lances"
    >
      {lot.bids.map((bid, index) => (
        // A chave e o numero do lance: so o lance NOVO entra na tela e dispara o destaque.
        <li
          key={bid.seq}
          className={cn(
            'flex items-center justify-between gap-3 py-2 text-sm',
            index === 0 && 'bid-flash',
          )}
        >
          <span className="min-w-0 truncate">
            <span className="font-medium">{bid.mine ? 'Você' : bid.bidder}</span>
            {index === 0 && (
              <span className="ml-2 text-xs text-emerald-700 dark:text-emerald-400">
                maior lance
              </span>
            )}
            <span className="block text-xs text-stone-500 dark:text-stone-400">
              #{bid.seq} · {formatTime(bid.placedAt)}
            </span>
          </span>
          <span className="tabular font-semibold">{formatBRL(bid.amount)}</span>
        </li>
      ))}
    </ol>
  );
}

function RoomSkeleton() {
  return (
    <div className="grid gap-6 lg:grid-cols-2" role="status" aria-label="Carregando leilão">
      <Skeleton className="aspect-square w-full" />
      <div className="space-y-4">
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    </div>
  );
}

export function LotRoomPage() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { viewerKey } = useSession();
  const queryKey = useMemo(() => keys.lot(viewerKey, id), [viewerKey, id]);
  const now = useServerNow();

  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const fresh = await api.getLot(id, signal);
      serverClock.sync(fresh.serverNow);
      // Resposta atrasada nao desfaz o que o tempo real ja mostrou.
      return mergeLot(queryClient.getQueryData<LotDetail>(queryKey), fresh);
    },
    // Passou do fim e o servidor ainda nao liquidou: pergunta ate sair o resultado.
    refetchInterval: (q) => {
      const lot = q.state.data;
      if (lot === undefined || lot.status !== 'open') return false;
      return Date.parse(lot.endsAt) <= serverClock.now() ? SETTLE_POLL_MS : false;
    },
  });
  const lot = query.data;
  useDocumentTitle(lot?.title);

  // Confere o resultado logo depois do fim (inclusive quando o fim foi estendido por anti-sniping).
  const endsAt = lot?.endsAt;
  const status = lot?.status;
  const refetch = query.refetch;
  useEffect(() => {
    if (endsAt === undefined || status !== 'open') return;
    const wait = Date.parse(endsAt) - serverClock.now() + SETTLE_GRACE_MS;
    if (wait <= 0) return;
    const timer = setTimeout(() => void refetch(), Math.min(wait, MAX_TIMEOUT_MS));
    return () => clearTimeout(timer);
  }, [endsAt, status, refetch]);

  const handlers: StreamHandlers = {
    onSnapshot: (snapshot) => {
      queryClient.setQueryData<LotDetail>(queryKey, (old) => mergeLot(old, snapshot));
    },
    onBid: (event: BidEventPayload) => {
      const current = queryClient.getQueryData<LotDetail>(queryKey);
      if (current !== undefined && hasGap(current, event)) {
        // Perdemos algum lance no caminho: busca a lista completa.
        void queryClient.invalidateQueries({ queryKey });
      }
      queryClient.setQueryData<LotDetail>(queryKey, (old) =>
        old === undefined ? old : applyBid(old, event),
      );
      if (event.outbid) {
        toast.push('warning', `Você foi superado! Novo lance: ${formatBRL(event.amount)}.`);
      }
      if (event.mine || event.outbid) invalidateMoney(queryClient);
    },
    onFinished: () => {
      void queryClient.invalidateQueries({ queryKey });
      invalidateMoney(queryClient);
      invalidateLotLists(queryClient);
    },
    onServerTime: (iso) => serverClock.sync(iso),
    onGiveUp: () => void refetch(),
  };

  const stream = useLotStream({
    lotId: id,
    enabled: lot !== undefined && lot.status === 'open',
    viewerKey,
    handlers,
  });

  function onBidAccepted(accepted: BidAccepted) {
    serverClock.sync(accepted.bid.placedAt);
    queryClient.setQueryData<LotDetail>(queryKey, (old) =>
      old === undefined ? old : applyBid(old, bidAcceptedToEvent(old, accepted)),
    );
    invalidateMoney(queryClient);
    invalidateLotLists(queryClient);
  }

  if (query.isPending) return <RoomSkeleton />;

  if (lot === undefined) {
    if (isApiError(query.error) && query.error.status === 404) {
      return (
        <EmptyState
          title="Lote não encontrado"
          action={<ButtonLink to="/">Voltar à vitrine</ButtonLink>}
        >
          O link pode estar incorreto ou o lote não existe mais.
        </EmptyState>
      );
    }
    return (
      <LoadError
        message={messageForError(query.error)}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }

  const phase = phaseAt(lot, now);
  const hasBids = lot.currentAmount !== null;
  const attributes = Object.entries(lot.item.attributes);
  const sourceUrl = safeHttpUrl(lot.item.sourceUrl);
  const lastBid = lot.bids[0];

  return (
    <article>
      <p className="mb-4 text-sm">
        <Link to="/" className="underline">
          ← Voltar à vitrine
        </Link>
      </p>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <ItemImage
            src={lot.imageUrl}
            alt={lot.title}
            eager
            className="aspect-square w-full rounded-xl object-contain"
          />
          {attributes.length > 0 && (
            <Card as="section">
              <h2 className="mb-2 font-semibold">Sobre o item</h2>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                {attributes.map(([name, value]) => (
                  <div key={name} className="contents">
                    <dt className="font-medium text-stone-600 dark:text-stone-400">{name}</dt>
                    <dd className="break-words">{value}</dd>
                  </div>
                ))}
              </dl>
              {sourceUrl !== null && (
                <p className="mt-3 text-xs">
                  <a
                    href={sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    Ver no acervo do museu (abre em nova aba)
                  </a>
                </p>
              )}
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <header>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <PhaseBadge phase={phase} />
              <ConnectionBadge status={stream} />
              {lot.viewer?.isLeading === true && phase === 'live' && (
                <Badge tone="success">Você está liderando</Badge>
              )}
            </div>
            <h1 className="font-serif text-2xl font-bold leading-tight sm:text-3xl">{lot.title}</h1>
            <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">por {lot.sellerName}</p>
          </header>

          <Card as="section" className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-stone-500 dark:text-stone-400">
                {phase === 'closed' && hasBids
                  ? 'Arrematado por'
                  : hasBids
                    ? 'Lance atual'
                    : 'Lance inicial'}
              </p>
              <p className="tabular text-3xl font-bold" data-testid="current-amount">
                {formatBRL(lot.currentAmount ?? lot.startingBid)}
              </p>
              <p className="tabular text-xs text-stone-500 dark:text-stone-400">
                {lot.bidCount} {lot.bidCount === 1 ? 'lance' : 'lances'}
              </p>
            </div>
            <div className="text-right">
              {phase === 'live' && (
                <>
                  <p className="text-xs text-stone-500 dark:text-stone-400">Termina em</p>
                  <p className="text-3xl">
                    <Countdown target={lot.endsAt} />
                  </p>
                </>
              )}
              {phase === 'scheduled' && (
                <>
                  <p className="text-xs text-stone-500 dark:text-stone-400">Começa em</p>
                  <p className="text-3xl">
                    <Countdown target={lot.startsAt} />
                  </p>
                </>
              )}
              {phase !== 'live' && phase !== 'scheduled' && (
                <>
                  <p className="text-xs text-stone-500 dark:text-stone-400">Encerrou em</p>
                  <p className="text-sm font-semibold">{formatDateTimeSeconds(lot.endsAt)}</p>
                </>
              )}
              <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                Incremento mínimo: {formatBRL(lot.minIncrement)}
              </p>
            </div>
          </Card>

          <ResultBlock lot={lot} />
          <BidPanel lot={lot} phase={phase} onAccepted={onBidAccepted} />

          <Card as="section">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="font-semibold">Lances</h2>
              <Link to={`/auditoria/${lot.id}`} className="text-xs underline">
                Auditar histórico
              </Link>
            </div>
            <BidHistory lot={lot} />
            {lot.bidCount > lot.bids.length && (
              <p className="mt-2 text-xs text-stone-500 dark:text-stone-400">
                Mostrando os {lot.bids.length} mais recentes. O histórico completo está na{' '}
                <Link to={`/auditoria/${lot.id}`} className="underline">
                  auditoria
                </Link>
                .
              </p>
            )}
          </Card>
        </div>
      </div>

      {/* Anuncia o lance novo para leitor de tela sem repetir a lista inteira. */}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {lastBid === undefined
          ? ''
          : `Último lance: ${formatBRL(lastBid.amount)}. Total de ${lot.bidCount} lances.`}
      </p>
    </article>
  );
}

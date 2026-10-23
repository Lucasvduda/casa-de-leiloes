import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api/endpoints';
import { isApiError, isNetworkError } from '../../api/errors';
import type { ItemSnapshot } from '../../api/types';
import { invalidateLotLists, keys } from '../../app/query-keys';
import { useToast } from '../../components/toast';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  LoadError,
  PageHeader,
  Pagination,
  SelectField,
  Skeleton,
  TextField,
  cn,
} from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import { fieldErrors, messageForError } from '../../lib/messages';
import { MAX_WALLET_BALANCE_CENTS, formatBRL, parseBRLToCents } from '../../lib/money';
import { serverClock } from '../../lib/server-time';
import { useDocumentTitle } from '../../lib/use-document-title';
import { ItemImage } from '../lots/LotParts';
import { DURATIONS, computeWindow, toLocalInputValue } from './lot-window';
import type { DurationId, StartMode } from './lot-window';

function checkMoney(
  text: string,
  label: string,
): { cents: number | null; error: string | undefined } {
  const cents = parseBRLToCents(text);
  if (cents === null) return { cents: null, error: `Informe o ${label} (ex.: 150,00).` };
  if (cents > MAX_WALLET_BALANCE_CENTS) return { cents, error: 'Valor acima do máximo permitido.' };
  return { cents, error: undefined };
}

function CatalogPicker({ onPick }: { onPick: (item: ItemSnapshot) => void }) {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);

  const query = useQuery({
    queryKey: keys.catalog(q, page),
    queryFn: ({ signal }) => api.catalogSearch(q, page, signal),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const data = query.data;
  const totalPages = data === undefined ? 1 : Math.max(1, Math.ceil(data.total / data.pageSize));

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get('q');
    setQ(typeof value === 'string' ? value.trim() : '');
    setPage(1);
  }

  return (
    <section aria-labelledby="passo1">
      <h2 id="passo1" className="mb-3 font-semibold">
        1. Escolha o item do catálogo
      </h2>
      <form onSubmit={search} role="search" className="mb-4 flex gap-2">
        <div className="flex-1">
          <label htmlFor="catalogo-busca" className="sr-only">
            Buscar no catálogo
          </label>
          <input
            id="catalogo-busca"
            name="q"
            type="search"
            maxLength={100}
            placeholder="Buscar no acervo (ex.: vaso, espada, retrato)"
            className="block min-h-11 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-base focus:border-amber-500 dark:border-stone-700 dark:bg-stone-900"
          />
        </div>
        <Button type="submit" variant="secondary">
          Buscar
        </Button>
      </form>

      {data?.degraded === true && (
        <Alert tone="warning" title="Catálogo em modo reserva" className="mb-4">
          O acervo do museu não respondeu agora. Você está vendo uma cópia salva, com menos itens.
        </Alert>
      )}

      {query.isPending && (
        <div
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
          role="status"
          aria-label="Carregando catálogo"
        >
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-56" />
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
          <EmptyState title="Nenhum item encontrado">Tente outro termo de busca.</EmptyState>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.items.map((item) => (
              <li key={item.sourceId} className="list-none">
                <button
                  type="button"
                  onClick={() => onPick(item)}
                  className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-stone-200 bg-white text-left shadow-sm transition hover:border-amber-500 hover:shadow-md dark:border-stone-800 dark:bg-stone-900"
                >
                  <ItemImage src={item.imageUrl} alt="" className="aspect-[4/3] w-full" />
                  <span className="p-3">
                    <span className="line-clamp-2 block font-serif font-semibold leading-snug">
                      {item.title}
                    </span>
                    <span className="mt-1 block text-xs text-stone-500 dark:text-stone-400">
                      Selecionar este item
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ))}

      {data !== undefined && <Pagination page={page} totalPages={totalPages} onChange={setPage} />}
    </section>
  );
}

function LotForm({
  item,
  onChangeItem,
  onItemGone,
}: {
  item: ItemSnapshot;
  onChangeItem: () => void;
  onItemGone: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [startingText, setStartingText] = useState('100,00');
  const [incrementText, setIncrementText] = useState('10,00');
  const [startMode, setStartMode] = useState<StartMode>('now');
  const [startLocal, setStartLocal] = useState(() =>
    toLocalInputValue(serverClock.now() + 60 * 60_000),
  );
  const [duration, setDuration] = useState<DurationId>('24h');
  const [endLocal, setEndLocal] = useState(() =>
    toLocalInputValue(serverClock.now() + 24 * 60 * 60_000),
  );
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [serverFields, setServerFields] = useState<Record<string, string>>({});
  const inFlight = useRef(false);

  const starting = checkMoney(startingText, 'lance inicial');
  const increment = checkMoney(incrementText, 'incremento mínimo');
  const period = computeWindow({
    startMode,
    startLocal,
    duration,
    endLocal,
    nowMs: serverClock.now(),
  });
  const hasErrors =
    starting.error !== undefined ||
    increment.error !== undefined ||
    period.errors.start !== undefined ||
    period.errors.end !== undefined;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    setSubmitted(true);
    setFormError(null);
    setServerFields({});
    // Recalcula com a hora do servidor NESTE instante ("comecar agora" nao pode usar a hora da tela).
    const fresh = computeWindow({
      startMode,
      startLocal,
      duration,
      endLocal,
      nowMs: serverClock.now(),
    });
    if (starting.cents === null || increment.cents === null || hasErrors) return;
    if (fresh.startsAt === null || fresh.endsAt === null) return;

    inFlight.current = true;
    setPending(true);
    try {
      const lot = await api.createLot({
        sourceId: item.sourceId,
        startingBid: starting.cents,
        minIncrement: increment.cents,
        startsAt: fresh.startsAt,
        endsAt: fresh.endsAt,
      });
      invalidateLotLists(queryClient);
      toast.push('success', 'Lote criado.');
      navigate(`/lotes/${lot.id}`);
    } catch (error) {
      if (isApiError(error) && error.code === 'ITEM_NOT_FOUND') {
        toast.push('error', messageForError(error));
        onItemGone();
        return;
      }
      const fields = fieldErrors(error);
      setServerFields(fields);
      if (Object.keys(fields).length === 0) {
        setFormError(
          isNetworkError(error)
            ? `${messageForError(error)} Antes de tentar de novo, confira no painel se o lote não foi criado.`
            : messageForError(error),
        );
      }
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  const show = (message: string | undefined, key?: string): string | undefined =>
    submitted
      ? (message ?? (key !== undefined ? serverFields[key] : undefined))
      : key !== undefined
        ? serverFields[key]
        : undefined;

  return (
    <section aria-labelledby="passo2">
      <h2 id="passo2" className="mb-3 font-semibold">
        2. Defina as condições do leilão
      </h2>
      <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
        <Card>
          <ItemImage
            src={item.imageUrl}
            alt={item.title}
            className="aspect-square w-full rounded-lg object-contain"
          />
          <p className="mt-3 font-serif font-semibold leading-snug">{item.title}</p>
          <Button variant="secondary" className="mt-3 w-full" onClick={onChangeItem}>
            Escolher outro item
          </Button>
        </Card>

        <Card>
          <form onSubmit={(e) => void submit(e)} noValidate className="space-y-5">
            {formError !== null && <Alert tone="danger">{formError}</Alert>}

            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="Lance inicial (R$)"
                name="startingBid"
                inputMode="decimal"
                autoComplete="off"
                value={startingText}
                onChange={(e) => setStartingText(e.target.value)}
                error={show(starting.error, 'startingBid')}
                hint="O primeiro lance precisa ser pelo menos este valor."
              />
              <TextField
                label="Incremento mínimo (R$)"
                name="minIncrement"
                inputMode="decimal"
                autoComplete="off"
                value={incrementText}
                onChange={(e) => setIncrementText(e.target.value)}
                error={show(increment.error, 'minIncrement')}
                hint="Quanto cada lance novo precisa passar do atual."
              />
            </div>

            <fieldset>
              <legend className="mb-2 text-sm font-medium">Início</legend>
              <div className="flex flex-wrap gap-4">
                {(
                  [
                    ['now', 'Começar agora'],
                    ['schedule', 'Agendar'],
                  ] as const
                ).map(([value, label]) => (
                  <label key={value} className="flex min-h-11 items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="startMode"
                      checked={startMode === value}
                      onChange={() => setStartMode(value)}
                      className="size-4"
                    />
                    {label}
                  </label>
                ))}
              </div>
              {startMode === 'schedule' && (
                <TextField
                  className="mt-2 max-w-xs"
                  label="Data e hora de início"
                  type="datetime-local"
                  name="startsAt"
                  value={startLocal}
                  onChange={(e) => setStartLocal(e.target.value)}
                  error={show(period.errors.start, 'startsAt')}
                />
              )}
            </fieldset>

            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                label="Duração"
                value={duration}
                onChange={(e) => setDuration(e.target.value as DurationId)}
              >
                {DURATIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </SelectField>
              {duration === 'custom' && (
                <TextField
                  label="Data e hora de término"
                  type="datetime-local"
                  name="endsAt"
                  value={endLocal}
                  onChange={(e) => setEndLocal(e.target.value)}
                  error={show(period.errors.end, 'endsAt')}
                />
              )}
            </div>
            {duration !== 'custom' && show(period.errors.end, 'endsAt') !== undefined && (
              <p role="alert" className="text-sm font-medium text-red-600 dark:text-red-400">
                {show(period.errors.end, 'endsAt')}
              </p>
            )}

            {period.startsAt !== null && period.endsAt !== null && (
              <p className="rounded-lg bg-stone-100 px-3 py-2 text-sm dark:bg-stone-800">
                Começa em <strong>{formatDateTime(period.startsAt)}</strong> e termina em{' '}
                <strong>{formatDateTime(period.endsAt)}</strong>.
                {starting.cents !== null && (
                  <>
                    {' '}
                    Primeiro lance a partir de{' '}
                    <strong className="tabular">{formatBRL(starting.cents)}</strong>.
                  </>
                )}
              </p>
            )}
            <p className="text-xs text-stone-600 dark:text-stone-400">
              Lances nos últimos 2 minutos estendem o prazo em 2 minutos (anti-sniping). Depois que
              o primeiro lance entra, o lote só pode ser cancelado, com devolução do valor ao líder.
            </p>

            <Button type="submit" loading={pending}>
              Criar lote
            </Button>
          </form>
        </Card>
      </div>
    </section>
  );
}

export function NewLotPage() {
  useDocumentTitle('Novo lote');
  const [item, setItem] = useState<ItemSnapshot | null>(null);

  return (
    <>
      <PageHeader
        title="Novo lote"
        subtitle="Os dados do item vêm do acervo do museu e não podem ser alterados."
        actions={
          <Link to="/painel" className="text-sm underline">
            ← Voltar ao painel
          </Link>
        }
      />
      <div className={cn('space-y-6')}>
        {item === null ? (
          <CatalogPicker onPick={setItem} />
        ) : (
          <LotForm
            item={item}
            onChangeItem={() => setItem(null)}
            onItemGone={() => setItem(null)}
          />
        )}
      </div>
    </>
  );
}

import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../../api/endpoints';
import type { LedgerEntry, LedgerKind } from '../../api/types';
import { invalidateMoney, keys } from '../../app/query-keys';
import { useToast } from '../../components/toast';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  LoadError,
  PageHeader,
  Skeleton,
  TextField,
} from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import { IntentKey } from '../../lib/idempotency';
import { messageForError } from '../../lib/messages';
import {
  MAX_SINGLE_DEPOSIT_CENTS,
  MAX_WALLET_BALANCE_CENTS,
  formatBRL,
  parseBRLToCents,
} from '../../lib/money';
import { useDocumentTitle } from '../../lib/use-document-title';
import { isRetryable } from '../../api/errors';
import { useSession } from '../auth/session';

const QUICK_AMOUNTS = [100_00, 500_00, 1_000_00, 5_000_00];

/** O que cada movimento significa para quem le o extrato (e como mexe no saldo DISPONIVEL). */
const LEDGER_TEXT: Record<LedgerKind, { label: string; effect: 'plus' | 'minus' }> = {
  deposit: { label: 'Depósito', effect: 'plus' },
  hold: { label: 'Valor reservado para um lance', effect: 'minus' },
  release: { label: 'Reserva devolvida (lance superado ou lote cancelado)', effect: 'plus' },
  settle_debit: { label: 'Arremate pago', effect: 'minus' },
  settle_credit: { label: 'Venda recebida', effect: 'plus' },
};

/** Valida o deposito antes de enviar (o servidor valida de novo). */
export function checkDeposit(
  text: string,
  currentTotal: number,
): { amount: number | null; error: string | undefined } {
  const amount = parseBRLToCents(text);
  if (amount === null)
    return { amount: null, error: 'Informe um valor válido, por exemplo 500,00.' };
  if (amount > MAX_SINGLE_DEPOSIT_CENTS) {
    return { amount, error: `O limite por depósito é ${formatBRL(MAX_SINGLE_DEPOSIT_CENTS)}.` };
  }
  if (currentTotal + amount > MAX_WALLET_BALANCE_CENTS) {
    return {
      amount,
      error: `O saldo da carteira não pode passar de ${formatBRL(MAX_WALLET_BALANCE_CENTS)}.`,
    };
  }
  return { amount, error: undefined };
}

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <Card>
      <p className="text-xs text-stone-500 dark:text-stone-400">{label}</p>
      <p className="tabular mt-1 text-2xl font-bold">{formatBRL(value)}</p>
      {hint !== undefined && (
        <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">{hint}</p>
      )}
    </Card>
  );
}

function DepositForm({ currentTotal }: { currentTotal: number }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState('');
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intent = useRef(new IntentKey('dep'));
  const inFlight = useRef(false);

  const check = checkDeposit(text, currentTotal);
  const fieldError = touched && text.trim() !== '' ? check.error : undefined;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    setTouched(true);
    setError(null);
    if (check.error !== undefined || check.amount === null) return;

    const amount = check.amount;
    inFlight.current = true;
    setPending(true);
    try {
      const result = await api.deposit(amount, intent.current.keyFor(`dep:${amount}`));
      intent.current.release();
      setText('');
      setTouched(false);
      invalidateMoney(queryClient);
      toast.push(
        'success',
        result.replayed
          ? 'Este depósito já tinha sido registrado.'
          : `Depósito de ${formatBRL(amount)} registrado.`,
      );
    } catch (err) {
      if (isRetryable(err)) {
        setError(
          `${messageForError(err)} Se o depósito já tiver sido registrado, enviar de novo não o duplica.`,
        );
      } else {
        intent.current.release();
        setError(messageForError(err));
      }
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <Card as="section">
      <h2 className="font-semibold">Adicionar saldo</h2>
      <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
        Depósito simulado: nenhum dinheiro real é cobrado. Limite de{' '}
        {formatBRL(MAX_SINGLE_DEPOSIT_CENTS)} por depósito.
      </p>
      <form onSubmit={(e) => void submit(e)} noValidate className="mt-4 space-y-3">
        {error !== null && <Alert tone="danger">{error}</Alert>}
        <TextField
          label="Valor (R$)"
          name="amount"
          inputMode="decimal"
          autoComplete="off"
          placeholder="500,00"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onBlur={() => setTouched(true)}
          error={fieldError}
        />
        <div className="flex flex-wrap gap-2" role="group" aria-label="Valores rápidos">
          {QUICK_AMOUNTS.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setText(String(value / 100).replace('.', ','));
                setTouched(true);
                setError(null);
              }}
              className="min-h-9 rounded-full border border-stone-300 px-3 text-xs font-medium hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800"
            >
              {formatBRL(value)}
            </button>
          ))}
        </div>
        <Button type="submit" loading={pending}>
          Depositar
        </Button>
      </form>
    </Card>
  );
}

function LedgerRow({ entry }: { entry: LedgerEntry }) {
  const text = LEDGER_TEXT[entry.kind];
  const plus = text.effect === 'plus';
  return (
    <li className="flex items-center justify-between gap-3 py-3 text-sm">
      <div className="min-w-0">
        <p className="font-medium">{text.label}</p>
        {entry.lotTitle !== null && (
          <p className="truncate text-xs text-stone-600 dark:text-stone-400">{entry.lotTitle}</p>
        )}
        <p className="text-xs text-stone-500 dark:text-stone-400">
          {formatDateTime(entry.createdAt)}
        </p>
      </div>
      <div className="text-right">
        <p
          className={
            plus
              ? 'tabular font-semibold text-emerald-700 dark:text-emerald-400'
              : 'tabular font-semibold text-red-700 dark:text-red-400'
          }
        >
          <span className="sr-only">{plus ? 'Entrada de ' : 'Saída de '}</span>
          {plus ? '+' : '−'} {formatBRL(entry.amount)}
        </p>
        <p className="tabular text-xs text-stone-500 dark:text-stone-400">
          disponível depois: {formatBRL(entry.totalAfter - entry.committedAfter)}
        </p>
      </div>
    </li>
  );
}

export function WalletPage() {
  useDocumentTitle('Carteira');
  const { user, viewerKey } = useSession();

  const query = useInfiniteQuery({
    queryKey: keys.wallet(viewerKey),
    queryFn: ({ pageParam, signal }) => api.wallet({ before: pageParam }, signal),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const summary = query.data?.pages[0];
  const entries = query.data?.pages.flatMap((page) => page.ledger) ?? [];

  return (
    <>
      <PageHeader
        title="Carteira"
        subtitle="Saldo, valores reservados em lances e o extrato completo."
      />

      {query.isPending && (
        <div className="grid gap-4 sm:grid-cols-3" role="status" aria-label="Carregando carteira">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      )}

      {query.isError && summary === undefined && (
        <LoadError
          message={messageForError(query.error)}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      )}

      {summary !== undefined && (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label="Saldo total" value={summary.total} />
            <Stat
              label="Reservado em lances"
              value={summary.committed}
              hint="Fica preso enquanto você lidera."
            />
            <Stat
              label="Disponível"
              value={summary.available}
              hint="O que você pode usar em novos lances."
            />
          </div>

          {user?.role === 'bidder' && <DepositForm currentTotal={summary.total} />}

          <Card as="section">
            <h2 className="font-semibold">Extrato</h2>
            {entries.length === 0 ? (
              <div className="mt-3">
                <EmptyState title="Nenhuma movimentação ainda">
                  {user?.role === 'bidder'
                    ? 'Adicione saldo para começar a dar lances.'
                    : 'Os valores das suas vendas aparecem aqui.'}
                </EmptyState>
              </div>
            ) : (
              <ul className="mt-2 divide-y divide-stone-200 dark:divide-stone-800">
                {entries.map((entry) => (
                  <LedgerRow key={entry.id} entry={entry} />
                ))}
              </ul>
            )}
            {query.isError && (
              <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
                {messageForError(query.error)}
              </p>
            )}
            {query.hasNextPage && (
              <div className="mt-4 flex justify-center">
                <Button
                  variant="secondary"
                  onClick={() => void query.fetchNextPage()}
                  loading={query.isFetchingNextPage}
                >
                  Carregar mais
                </Button>
              </div>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

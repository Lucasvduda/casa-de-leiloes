import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/endpoints';
import { isApiError, isRetryable } from '../../api/errors';
import type { BidAccepted, LotDetail, LotPhase } from '../../api/types';
import { useToast } from '../../components/toast';
import { Alert, Button, ButtonLink, Card, cn } from '../../components/ui';
import { IntentKey } from '../../lib/idempotency';
import { messageForError } from '../../lib/messages';
import {
  MAX_WALLET_BALANCE_CENTS,
  formatBRL,
  formatBRLPlain,
  parseBRLToCents,
} from '../../lib/money';
import { useSession } from '../auth/session';
import { useBalance } from '../wallet/use-balance';
import { CancelLotButton } from './CancelLotButton';
import { Countdown } from './LotParts';
import { bidSuggestions, isUnusualBid, viewerStatus } from './room-state';

interface BidPanelProps {
  lot: LotDetail;
  /** Fase calculada pelo relogio do servidor (nao a que estava salva no lote). */
  phase: LotPhase;
  onAccepted: (accepted: BidAccepted) => void;
}

/** Valida o valor digitado. Devolve o texto do erro (ou undefined) e o valor em centavos (ou null). */
export function checkBid(
  text: string,
  lot: Pick<LotDetail, 'minimumNextBid'>,
  availableCents: number | undefined,
): { amount: number | null; error: string | undefined; insufficient: boolean } {
  const amount = parseBRLToCents(text);
  if (amount === null) {
    return {
      amount: null,
      error: 'Informe um valor válido, por exemplo 1.500,00.',
      insufficient: false,
    };
  }
  if (amount > MAX_WALLET_BALANCE_CENTS) {
    return { amount, error: 'Valor acima do máximo permitido.', insufficient: false };
  }
  if (amount < lot.minimumNextBid) {
    return {
      amount,
      error: `O lance mínimo agora é ${formatBRL(lot.minimumNextBid)}.`,
      insufficient: false,
    };
  }
  if (availableCents !== undefined && amount > availableCents) {
    return {
      amount,
      error: `Saldo insuficiente: você tem ${formatBRL(availableCents)} disponível.`,
      insufficient: true,
    };
  }
  return { amount, error: undefined, insufficient: false };
}

export function BidPanel({ lot, phase, onAccepted }: BidPanelProps) {
  const { user } = useSession();
  const status = viewerStatus(lot);
  const lotPath = `/lotes/${lot.id}`;
  const next = encodeURIComponent(lotPath);

  if (user === null) {
    return (
      <Card>
        <h2 className="font-semibold">Quer dar um lance?</h2>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
          Entre ou crie uma conta de licitante. Você pode acompanhar este leilão sem login.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <ButtonLink to={`/entrar?next=${next}`}>Entrar</ButtonLink>
          <ButtonLink to={`/cadastro?next=${next}`} variant="secondary">
            Criar conta
          </ButtonLink>
        </div>
      </Card>
    );
  }

  if (user.role === 'seller') {
    return (
      <Card>
        {status === 'seller' ? (
          <>
            <h2 className="font-semibold">Este é o seu lote</h2>
            <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
              Leiloeiros não dão lances. Acompanhe a disputa em tempo real.
            </p>
            {lot.status === 'open' && (
              <div className="mt-3">
                <CancelLotButton lotId={lot.id} title={lot.title} bidCount={lot.bidCount} />
              </div>
            )}
          </>
        ) : (
          <p className="text-sm">Contas de leiloeiro não dão lances. Use uma conta de licitante.</p>
        )}
      </Card>
    );
  }

  if (phase === 'cancelled') return null;
  if (phase === 'closed') return null;
  if (phase === 'ended') {
    return (
      <Alert tone="info" title="Encerrando">
        O prazo acabou. Estamos confirmando o resultado...
      </Alert>
    );
  }
  if (phase === 'scheduled') {
    return (
      <Alert tone="info" title="Este leilão ainda não começou">
        Os lances abrem em <Countdown target={lot.startsAt} />.
      </Alert>
    );
  }
  if (status === 'leading') {
    return (
      <Alert tone="success" title="Você está liderando">
        Seu lance de {formatBRL(lot.currentAmount ?? 0)} é o maior. Se alguém cobrir, você será
        avisado aqui.
      </Alert>
    );
  }

  return <BidForm lot={lot} onAccepted={onAccepted} outbid={status === 'outbid'} />;
}

function BidForm({
  lot,
  onAccepted,
  outbid,
}: {
  lot: LotDetail;
  onAccepted: (accepted: BidAccepted) => void;
  outbid: boolean;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const balance = useBalance();
  const available = balance.data?.available;

  // `null` = acompanhando o minimo (se outra pessoa cobrir, o campo sobe junto). Digitou: fica o que digitou.
  const [edited, setEdited] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const intent = useRef(new IntentKey('bid'));
  const inFlight = useRef(false);

  const text = edited ?? formatBRLPlain(lot.minimumNextBid);
  const check = checkBid(text, lot, available);
  const unusual =
    check.amount !== null && check.error === undefined
      ? isUnusualBid(check.amount, lot.minimumNextBid, lot.minIncrement)
      : false;
  // Erro de formato/minimo so aparece depois que a pessoa mexeu ou tentou enviar; saldo aparece sempre.
  const visibleError =
    showErrors || edited !== null || check.insufficient ? check.error : undefined;

  function change(value: string) {
    setEdited(value);
    setConfirming(false);
    setSubmitError(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    setShowErrors(true);
    setSubmitError(null);
    if (check.error !== undefined || check.amount === null) return;
    // Valor fora do normal (provavel zero a mais): segunda confirmacao antes de comprometer o saldo.
    if (unusual && !confirming) {
      setConfirming(true);
      return;
    }

    const amount = check.amount;
    inFlight.current = true;
    setPending(true);
    try {
      // Mesma intencao (lote + valor) reaproveita a chave: reenviar depois de uma queda nao duplica.
      const key = intent.current.keyFor(`${lot.id}:${amount}`);
      const accepted = await api.placeBid(lot.id, amount, key);
      intent.current.release();
      setEdited(null);
      setConfirming(false);
      setShowErrors(false);
      onAccepted(accepted);
      toast.push(
        'success',
        accepted.replayed
          ? 'Seu lance já estava registrado.'
          : `Lance de ${formatBRL(accepted.bid.amount)} registrado. Você está liderando.`,
      );
      if (accepted.extended) {
        toast.push('info', 'Lance nos últimos minutos: o prazo foi estendido em 2 minutos.');
      }
    } catch (error) {
      setConfirming(false);
      if (isRetryable(error)) {
        // Pode ter chegado ao servidor: a chave fica guardada para o proximo envio nao duplicar.
        setSubmitError(
          `${messageForError(error)} Se o lance já tiver sido registrado, enviar de novo não o duplica.`,
        );
      } else {
        intent.current.release();
        setSubmitError(messageForError(error));
        if (isApiError(error)) {
          if (error.code === 'BELOW_MINIMUM') setEdited(null);
          if (error.code === 'INSUFFICIENT_FUNDS')
            void queryClient.invalidateQueries({ queryKey: ['balance'] });
          // Estado do lote mudou por baixo de nos (alguem cobriu, encerrou, cancelou): mostra o real.
          void queryClient.invalidateQueries({ queryKey: ['lot'] });
        }
      }
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  const suggestions = bidSuggestions(lot.minimumNextBid, lot.minIncrement);
  const inputId = 'valor-lance';

  return (
    <Card>
      {outbid && (
        <Alert tone="warning" title="Você foi superado" className="mb-4">
          Alguém cobriu o seu lance. Dê um novo lance para voltar à liderança.
        </Alert>
      )}

      <form onSubmit={(e) => void submit(e)} noValidate>
        <label htmlFor={inputId} className="block text-sm font-medium">
          Seu lance
        </label>
        <div className="mt-1 flex flex-wrap gap-2">
          <div className="relative min-w-40 flex-1">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-stone-500"
            >
              R$
            </span>
            <input
              id={inputId}
              name="amount"
              inputMode="decimal"
              autoComplete="off"
              value={text}
              onChange={(e) => change(e.target.value)}
              aria-invalid={visibleError !== undefined || undefined}
              aria-describedby={`${inputId}-info`}
              className={cn(
                'tabular block min-h-12 w-full rounded-lg border bg-white py-2 pl-11 pr-3 text-xl font-semibold dark:bg-stone-900',
                visibleError !== undefined
                  ? 'border-red-500'
                  : 'border-stone-300 focus:border-amber-500 dark:border-stone-700',
              )}
            />
          </div>
          <Button
            type="submit"
            loading={pending}
            // Saldo insuficiente nem sai da tela. Outros erros aparecem ao clicar (o servidor revalida tudo).
            disabled={check.insufficient}
            variant={confirming ? 'danger' : 'primary'}
            className="min-h-12 px-6 text-base"
          >
            {confirming && check.amount !== null
              ? `Confirmar lance de ${formatBRL(check.amount)}`
              : 'Dar lance'}
          </Button>
        </div>

        <p id={`${inputId}-info`} className="mt-2 text-xs text-stone-600 dark:text-stone-400">
          Lance mínimo: <strong className="tabular">{formatBRL(lot.minimumNextBid)}</strong>
          {available !== undefined && (
            <>
              {' '}
              · Seu saldo disponível: <strong className="tabular">{formatBRL(available)}</strong>
            </>
          )}
        </p>

        {visibleError !== undefined && (
          <p role="alert" className="mt-2 text-sm font-medium text-red-600 dark:text-red-400">
            {visibleError}{' '}
            {check.insufficient && (
              <Link to="/carteira" className="underline">
                Adicionar saldo
              </Link>
            )}
          </p>
        )}

        {confirming && (
          <p role="alert" className="mt-2 text-sm font-medium text-amber-800 dark:text-amber-300">
            Este valor está bem acima do mínimo. Confira antes de confirmar: o lance compromete o
            seu saldo.
          </p>
        )}

        {submitError !== null && (
          <Alert tone="danger" className="mt-3">
            {submitError}
          </Alert>
        )}

        <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Valores sugeridos">
          {suggestions.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => change(formatBRLPlain(value))}
              className="min-h-9 rounded-full border border-stone-300 px-3 text-xs font-medium hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800"
            >
              {formatBRL(value)}
            </button>
          ))}
        </div>
      </form>
    </Card>
  );
}

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { LotSummary } from '../../api/types';
import { formatBRL } from '../../lib/money';
import { useServerNow } from '../../lib/server-time';
import { Countdown, ItemImage, PhaseBadge } from './LotParts';
import { phaseAt } from './room-state';

/** Linha compacta de lote (paineis do licitante e do leiloeiro). `status` e `actions` sao encaixes. */
export function LotRow({
  lot,
  status,
  actions,
}: {
  lot: LotSummary;
  status?: ReactNode;
  actions?: ReactNode;
}) {
  const now = useServerNow();
  const phase = phaseAt(lot, now);
  const hasBids = lot.currentAmount !== null;

  return (
    <li className="flex flex-wrap items-center gap-3 rounded-xl border border-stone-200 bg-white p-3 dark:border-stone-800 dark:bg-stone-900 sm:flex-nowrap">
      <Link to={`/lotes/${lot.id}`} className="shrink-0" tabIndex={-1} aria-hidden="true">
        <ItemImage src={lot.imageUrl} alt="" className="size-16 rounded-lg" />
      </Link>

      <div className="min-w-0 flex-1">
        <Link to={`/lotes/${lot.id}`} className="block truncate font-semibold hover:underline">
          {lot.title}
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-stone-600 dark:text-stone-400">
          <PhaseBadge phase={phase} />
          {status}
          <span className="tabular">
            {lot.bidCount} {lot.bidCount === 1 ? 'lance' : 'lances'}
          </span>
          {phase === 'live' && (
            <span>
              termina em{' '}
              <Countdown target={lot.endsAt} className="text-stone-900 dark:text-stone-100" />
            </span>
          )}
          {phase === 'scheduled' && (
            <span>
              começa em{' '}
              <Countdown target={lot.startsAt} className="text-stone-900 dark:text-stone-100" />
            </span>
          )}
        </div>
      </div>

      <div className="text-right">
        <p className="text-xs text-stone-500 dark:text-stone-400">
          {phase === 'closed' && hasBids
            ? 'Valor final'
            : hasBids
              ? 'Lance atual'
              : 'Lance inicial'}
        </p>
        <p className="tabular font-bold">{formatBRL(lot.currentAmount ?? lot.startingBid)}</p>
      </div>

      {actions !== undefined && <div className="flex flex-wrap gap-2">{actions}</div>}
    </li>
  );
}

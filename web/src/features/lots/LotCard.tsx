import { Link } from 'react-router-dom';
import type { LotSummary } from '../../api/types';
import { Badge } from '../../components/ui';
import { formatBRL } from '../../lib/money';
import { useServerNow } from '../../lib/server-time';
import { Countdown, ItemImage, PhaseBadge } from './LotParts';
import { phaseAt } from './room-state';

/** Card da vitrine. A fase vem do relogio do servidor, nao do que estava salvo quando a lista foi carregada. */
export function LotCard({ lot }: { lot: LotSummary }) {
  const now = useServerNow();
  const phase = phaseAt(lot, now);
  const hasBids = lot.currentAmount !== null;
  const priceLabel =
    phase === 'closed'
      ? hasBids
        ? 'Arrematado por'
        : 'Sem lances'
      : hasBids
        ? 'Lance atual'
        : 'Lance inicial';
  const price = phase === 'closed' && !hasBids ? null : (lot.currentAmount ?? lot.startingBid);

  return (
    <li className="list-none">
      <Link
        to={`/lotes/${lot.id}`}
        className="group flex h-full flex-col overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:border-stone-800 dark:bg-stone-900"
      >
        <div className="relative">
          <ItemImage src={lot.imageUrl} alt={lot.title} className="aspect-[4/3] w-full" />
          <div className="absolute left-2 top-2 flex flex-wrap gap-1">
            <PhaseBadge phase={phase} />
            {lot.viewer?.isLeading === true && phase === 'live' && (
              <Badge tone="success">Você está liderando</Badge>
            )}
            {lot.viewer?.isSeller === true && <Badge tone="info">Seu lote</Badge>}
          </div>
        </div>

        <div className="flex flex-1 flex-col gap-2 p-4">
          <h3 className="line-clamp-2 font-serif text-lg font-semibold leading-snug group-hover:underline">
            {lot.title}
          </h3>
          <p className="text-xs text-stone-500 dark:text-stone-400">por {lot.sellerName}</p>

          <div className="mt-auto flex items-end justify-between gap-2 pt-2">
            <div>
              <p className="text-xs text-stone-500 dark:text-stone-400">{priceLabel}</p>
              {price !== null && <p className="tabular text-xl font-bold">{formatBRL(price)}</p>}
            </div>
            <div className="text-right text-xs text-stone-600 dark:text-stone-400">
              <p className="tabular">
                {lot.bidCount} {lot.bidCount === 1 ? 'lance' : 'lances'}
              </p>
              {phase === 'live' && (
                <p>
                  Termina em{' '}
                  <Countdown target={lot.endsAt} className="text-stone-900 dark:text-stone-100" />
                </p>
              )}
              {phase === 'scheduled' && (
                <p>
                  Começa em{' '}
                  <Countdown target={lot.startsAt} className="text-stone-900 dark:text-stone-100" />
                </p>
              )}
            </div>
          </div>
        </div>
      </Link>
    </li>
  );
}

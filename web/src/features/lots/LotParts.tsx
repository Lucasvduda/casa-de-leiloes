import { useState } from 'react';
import type { LotPhase } from '../../api/types';
import { Badge, cn } from '../../components/ui';
import { describeRemaining, formatCountdown, safeHttpUrl } from '../../lib/format';
import { useServerNow } from '../../lib/server-time';

/**
 * Imagem do item. Vem de fonte externa: so http(s), sem enviar o endereco da pagina (`no-referrer`),
 * carrega preguicosa e, se falhar, mostra um quadro neutro (nunca o icone de imagem quebrada).
 */
export function ItemImage({
  src,
  alt,
  className,
  eager = false,
}: {
  src: string | null;
  alt: string;
  className?: string;
  eager?: boolean;
}) {
  const url = safeHttpUrl(src);
  const [failed, setFailed] = useState(false);
  if (url === null || failed) {
    return (
      <div
        role="img"
        aria-label={`Sem imagem: ${alt}`}
        className={cn(
          'flex items-center justify-center bg-stone-200 text-4xl text-stone-400 dark:bg-stone-800 dark:text-stone-600',
          className,
        )}
      >
        <span aria-hidden="true">🖼</span>
      </div>
    );
  }
  return (
    <img
      src={url}
      alt={alt}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={cn('bg-stone-200 object-cover dark:bg-stone-800', className)}
    />
  );
}

/** Contagem regressiva pelo relogio do servidor. `role="timer"`: leitor de tela nao narra cada segundo. */
export function Countdown({ target, className }: { target: string; className?: string }) {
  const now = useServerNow();
  const remaining = Date.parse(target) - now;
  return (
    <time
      role="timer"
      dateTime={target}
      title={describeRemaining(remaining)}
      className={cn('tabular font-semibold', className)}
    >
      {formatCountdown(remaining)}
    </time>
  );
}

const PHASE_TEXT: Record<
  LotPhase,
  { label: string; tone: 'success' | 'info' | 'neutral' | 'danger' | 'warning' }
> = {
  live: { label: 'Ao vivo', tone: 'success' },
  scheduled: { label: 'Agendado', tone: 'info' },
  ended: { label: 'Encerrando', tone: 'warning' },
  closed: { label: 'Encerrado', tone: 'neutral' },
  cancelled: { label: 'Cancelado', tone: 'danger' },
};

export function PhaseBadge({ phase }: { phase: LotPhase }) {
  const { label, tone } = PHASE_TEXT[phase];
  return (
    <Badge tone={tone}>
      {phase === 'live' && (
        <span
          aria-hidden="true"
          className="size-1.5 animate-pulse rounded-full bg-emerald-600 dark:bg-emerald-400"
        />
      )}
      {label}
    </Badge>
  );
}

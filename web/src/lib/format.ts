const dateTime = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const dateTimeSeconds = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const timeOnly = new Intl.DateTimeFormat('pt-BR', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const safe = (iso: string, fmt: Intl.DateTimeFormat): string => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? fmt.format(ms) : '—';
};

export const formatDateTime = (iso: string): string => safe(iso, dateTime);
export const formatDateTimeSeconds = (iso: string): string => safe(iso, dateTimeSeconds);
export const formatTime = (iso: string): string => safe(iso, timeOnly);

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * Tempo restante legivel: "2d 03h 12m" (a partir de 1 dia) ou "HH:MM:SS". Nunca negativo.
 * Arredonda para CIMA (999 ms ainda e "00:00:01"): o leilao so aparece zerado quando de fato zerou.
 */
export function formatCountdown(remainingMs: number): string {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return '00:00:00';
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${pad(hours)}h ${pad(minutes)}m`;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/** Versao falada, para leitor de tela: "2 dias, 3 horas e 12 minutos". */
export function describeRemaining(remainingMs: number): string {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 'encerrado';
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  const unit = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (days > 0) parts.push(unit(days, 'dia', 'dias'));
  if (hours > 0) parts.push(unit(hours, 'hora', 'horas'));
  if (minutes > 0 && days === 0) parts.push(unit(minutes, 'minuto', 'minutos'));
  if (days === 0 && hours === 0 && minutes === 0) parts.push(unit(seconds, 'segundo', 'segundos'));
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} e ${parts[parts.length - 1] ?? ''}`;
}

/** Abrevia hash para a tela ("a1b2c3d4…9f8e"); o valor completo fica em title/copiar. */
export function shortHash(hash: string, head = 8, tail = 4): string {
  if (hash.length <= head + tail + 1) return hash;
  return `${hash.slice(0, head)}…${hash.slice(-tail)}`;
}

/** So http(s) vira link/imagem: defesa em profundidade (o servidor ja filtra na criacao do lote). */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

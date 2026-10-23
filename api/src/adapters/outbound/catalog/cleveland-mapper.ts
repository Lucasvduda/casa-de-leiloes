import { z } from 'zod';
import type { ItemSnapshot } from '../../../application/ports.js';
import { UpstreamError } from './resilient-fetch.js';

/**
 * Traducao do formato do Cleveland Museum of Art Open Access para o `ItemSnapshot` do leilao.
 *
 * Tudo que vem de fora e hostil ate prova em contrario: o payload e validado, o texto e limpo
 * (controle, bidi) e truncado, e URL so passa se for https de um host conhecido. Item sem licenca
 * CC0, sem imagem ou invalido e DESCARTADO (nao quebra a pagina inteira).
 */
export const CLEVELAND_SOURCE = 'cleveland';
/** Ids do Cleveland sao numericos. Qualquer outra coisa nem chega a virar chamada externa. */
export const SOURCE_ID_PATTERN = /^[0-9]{1,12}$/;

/** Campos pedidos a API (reduz o payload; a biografia dos autores continua vindo, por isso o teto de bytes). */
export const CLEVELAND_FIELDS =
  'id,title,creation_date,type,creators,images,url,share_license_status,culture,department';

const IMAGE_HOSTS: ReadonlySet<string> = new Set(['openaccess-cdn.clevelandart.org']);
const PAGE_HOSTS: ReadonlySet<string> = new Set(['clevelandart.org', 'www.clevelandart.org']);

const MAX_TITLE = 200;
const MAX_ATTRIBUTE = 200;
const MAX_URL = 300;

/** Controle C0/C1 e marcadores bidi (usados para disfarcar texto: "trojan source"). */
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (text === '') return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** https, host na lista, sem credenciais embutidas. Devolve a URL normalizada ou null. */
export function safeUrl(value: unknown, hosts: ReadonlySet<string>): string | null {
  if (typeof value !== 'string' || value.length > MAX_URL) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (!hosts.has(url.hostname)) return null;
  return url.toString();
}

const optionalText = z.string().nullish();

const artworkSchema = z.object({
  id: z.number().int().positive().max(999_999_999_999),
  title: optionalText,
  creation_date: optionalText,
  type: optionalText,
  department: optionalText,
  culture: z.array(z.string()).nullish(),
  url: optionalText,
  share_license_status: optionalText,
  images: z.object({ web: z.object({ url: z.string() }).nullish() }).nullish(),
  creators: z.array(z.object({ description: optionalText })).nullish(),
});

/** `null` quando o item nao serve para leilao (sem CC0, sem imagem segura, sem titulo, invalido). */
export function mapArtwork(raw: unknown): ItemSnapshot | null {
  const parsed = artworkSchema.safeParse(raw);
  if (!parsed.success) return null;
  const art = parsed.data;

  if (art.share_license_status !== 'CC0') return null;
  const title = cleanText(art.title, MAX_TITLE);
  const imageUrl = safeUrl(art.images?.web?.url, IMAGE_HOSTS);
  if (title === null || imageUrl === null) return null;

  const attributes: Record<string, string> = {};
  const put = (key: string, value: unknown): void => {
    const text = cleanText(value, MAX_ATTRIBUTE);
    if (text !== null) attributes[key] = text;
  };
  put('Artista', art.creators?.[0]?.description);
  put('Data', art.creation_date);
  put('Tipo', art.type);
  put('Cultura', art.culture?.[0]);
  put('Departamento', art.department);

  return {
    source: CLEVELAND_SOURCE,
    sourceId: String(art.id),
    sourceUrl: safeUrl(art.url, PAGE_HOSTS),
    title,
    imageUrl,
    attributes,
  };
}

const searchEnvelope = z.object({
  info: z.object({ total: z.number().int().nonnegative() }),
  data: z.array(z.unknown()),
});

const itemEnvelope = z.object({ data: z.unknown() });

/** Envelope invalido = a API mudou ou foi adulterada: erro de upstream (conta para o circuit breaker). */
export function parseSearchResponse(body: unknown): { items: ItemSnapshot[]; total: number } {
  const parsed = searchEnvelope.safeParse(body);
  if (!parsed.success) throw new UpstreamError('resposta de busca fora do formato', 'payload');
  const items = parsed.data.data.flatMap((raw) => {
    const item = mapArtwork(raw);
    return item === null ? [] : [item];
  });
  return { items, total: parsed.data.info.total };
}

export function parseItemResponse(body: unknown): ItemSnapshot | null {
  const parsed = itemEnvelope.safeParse(body);
  if (!parsed.success) throw new UpstreamError('resposta de item fora do formato', 'payload');
  return mapArtwork(parsed.data.data);
}

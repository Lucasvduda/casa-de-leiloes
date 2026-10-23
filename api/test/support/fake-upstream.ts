import type { ItemSnapshot } from '../../src/application/ports.js';

/** Resposta JSON como a API real devolveria. */
export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

export type Handler = (
  url: string,
  callIndex: number,
  init: RequestInit,
) => Response | Promise<Response>;

/** `fetch` falso que registra as chamadas e responde conforme o `handler` do momento. */
export class FakeUpstream {
  readonly calls: { url: string; init: RequestInit }[] = [];
  handler: Handler;

  constructor(handler: Handler) {
    this.handler = handler;
  }

  readonly fetch: typeof fetch = (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const index = this.calls.length;
    this.calls.push({ url, init });
    return Promise.resolve(this.handler(url, index, init));
  };

  params(callIndex: number): URLSearchParams {
    const call = this.calls[callIndex];
    if (call === undefined) throw new Error(`nao houve a chamada ${callIndex}`);
    return new URL(call.url).searchParams;
  }
}

/** Artigo valido no formato do Cleveland Museum of Art (campos pedidos pelo adaptador). */
export function artwork(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Obra ${id}`,
    creation_date: 'c. 1890',
    type: 'Painting',
    department: 'Pintura Europeia',
    culture: ['France, 19th century'],
    url: `https://clevelandart.org/art/${id}`,
    share_license_status: 'CC0',
    images: { web: { url: `https://openaccess-cdn.clevelandart.org/${id}/${id}_web.jpg` } },
    creators: [{ description: 'Claude Monet (French, 1840–1926)' }],
    ...over,
  };
}

export const searchBody = (items: unknown[], total = items.length) => ({
  info: { total },
  data: items,
});

export const itemBody = (item: unknown) => ({ data: item });

export function snapshot(
  id: number,
  title = `Offline ${id}`,
  artist = 'Artista Offline',
): ItemSnapshot {
  return {
    source: 'cleveland',
    sourceId: String(id),
    sourceUrl: `https://clevelandart.org/art/${id}`,
    title,
    imageUrl: `https://openaccess-cdn.clevelandart.org/${id}/${id}_web.jpg`,
    attributes: { Artista: artist },
  };
}

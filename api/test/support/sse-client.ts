import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';

export interface SseEvent {
  readonly event: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly data: any;
}

/** Servidor HTTP real em porta efemera: SSE precisa de socket de verdade, nao do supertest. */
export async function listen(
  app: Express,
): Promise<{ baseUrl: string; server: Server; close(): Promise<void> }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Cliente SSE minimo: le o stream em segundo plano e entrega eventos na ordem. */
export class SseStream {
  readonly queue: SseEvent[] = [];
  readonly rawChunks: string[] = [];
  retryMs: number | null = null;
  done = false;
  private waiter: (() => void) | null = null;
  private readonly abort = new AbortController();

  private constructor(
    readonly status: number,
    readonly headers: Headers,
    private readonly reader: ReadableStreamDefaultReader<Uint8Array> | null,
  ) {
    if (reader === null) this.done = true;
    else void this.pump();
  }

  static async connect(
    baseUrl: string,
    path: string,
    options: { cookie?: string | null } = {},
  ): Promise<SseStream> {
    const abort = new AbortController();
    const response = await fetch(`${baseUrl}${path}`, {
      headers: {
        accept: 'text/event-stream',
        ...(options.cookie ? { cookie: options.cookie } : {}),
      },
      signal: abort.signal,
    });
    const isStream =
      response.status === 200 &&
      (response.headers.get('content-type') ?? '').includes('text/event-stream');
    const stream = new SseStream(
      response.status,
      response.headers,
      isStream ? response.body!.getReader() : null,
    );
    if (!isStream) {
      stream.bodyText = await response.text();
    }
    stream.abortFetch = () => abort.abort();
    return stream;
  }

  /** Corpo quando a resposta NAO e um stream (erro JSON, 204...). */
  bodyText = '';
  private abortFetch: () => void = () => undefined;

  private async pump(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await this.reader!.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        this.rawChunks.push(text);
        buffer += text;
        let index: number;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          this.parse(buffer.slice(0, index));
          buffer = buffer.slice(index + 2);
        }
      }
    } catch {
      // conexao derrubada: tratado como fim
    } finally {
      this.done = true;
      this.wake();
    }
  }

  private parse(block: string): void {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue;
      const [field, ...rest] = line.split(':');
      const value = rest.join(':').replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
      else if (field === 'retry') this.retryMs = Number(value);
    }
    if (data.length === 0) return;
    this.queue.push({ event, data: JSON.parse(data.join('\n')) });
    this.wake();
  }

  private wake(): void {
    this.waiter?.();
    this.waiter = null;
  }

  /** Proximo evento (qualquer um). Falha em timeout ou se o stream acabou sem eventos. */
  async next(timeoutMs = 3_000): Promise<SseEvent> {
    const deadline = Date.now() + timeoutMs;
    while (this.queue.length === 0) {
      if (this.done) throw new Error('stream encerrado sem mais eventos');
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`sem evento em ${timeoutMs}ms`);
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
        setTimeout(resolve, left);
      });
    }
    return this.queue.shift()!;
  }

  /** Pula eventos ate achar `name` (ex.: ignora `tick`). */
  async until(name: string, timeoutMs = 3_000): Promise<SseEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const event = await this.next(Math.max(1, deadline - Date.now()));
      if (event.event === name) return event;
    }
  }

  /** O servidor encerrou o stream (e nao ha eventos pendentes)? */
  async ended(timeoutMs = 3_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.done) {
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return true;
  }

  /** Nenhum evento novo chega em `ms` (prova negativa com tempo limitado). */
  async quiet(ms = 150): Promise<boolean> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return this.queue.length === 0;
  }

  close(): void {
    this.abortFetch();
    void this.reader?.cancel().catch(() => undefined);
    this.abort.abort();
  }
}

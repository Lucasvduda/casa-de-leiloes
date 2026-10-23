import type { Server } from 'node:http';
import type { Logger } from 'pino';
import type { Container } from './container.js';

export interface StartOptions {
  /** Porta a abrir. Padrao: `config.PORT`. Os testes usam 0 (porta efemera). */
  readonly port?: number;
  readonly host?: string;
  /** Tempo que conexoes em andamento tem para terminar antes de serem cortadas no desligamento. */
  readonly drainMs?: number;
}

export interface RunningServer {
  readonly port: number;
  readonly server: Server;
  /** Desligamento ordenado e idempotente: segunda chamada devolve a mesma promessa. */
  shutdown(): Promise<void>;
}

const DEFAULT_DRAIN_MS = 5_000;

/**
 * Abre a porta, liga o agendador e devolve o desligamento ordenado:
 *   1. para de aceitar conexoes novas e encerra as ociosas;
 *   2. fecha os streams SSE (senao `server.close` esperaria ate a vida maxima deles);
 *   3. para o agendador e ESPERA a tarefa em andamento terminar;
 *   4. depois do prazo, corta o que sobrou;
 *   5. so entao fecha o pool (nada ainda escreve no banco).
 */
export async function startServer(
  container: Container,
  logger: Logger,
  options: StartOptions = {},
): Promise<RunningServer> {
  const { app, hub, scheduler, pool, config } = container;
  const drainMs = options.drainMs ?? DEFAULT_DRAIN_MS;

  const server = await new Promise<Server>((resolve, reject) => {
    const candidate = app.listen(options.port ?? config.PORT, options.host ?? '0.0.0.0');
    candidate.once('error', reject);
    candidate.once('listening', () => {
      candidate.off('error', reject);
      resolve(candidate);
    });
  }).catch(async (error: unknown) => {
    await pool.end().catch(() => undefined);
    throw error;
  });

  // Acima do ocioso dos balanceadores usuais (~60 s): evita corrida em que o proxy reaproveita
  // uma conexao que o Node acabou de fechar (502 intermitente).
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  // Tempo maximo para RECEBER a requisicao inteira (corpo lento = slowloris). Nao limita o SSE,
  // que e resposta, nem a duracao da resposta.
  server.requestTimeout = 30_000;

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.PORT;

  scheduler.start();
  logger.info({ port, env: config.NODE_ENV }, 'server_listening');

  let shuttingDown: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shuttingDown ??= (async () => {
      logger.info('shutdown_started');
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      hub.close();
      const stopped = scheduler.stop();

      // Uma conexao so fica "ociosa" depois que a resposta em curso termina (ex.: o fim de um SSE
      // acabou de ser enviado). Varrer as ociosas ate o servidor fechar evita esperar o keep-alive.
      const sweep = setInterval(() => server.closeIdleConnections(), 25);
      const cutoff = setTimeout(() => server.closeAllConnections(), drainMs);
      try {
        await Promise.all([closed, stopped]);
      } finally {
        clearInterval(sweep);
        clearTimeout(cutoff);
      }
      // Pool ja encerrado (ex.: falha anterior) nao pode impedir o processo de terminar.
      await pool.end().catch((err: unknown) => logger.warn({ err }, 'pool_end_failed'));
      logger.info('shutdown_complete');
    })();
    return shuttingDown;
  };

  return { port, server, shutdown };
}

import { loadConfig } from './infrastructure/config.js';
import { buildContainer } from './infrastructure/container.js';
import { createLogger } from './infrastructure/logger.js';
import { startServer } from './infrastructure/server.js';

/** Depois disto o processo sai de qualquer jeito (o orquestrador mandaria SIGKILL logo em seguida). */
const SHUTDOWN_DEADLINE_MS = 10_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  const container = await buildContainer(config, logger);
  const running = await startServer(container, logger);

  let exiting = false;
  const stop = (reason: string, exitCode: number): void => {
    if (exiting) return;
    exiting = true;
    logger.info({ reason }, 'process_stopping');
    const force = setTimeout(() => {
      logger.error('shutdown_forced');
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    force.unref();
    running.shutdown().then(
      () => process.exit(exitCode),
      (err: unknown) => {
        logger.error({ err }, 'shutdown_error');
        process.exit(1);
      },
    );
  };

  process.on('SIGTERM', () => stop('SIGTERM', 0));
  process.on('SIGINT', () => stop('SIGINT', 0));
  // Estado desconhecido: o seguro e registrar e reiniciar limpo (o orquestrador sobe outro processo).
  process.on('unhandledRejection', (err) => {
    logger.fatal({ err }, 'unhandled_rejection');
    stop('unhandledRejection', 1);
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught_exception');
    stop('uncaughtException', 1);
  });
}

main().catch((err: unknown) => {
  // Logger pode nem existir se a config falhou; stderr direto e o que resta.
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

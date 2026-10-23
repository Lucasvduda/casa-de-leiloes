import { createApp } from './adapters/inbound/http/app.js';
import { loadConfig } from './infrastructure/config.js';
import { createLogger } from './infrastructure/logger.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  // O banco entra na Fase 3; por ora readiness reflete apenas que o processo subiu.
  const app = createApp({ logger, readinessProbe: async () => true });

  const server = app.listen(config.PORT, '0.0.0.0', () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV }, 'server_listening');
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown_started');
    const force = setTimeout(() => {
      logger.error('shutdown_forced');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();
    server.close((err) => {
      if (err) {
        logger.error({ err }, 'shutdown_error');
        process.exit(1);
      }
      logger.info('shutdown_complete');
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  // Logger pode nem existir se a config falhou; stderr direto e o que resta.
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

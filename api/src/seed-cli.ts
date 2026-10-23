/**
 * `npm run seed`: aplica as migracoes e cria os dados de demonstracao (idempotente), sem subir o
 * servidor. Util para popular o banco de producao uma vez, ou resetar o ambiente local.
 */
import { loadConfig } from './infrastructure/config.js';
import { buildContainer } from './infrastructure/container.js';
import { createLogger } from './infrastructure/logger.js';

async function run(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  const container = await buildContainer(config, logger, { forceSeed: true });
  await container.pool.end();
  logger.info('seed_cli_done');
}

run().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

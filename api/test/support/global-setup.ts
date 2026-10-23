import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** URL de um servidor Postgres (qualquer banco) com permissao de CREATE DATABASE. */
    pgBaseUrl: string;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Se TEST_DATABASE_URL existir (CI), usa-o. Senao sobe um Postgres embutido em diretorio temporario
 * e o derruba no fim, sem deixar processo nem porta presos.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const external = process.env.TEST_DATABASE_URL;
  if (external !== undefined && external !== '') {
    project.provide('pgBaseUrl', external);
    return async () => undefined;
  }

  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const dir = mkdtempSync(join(tmpdir(), 'leilao-pg-'));
  const port = await freePort();
  const server = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
    onLog: () => undefined,
    onError: () => undefined,
  });
  await server.initialise();
  await server.start();
  project.provide('pgBaseUrl', `postgres://postgres:postgres@127.0.0.1:${port}/postgres`);

  return async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  };
}

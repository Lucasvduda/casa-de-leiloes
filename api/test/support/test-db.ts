import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { runMigrations } from '../../src/adapters/outbound/postgres/migrate.js';
import { createPool } from '../../src/adapters/outbound/postgres/pool.js';
import { PgUnitOfWork } from '../../src/adapters/outbound/postgres/pg-unit-of-work.js';

export interface TestDb {
  readonly pool: pg.Pool;
  readonly uow: PgUnitOfWork;
  readonly url: string;
  /** Conexao dedicada de "superusuario" para simular adulteracao direta no banco. */
  rawClient(): Promise<pg.Client>;
  close(): Promise<void>;
}

/** Banco novo e isolado por arquivo de teste: nada vaza entre suites e elas rodam em paralelo. */
export async function createTestDb(maxConnections = 20): Promise<TestDb> {
  const baseUrl = inject('pgBaseUrl');
  const name = `t_${randomBytes(6).toString('hex')}`;

  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  // UTF8 explicito (como em producao): o padrao do Postgres no Windows e WIN1252 e rejeitaria
  // emoji e alfabetos nao latinos que as obras da API publica podem trazer.
  await admin.query(
    `CREATE DATABASE "${name}" TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`,
  );
  await admin.end();

  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString(), maxConnections);
  await runMigrations(pool);

  const clients: pg.Client[] = [];
  return {
    pool,
    uow: new PgUnitOfWork(pool),
    url: url.toString(),
    async rawClient() {
      const client = new pg.Client({ connectionString: url.toString() });
      // Testes de resiliencia matam conexoes de proposito: o erro assincrono nao pode derrubar a suite.
      client.on('error', () => undefined);
      await client.connect();
      clients.push(client);
      return client;
    },
    async close() {
      await Promise.all(clients.map((c) => c.end().catch(() => undefined)));
      await pool.end();
      const cleanup = new pg.Client({ connectionString: baseUrl });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

import pg from 'pg';

export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>>;
}

export function createPool(connectionString: string, max = 10): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    // Limite no cliente: uma consulta nunca pendura a requisicao indefinidamente.
    query_timeout: 15_000,
  });
  // Erro em conexao ociosa nao pode derrubar o processo.
  pool.on('error', () => undefined);
  return pool;
}

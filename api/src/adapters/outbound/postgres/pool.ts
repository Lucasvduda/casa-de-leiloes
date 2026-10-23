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
  // E erro em conexao EMPRESTADA tambem nao: o `pg` so avisa o pool enquanto o cliente esta ocioso.
  // Com a conexao em uso (ou na fresta entre sair do pool e alguem escutar), um erro sem ouvinte vira
  // excecao nao tratada e derruba o processo. O ouvinte fica no cliente por toda a vida dele; a falha
  // continua chegando a quem esta consultando, como erro da propria consulta.
  pool.on('connect', (client) => {
    client.on('error', () => undefined);
  });
  return pool;
}

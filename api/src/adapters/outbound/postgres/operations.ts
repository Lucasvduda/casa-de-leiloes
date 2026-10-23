import type pg from 'pg';

/** Prazo da sonda de prontidao: banco lento ja conta como "fora" (o balanceador decide o que fazer). */
const READINESS_TIMEOUT_MS = 2_000;

/**
 * Executa `fn` segurando um advisory lock do Postgres: varias instancias subindo juntas
 * (deploy com mais de uma replica) nao executam a mesma tarefa de inicializacao ao mesmo tempo.
 * O lock e da SESSAO: se o processo morrer no meio, o banco o solta sozinho.
 */
export async function withAdvisoryLock<T>(
  pool: pg.Pool,
  lockId: number,
  fn: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [lockId]);
    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [lockId]).catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

/**
 * O banco precisa ser UTF8: as obras da API publica trazem acentos, emoji e alfabetos nao latinos.
 * Em um banco SQL_ASCII/LATIN1 isso viraria erro so na hora de criar o lote; aqui falha no boot.
 */
export async function assertUtf8(pool: Pick<pg.Pool, 'query'>): Promise<void> {
  const { rows } = await pool.query<{ encoding: string }>(
    `SELECT current_setting('server_encoding') AS encoding`,
  );
  const encoding = rows[0]?.encoding ?? 'desconhecida';
  if (encoding.toUpperCase() !== 'UTF8') {
    throw new Error(
      `O banco precisa usar codificacao UTF8 (encontrada: ${encoding}). ` +
        `Crie o banco com ENCODING 'UTF8'.`,
    );
  }
}

/** Sonda de prontidao: `true` so se o banco responde a tempo. Nunca lanca. */
export function postgresReadiness(
  pool: Pick<pg.Pool, 'query'>,
  timeoutMs: number = READINESS_TIMEOUT_MS,
): () => Promise<boolean> {
  return async () => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref();
    });
    const probe = pool
      .query('SELECT 1')
      .then(() => true)
      .catch(() => false);
    try {
      return await Promise.race([probe, timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
}

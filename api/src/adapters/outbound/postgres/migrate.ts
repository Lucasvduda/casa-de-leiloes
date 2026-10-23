import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

/** Identificador do advisory lock: duas instancias subindo juntas nao migram ao mesmo tempo. */
const MIGRATION_LOCK_ID = 727_001;

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../../migrations/', import.meta.url),
);

export interface MigrationResult {
  readonly applied: string[];
  readonly skipped: string[];
}

/**
 * Aplica `*.sql` em ordem alfabetica, cada arquivo em uma transacao.
 * Guarda o checksum: se um arquivo ja aplicado for editado, recusa (migracao e historia, nao rascunho).
 */
export async function runMigrations(
  pool: pg.Pool,
  dir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<MigrationResult> {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    for (const file of files) {
      const sql = readFileSync(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query<{ checksum: string }>(
        'SELECT checksum FROM schema_migrations WHERE name = $1',
        [file],
      );
      const row = existing.rows[0];
      if (row !== undefined) {
        if (row.checksum !== checksum) {
          throw new Error(`Migracao ${file} foi alterada depois de aplicada (checksum diferente).`);
        }
        skipped.push(file);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(
          `Falha ao aplicar ${file}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
    return { applied, skipped };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}

import type pg from 'pg';
import type { Repositories, UnitOfWork } from '../../../application/ports.js';
import { PgBidRepository } from './pg-bid-repository.js';
import { PgLotRepository } from './pg-lot-repository.js';
import { PgReceiptRepository } from './pg-receipt-repository.js';
import { PgWalletRepository } from './pg-wallet-repository.js';
import type { Queryable } from './pool.js';

const DEADLOCK_DETECTED = '40P01';
const SERIALIZATION_FAILURE = '40001';
const MAX_ATTEMPTS = 3;

/** Espera maxima por um lock de linha: melhor falhar rapido (503) do que empilhar requisicoes. */
const LOCK_TIMEOUT = '5s';

export function repositoriesFor(db: Queryable): Repositories {
  return {
    lots: new PgLotRepository(db),
    bids: new PgBidRepository(db),
    wallets: new PgWalletRepository(db),
    receipts: new PgReceiptRepository(db),
  };
}

export class PgUnitOfWork implements UnitOfWork {
  constructor(private readonly pool: pg.Pool) {}

  run<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    return this.withRetry(() => this.transaction('BEGIN', work));
  }

  readSnapshot<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    return this.withRetry(() =>
      this.transaction('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', work),
    );
  }

  private async transaction<T>(
    begin: string,
    work: (repos: Repositories) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query(begin);
      await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
      const result = await work(repositoriesFor(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true; // conexao em estado desconhecido: descartar em vez de devolver ao pool
      }
      throw error;
    } finally {
      client.release(broken);
    }
  }

  /** Deadlock e falha de serializacao sao transitorios por definicao: tenta de novo. */
  private async withRetry<T>(attempt: () => Promise<T>): Promise<T> {
    for (let n = 1; ; n++) {
      try {
        return await attempt();
      } catch (error) {
        const code = (error as { code?: string }).code;
        const retryable = code === DEADLOCK_DETECTED || code === SERIALIZATION_FAILURE;
        if (!retryable || n >= MAX_ATTEMPTS) throw error;
        await new Promise((r) => setTimeout(r, 10 * n + Math.random() * 20));
      }
    }
  }
}

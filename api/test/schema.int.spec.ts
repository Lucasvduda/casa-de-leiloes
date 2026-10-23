import { mkdtempSync, writeFileSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_MIGRATIONS_DIR,
  runMigrations,
} from '../src/adapters/outbound/postgres/migrate.js';
import { createHarness, reais } from './support/harness.js';
import type { Harness } from './support/harness.js';
import { createTestDb } from './support/test-db.js';
import type { TestDb } from './support/test-db.js';
import type { Actor, LotRecord } from '../src/application/ports.js';

let db: TestDb;
let h: Harness;
let seller: Actor;
let bidder: Actor;
let lot: LotRecord;

beforeAll(async () => {
  db = await createTestDb();
  h = createHarness(db);
  seller = await h.seedUser('seller');
  bidder = await h.seedUser('bidder');
  await h.fund(bidder, reais(1_000));
  lot = await h.newLot(seller);
  await h.placeBid.execute({ actor: bidder, lotId: lot.id, amount: reais(100) });
});

afterAll(async () => {
  await db.close();
});

/** Roda SQL e devolve a mensagem do erro (ou null se passou). */
async function failure(sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.pool.query(sql, params);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

describe('migracoes', () => {
  it('reaplicar e idempotente: tudo "skipped"', async () => {
    const r = await runMigrations(db.pool);
    expect(r.applied).toEqual([]);
    expect(r.skipped).toContain('0001_init.sql');
  });

  it('recusa migracao editada depois de aplicada (checksum)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    try {
      for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR).filter((x) => x.endsWith('.sql'))) {
        copyFileSync(join(DEFAULT_MIGRATIONS_DIR, f), join(dir, f));
      }
      writeFileSync(join(dir, '0001_init.sql'), '-- editada\nSELECT 1;');
      await expect(runMigrations(db.pool, dir)).rejects.toThrow(/checksum/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migracao com erro faz rollback completo e nao registra', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    try {
      for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR).filter((x) => x.endsWith('.sql'))) {
        copyFileSync(join(DEFAULT_MIGRATIONS_DIR, f), join(dir, f));
      }
      writeFileSync(join(dir, '0002_quebrada.sql'), 'CREATE TABLE temp_ok (id int); SELECT 1/0;');
      await expect(runMigrations(db.pool, dir)).rejects.toThrow(/0002_quebrada/);
      expect(await failure('SELECT * FROM temp_ok')).toMatch(/does not exist|nao existe/i);
      const { rows } = await db.pool.query(
        `SELECT 1 FROM schema_migrations WHERE name = '0002_quebrada.sql'`,
      );
      expect(rows).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('carteira: CHECKs sao a ultima barreira', () => {
  it('nao deixa comprometer mais que o total', async () => {
    const msg = await failure(
      `UPDATE wallets SET committed_cents = total_cents + 1 WHERE user_id = $1`,
      [bidder.id],
    );
    expect(msg).toMatch(/wallets_committed_within_total/);
  });

  it('nao deixa saldo negativo', async () => {
    // total = comprometido = -1 satisfaz "comprometido <= total": so a CHECK de nao-negativo dispara.
    const msg = await failure(
      `UPDATE wallets SET total_cents = -1, committed_cents = -1 WHERE user_id = $1`,
      [seller.id],
    );
    expect(msg).toMatch(/wallets_non_negative/);
  });
});

describe('lances: somente insercao', () => {
  it('UPDATE em lance e bloqueado', async () => {
    expect(await failure(`UPDATE bids SET amount_cents = 1 WHERE lot_id = $1`, [lot.id])).toMatch(
      /somente de insercao/,
    );
  });
  it('DELETE em lance e bloqueado', async () => {
    expect(await failure(`DELETE FROM bids WHERE lot_id = $1`, [lot.id])).toMatch(
      /somente de insercao/,
    );
  });
  it('TRUNCATE em lances e bloqueado', async () => {
    expect(await failure(`TRUNCATE bids CASCADE`)).toMatch(/somente de insercao/);
  });
  it('seq duplicado no mesmo lote e rejeitado', async () => {
    const msg = await failure(
      `INSERT INTO bids (id, lot_id, seq, bidder_id, amount_cents, placed_at, prev_hash, hash)
       VALUES (gen_random_uuid(), $1, 1, $2, 1, now(), 'a', 'b')`,
      [lot.id, bidder.id],
    );
    expect(msg).toMatch(/bids_lot_seq_key/);
  });
  it('valor nao positivo e rejeitado', async () => {
    const msg = await failure(
      `INSERT INTO bids (id, lot_id, seq, bidder_id, amount_cents, placed_at, prev_hash, hash)
       VALUES (gen_random_uuid(), $1, 99, $2, 0, now(), 'a', 'b')`,
      [lot.id, bidder.id],
    );
    expect(msg).toMatch(/amount_cents/);
  });
});

describe('extrato e comprovantes: somente insercao', () => {
  it('UPDATE/DELETE/TRUNCATE no extrato sao bloqueados', async () => {
    expect(await failure(`UPDATE wallet_ledger SET amount_cents = 1`)).toMatch(
      /somente de insercao/,
    );
    expect(await failure(`DELETE FROM wallet_ledger`)).toMatch(/somente de insercao/);
    expect(await failure(`TRUNCATE wallet_ledger CASCADE`)).toMatch(/somente de insercao/);
  });
});

describe('lotes: termos imutaveis e estados', () => {
  it.each([
    ['lance inicial', `UPDATE lots SET starting_bid_cents = 1 WHERE id = $1`],
    ['incremento minimo', `UPDATE lots SET min_increment_cents = 1 WHERE id = $1`],
    ['dono do lote', `UPDATE lots SET seller_id = leader_id WHERE id = $1`],
    ['titulo', `UPDATE lots SET title = 'outro' WHERE id = $1`],
    ['item copiado', `UPDATE lots SET item = '{}'::jsonb WHERE id = $1`],
    ['inicio', `UPDATE lots SET starts_at = starts_at + interval '1 minute' WHERE id = $1`],
  ])('nao deixa alterar %s', async (_n, sql) => {
    expect(await failure(sql, [lot.id])).toMatch(/imutaveis/);
  });

  it('o fim do lote nao pode diminuir', async () => {
    expect(
      await failure(`UPDATE lots SET ends_at = ends_at - interval '1 minute' WHERE id = $1`, [
        lot.id,
      ]),
    ).toMatch(/nao pode diminuir/);
  });

  it('lote nao pode ser apagado', async () => {
    expect(await failure(`DELETE FROM lots WHERE id = $1`, [lot.id])).toMatch(
      /somente de insercao/,
    );
  });

  it('janela invalida (fim antes do inicio) e rejeitada', async () => {
    const msg = await failure(
      `INSERT INTO lots (id, seller_id, title, item, starting_bid_cents, min_increment_cents,
         starts_at, ends_at, head_hash, seal)
       VALUES (gen_random_uuid(), $1, 't', '{}', 1, 1, now(), now() - interval '1 hour', 'h', 's')`,
      [seller.id],
    );
    expect(msg).toMatch(/lots_window/);
  });

  it('lote com lider mas sem valor e rejeitado', async () => {
    const msg = await failure(
      `INSERT INTO lots (id, seller_id, title, item, starting_bid_cents, min_increment_cents,
         starts_at, ends_at, leader_id, bid_count, head_hash, seal)
       VALUES (gen_random_uuid(), $1, 't', '{}', 1, 1, now(), now() + interval '1 hour', $2, 1, 'h', 's')`,
      [seller.id, bidder.id],
    );
    expect(msg).toMatch(/lots_leader_consistent/);
  });

  it('lote encerrado nao muda de estado nem aceita lance (mesmo por SQL)', async () => {
    const other = await h.newLot(seller);
    await db.pool.query(`UPDATE lots SET status = 'closed' WHERE id = $1`, [other.id]);
    expect(await failure(`UPDATE lots SET status = 'open' WHERE id = $1`, [other.id])).toMatch(
      /nao pode mudar de estado/,
    );
    expect(await failure(`UPDATE lots SET status = 'cancelled' WHERE id = $1`, [other.id])).toMatch(
      /nao pode mudar de estado/,
    );
  });
});

describe('usuarios', () => {
  it('e-mail unico sem diferenciar maiusculas', async () => {
    await db.pool.query(
      `INSERT INTO users (id, email, display_name, password_hash, role)
       VALUES (gen_random_uuid(), 'Maria@Teste.com', 'Maria', 'x', 'bidder')`,
    );
    const msg = await failure(
      `INSERT INTO users (id, email, display_name, password_hash, role)
       VALUES (gen_random_uuid(), 'maria@teste.com', 'Outra', 'x', 'bidder')`,
    );
    expect(msg).toMatch(/users_email_lower_key/);
  });

  it('papel invalido e rejeitado', async () => {
    const msg = await failure(
      `INSERT INTO users (id, email, display_name, password_hash, role)
       VALUES (gen_random_uuid(), 'x@y.com', 'X', 'x', 'admin')`,
    );
    expect(msg).toMatch(/role/);
  });
});

describe('precisao de tempo', () => {
  it('o instante do lance volta do banco IDENTICO ao que entrou no hash (ms)', async () => {
    const { rows } = await db.pool.query<{ placed_at: Date }>(
      `SELECT placed_at FROM bids WHERE lot_id = $1 AND seq = 1`,
      [lot.id],
    );
    expect(rows[0]?.placed_at.toISOString()).toBe(h.clock.now().toISOString());
  });
});

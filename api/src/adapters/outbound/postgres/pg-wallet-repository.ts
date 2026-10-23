import type { LedgerEntry, LedgerKind, WalletRepository } from '../../../application/ports.js';
import { cents } from '../../../domain/money.js';
import type { Wallet } from '../../../domain/wallet.js';
import type { Queryable } from './pool.js';

interface LedgerRow {
  id: string;
  user_id: string;
  kind: LedgerKind;
  amount_cents: string;
  total_after_cents: string;
  committed_after_cents: string;
  lot_id: string | null;
  bid_id: string | null;
  idempotency_key: string | null;
}

const LEDGER_COLUMNS =
  'id, user_id, kind, amount_cents, total_after_cents, committed_after_cents, lot_id, bid_id, idempotency_key';

function mapLedger(row: LedgerRow): LedgerEntry & { id: number } {
  return {
    id: Number(row.id),
    userId: row.user_id,
    kind: row.kind,
    amount: cents(Number(row.amount_cents)),
    totalAfter: cents(Number(row.total_after_cents)),
    committedAfter: cents(Number(row.committed_after_cents)),
    lotId: row.lot_id,
    bidId: row.bid_id,
    idempotencyKey: row.idempotency_key,
  };
}

export class PgWalletRepository implements WalletRepository {
  constructor(private readonly db: Queryable) {}

  async lock(userId: string): Promise<Wallet> {
    await this.db.query(`INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [
      userId,
    ]);
    const { rows } = await this.db.query<{
      user_id: string;
      total_cents: string;
      committed_cents: string;
    }>(`SELECT user_id, total_cents, committed_cents FROM wallets WHERE user_id = $1 FOR UPDATE`, [
      userId,
    ]);
    const row = rows[0];
    if (row === undefined) throw new Error(`carteira nao encontrada: ${userId}`);
    return {
      userId: row.user_id,
      total: cents(Number(row.total_cents)),
      committed: cents(Number(row.committed_cents)),
    };
  }

  async save(wallet: Wallet): Promise<void> {
    await this.db.query(
      `UPDATE wallets SET total_cents = $2, committed_cents = $3 WHERE user_id = $1`,
      [wallet.userId, wallet.total, wallet.committed],
    );
  }

  async appendLedger(e: LedgerEntry): Promise<void> {
    await this.db.query(
      `INSERT INTO wallet_ledger (user_id, kind, amount_cents, total_after_cents,
         committed_after_cents, lot_id, bid_id, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        e.userId,
        e.kind,
        e.amount,
        e.totalAfter,
        e.committedAfter,
        e.lotId,
        e.bidId,
        e.idempotencyKey,
      ],
    );
  }

  async findLedgerByKey(userId: string, key: string): Promise<LedgerEntry | null> {
    const { rows } = await this.db.query<LedgerRow>(
      `SELECT ${LEDGER_COLUMNS} FROM wallet_ledger WHERE user_id = $1 AND idempotency_key = $2`,
      [userId, key],
    );
    return rows[0] === undefined ? null : mapLedger(rows[0]);
  }

  async ledgerByLot(lotId: string): Promise<(LedgerEntry & { id: number })[]> {
    const { rows } = await this.db.query<LedgerRow>(
      `SELECT ${LEDGER_COLUMNS} FROM wallet_ledger WHERE lot_id = $1 ORDER BY id`,
      [lotId],
    );
    return rows.map(mapLedger);
  }
}

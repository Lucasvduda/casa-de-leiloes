import type { ReceiptRepository, StoredReceipt } from '../../../application/ports.js';
import { cents } from '../../../domain/money.js';
import type { Queryable } from './pool.js';

const COLUMNS =
  'code, lot_id, winner_id, seller_id, amount_cents, bid_count, final_head_hash, issued_at, signature';

interface ReceiptRow {
  code: string;
  lot_id: string;
  winner_id: string;
  seller_id: string;
  amount_cents: string;
  bid_count: number;
  final_head_hash: string;
  issued_at: Date;
  signature: string;
}

function mapReceipt(row: ReceiptRow): StoredReceipt {
  return {
    code: row.code,
    lotId: row.lot_id,
    winnerId: row.winner_id,
    sellerId: row.seller_id,
    amount: cents(Number(row.amount_cents)),
    bidCount: row.bid_count,
    finalHeadHash: row.final_head_hash,
    issuedAt: row.issued_at,
    signature: row.signature,
  };
}

export class PgReceiptRepository implements ReceiptRepository {
  constructor(private readonly db: Queryable) {}

  async insert(r: StoredReceipt): Promise<void> {
    await this.db.query(`INSERT INTO receipts (${COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
      r.code,
      r.lotId,
      r.winnerId,
      r.sellerId,
      r.amount,
      r.bidCount,
      r.finalHeadHash,
      r.issuedAt,
      r.signature,
    ]);
  }

  async findByLot(lotId: string): Promise<StoredReceipt | null> {
    const { rows } = await this.db.query<ReceiptRow>(
      `SELECT ${COLUMNS} FROM receipts WHERE lot_id = $1`,
      [lotId],
    );
    return rows[0] === undefined ? null : mapReceipt(rows[0]);
  }

  async findByCode(code: string): Promise<StoredReceipt | null> {
    const { rows } = await this.db.query<ReceiptRow>(
      `SELECT ${COLUMNS} FROM receipts WHERE code = $1`,
      [code],
    );
    return rows[0] === undefined ? null : mapReceipt(rows[0]);
  }
}

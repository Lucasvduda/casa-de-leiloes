import type { BidRepository, StoredBid } from '../../../application/ports.js';
import { cents } from '../../../domain/money.js';
import type { Queryable } from './pool.js';

const COLUMNS =
  'id, lot_id, seq, bidder_id, amount_cents, placed_at, prev_hash, hash, idempotency_key';

interface BidRow {
  id: string;
  lot_id: string;
  seq: number;
  bidder_id: string;
  amount_cents: string;
  placed_at: Date;
  prev_hash: string;
  hash: string;
  idempotency_key: string | null;
}

function mapBid(row: BidRow): StoredBid {
  return {
    id: row.id,
    lotId: row.lot_id,
    seq: row.seq,
    bidderId: row.bidder_id,
    amount: cents(Number(row.amount_cents)),
    placedAt: row.placed_at,
    prevHash: row.prev_hash,
    hash: row.hash,
    idempotencyKey: row.idempotency_key,
  };
}

export class PgBidRepository implements BidRepository {
  constructor(private readonly db: Queryable) {}

  async last(lotId: string): Promise<StoredBid | null> {
    const { rows } = await this.db.query<BidRow>(
      `SELECT ${COLUMNS} FROM bids WHERE lot_id = $1 ORDER BY seq DESC LIMIT 1`,
      [lotId],
    );
    return rows[0] === undefined ? null : mapBid(rows[0]);
  }

  async insert(bid: StoredBid): Promise<void> {
    await this.db.query(`INSERT INTO bids (${COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
      bid.id,
      bid.lotId,
      bid.seq,
      bid.bidderId,
      bid.amount,
      bid.placedAt,
      bid.prevHash,
      bid.hash,
      bid.idempotencyKey,
    ]);
  }

  async listByLot(lotId: string): Promise<StoredBid[]> {
    const { rows } = await this.db.query<BidRow>(
      `SELECT ${COLUMNS} FROM bids WHERE lot_id = $1 ORDER BY seq`,
      [lotId],
    );
    return rows.map(mapBid);
  }

  async findByIdempotencyKey(bidderId: string, key: string): Promise<StoredBid | null> {
    const { rows } = await this.db.query<BidRow>(
      `SELECT ${COLUMNS} FROM bids WHERE bidder_id = $1 AND idempotency_key = $2`,
      [bidderId, key],
    );
    return rows[0] === undefined ? null : mapBid(rows[0]);
  }
}

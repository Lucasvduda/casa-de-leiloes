import type {
  BidApplied,
  ItemSnapshot,
  LotRecord,
  LotRepository,
} from '../../../application/ports.js';
import type { LotStatus } from '../../../domain/lot.js';
import { cents } from '../../../domain/money.js';
import type { Queryable } from './pool.js';

export const LOT_COLUMNS = `
  id, seller_id, title, item, starting_bid_cents, min_increment_cents, starts_at, ends_at, status,
  current_amount_cents, leader_id, bid_count, head_seq, head_hash, seal, extension_count,
  created_at, closed_at, cancelled_at`;

export interface LotRow {
  id: string;
  seller_id: string;
  title: string;
  item: ItemSnapshot;
  starting_bid_cents: string;
  min_increment_cents: string;
  starts_at: Date;
  ends_at: Date;
  status: LotStatus;
  current_amount_cents: string | null;
  leader_id: string | null;
  bid_count: number;
  head_seq: number;
  head_hash: string;
  seal: string;
  extension_count: number;
  created_at: Date;
  closed_at: Date | null;
  cancelled_at: Date | null;
}

export function mapLot(row: LotRow): LotRecord {
  return {
    id: row.id,
    sellerId: row.seller_id,
    title: row.title,
    item: row.item,
    startingBid: cents(Number(row.starting_bid_cents)),
    minIncrement: cents(Number(row.min_increment_cents)),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    currentAmount:
      row.current_amount_cents === null ? null : cents(Number(row.current_amount_cents)),
    leaderId: row.leader_id,
    bidCount: row.bid_count,
    seal: { headSeq: row.head_seq, headHash: row.head_hash, seal: row.seal },
    extensionCount: row.extension_count,
    createdAt: row.created_at,
    closedAt: row.closed_at,
    cancelledAt: row.cancelled_at,
  };
}

export class PgLotRepository implements LotRepository {
  constructor(private readonly db: Queryable) {}

  async lockById(id: string): Promise<LotRecord | null> {
    const { rows } = await this.db.query<LotRow>(
      `SELECT ${LOT_COLUMNS} FROM lots WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return rows[0] === undefined ? null : mapLot(rows[0]);
  }

  async findById(id: string): Promise<LotRecord | null> {
    const { rows } = await this.db.query<LotRow>(`SELECT ${LOT_COLUMNS} FROM lots WHERE id = $1`, [
      id,
    ]);
    return rows[0] === undefined ? null : mapLot(rows[0]);
  }

  async findDueIds(now: Date, limit: number): Promise<string[]> {
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT id FROM lots WHERE status = 'open' AND ends_at <= $1 ORDER BY ends_at LIMIT $2`,
      [now, limit],
    );
    return rows.map((r) => r.id);
  }

  async insert(lot: LotRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO lots (
         id, seller_id, title, item, starting_bid_cents, min_increment_cents, starts_at, ends_at,
         status, current_amount_cents, leader_id, bid_count, head_seq, head_hash, seal,
         extension_count, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        lot.id,
        lot.sellerId,
        lot.title,
        JSON.stringify(lot.item),
        lot.startingBid,
        lot.minIncrement,
        lot.startsAt,
        lot.endsAt,
        lot.status,
        lot.currentAmount,
        lot.leaderId,
        lot.bidCount,
        lot.seal.headSeq,
        lot.seal.headHash,
        lot.seal.seal,
        lot.extensionCount,
        lot.createdAt,
      ],
    );
  }

  async applyBid(u: BidApplied): Promise<void> {
    await this.db.query(
      `UPDATE lots SET current_amount_cents = $2, leader_id = $3, bid_count = $4,
         head_seq = $5, head_hash = $6, seal = $7, ends_at = $8, extension_count = $9
       WHERE id = $1`,
      [
        u.lotId,
        u.currentAmount,
        u.leaderId,
        u.bidCount,
        u.seal.headSeq,
        u.seal.headHash,
        u.seal.seal,
        u.endsAt,
        u.extensionCount,
      ],
    );
  }

  async markClosed(lotId: string, at: Date): Promise<void> {
    await this.db.query(`UPDATE lots SET status = 'closed', closed_at = $2 WHERE id = $1`, [
      lotId,
      at,
    ]);
  }

  async markCancelled(lotId: string, at: Date): Promise<void> {
    await this.db.query(`UPDATE lots SET status = 'cancelled', cancelled_at = $2 WHERE id = $1`, [
      lotId,
      at,
    ]);
  }
}

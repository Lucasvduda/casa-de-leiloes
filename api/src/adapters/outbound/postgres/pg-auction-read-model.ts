import type {
  AuctionReadModel,
  LedgerKind,
  LedgerView,
  LotListQuery,
  LotListRow,
  LotSort,
} from '../../../application/ports.js';
import { cents } from '../../../domain/money.js';
import type { Cents } from '../../../domain/money.js';
import { LOT_COLUMNS, mapLot } from './pg-lot-repository.js';
import type { LotRow } from './pg-lot-repository.js';
import type { Queryable } from './pool.js';

const LOT_COLUMNS_PREFIXED = LOT_COLUMNS.split(',')
  .map((column) => `l.${column.trim()}`)
  .join(', ');

/** `%` e `_` digitados pelo usuario viram texto literal: busca por "50%" nao pode casar tudo. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

const ORDER_BY: Record<LotSort, string> = {
  ending: 'l.ends_at ASC, l.id ASC',
  newest: 'l.created_at DESC, l.id ASC',
  price_asc: 'COALESCE(l.current_amount_cents, l.starting_bid_cents) ASC, l.id ASC',
  price_desc: 'COALESCE(l.current_amount_cents, l.starting_bid_cents) DESC, l.id ASC',
};

interface ListRow extends LotRow {
  seller_name: string;
  receipt_code: string | null;
  total: string;
}

interface LedgerRow {
  id: string;
  kind: LedgerKind;
  amount_cents: string;
  total_after_cents: string;
  committed_after_cents: string;
  lot_id: string | null;
  lot_title: string | null;
  created_at: Date;
}

export class PgAuctionReadModel implements AuctionReadModel {
  constructor(private readonly db: Queryable) {}

  async listLots(query: LotListQuery): Promise<{ rows: LotListRow[]; total: number }> {
    const params: unknown[] = [];
    const where: string[] = [];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    // Fase derivada do relogio: ao vivo em [inicio, fim), como no dominio (lotPhase).
    // O relogio so entra nos parametros quando a fase o usa (o Postgres nao infere o tipo
    // de um $n que nao aparece no SQL) e sempre com cast explicito.
    switch (query.phase) {
      case 'live': {
        const now = bind(query.now);
        where.push(
          `l.status = 'open' AND l.starts_at <= ${now}::timestamptz AND l.ends_at > ${now}::timestamptz`,
        );
        break;
      }
      case 'scheduled':
        where.push(`l.status = 'open' AND l.starts_at > ${bind(query.now)}::timestamptz`);
        break;
      case 'finished':
        where.push(
          `(l.status = 'closed' OR (l.status = 'open' AND l.ends_at <= ${bind(query.now)}::timestamptz))`,
        );
        break;
      case 'cancelled':
        where.push(`l.status = 'cancelled'`);
        break;
      case 'all':
        break;
    }
    if (query.search !== null) {
      const pattern = bind(`%${escapeLike(query.search)}%`);
      where.push(`(l.title ILIKE ${pattern} OR l.item->'attributes'->>'Artista' ILIKE ${pattern})`);
    }
    if (query.excludeCancelled === true) where.push(`l.status <> 'cancelled'`);
    if (query.sellerId !== undefined) where.push(`l.seller_id = ${bind(query.sellerId)}`);
    if (query.bidderId !== undefined) {
      where.push(
        `EXISTS (SELECT 1 FROM bids b WHERE b.lot_id = l.id AND b.bidder_id = ${bind(query.bidderId)})`,
      );
    }
    if (query.wonBy !== undefined) where.push(`r.winner_id = ${bind(query.wonBy)}`);

    const limit = bind(query.pageSize);
    const offset = bind((query.page - 1) * query.pageSize);
    const { rows } = await this.db.query<ListRow>(
      `SELECT ${LOT_COLUMNS_PREFIXED}, u.display_name AS seller_name, r.code AS receipt_code,
              count(*) OVER() AS total
         FROM lots l
         JOIN users u ON u.id = l.seller_id
         LEFT JOIN receipts r ON r.lot_id = l.id
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY ${ORDER_BY[query.sort]}
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    const first = rows[0];
    let total = first === undefined ? 0 : Number(first.total);
    if (first === undefined && query.page > 1) {
      // Pagina alem do fim: o total ainda precisa sair certo (a janela de contagem veio vazia).
      total = await this.countLots(query);
    }
    return {
      rows: rows.map((row) => ({
        lot: mapLot(row),
        sellerName: row.seller_name,
        receiptCode: row.receipt_code,
      })),
      total,
    };
  }

  private async countLots(query: LotListQuery): Promise<number> {
    const { total } = await this.listLots({ ...query, page: 1, pageSize: 1 });
    return total;
  }

  async walletSummary(userId: string): Promise<{ total: Cents; committed: Cents }> {
    const { rows } = await this.db.query<{ total_cents: string; committed_cents: string }>(
      `SELECT total_cents, committed_cents FROM wallets WHERE user_id = $1`,
      [userId],
    );
    const row = rows[0];
    return {
      total: cents(Number(row?.total_cents ?? 0)),
      committed: cents(Number(row?.committed_cents ?? 0)),
    };
  }

  async ledger(userId: string, limit: number, beforeId: number | null): Promise<LedgerView[]> {
    const { rows } = await this.db.query<LedgerRow>(
      `SELECT e.id, e.kind, e.amount_cents, e.total_after_cents, e.committed_after_cents,
              e.lot_id, l.title AS lot_title, e.created_at
         FROM wallet_ledger e
         LEFT JOIN lots l ON l.id = e.lot_id
        WHERE e.user_id = $1 AND ($2::bigint IS NULL OR e.id < $2)
        ORDER BY e.id DESC
        LIMIT $3`,
      [userId, beforeId, limit],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      kind: row.kind,
      amount: cents(Number(row.amount_cents)),
      totalAfter: cents(Number(row.total_after_cents)),
      committedAfter: cents(Number(row.committed_after_cents)),
      lotId: row.lot_id,
      lotTitle: row.lot_title,
      createdAt: row.created_at,
    }));
  }

  async sellerTotals(sellerId: string): Promise<{ received: Cents; soldCount: number }> {
    const { rows } = await this.db.query<{ received: string; sold: string }>(
      `SELECT COALESCE(SUM(amount_cents), 0) AS received, count(*) AS sold
         FROM receipts WHERE seller_id = $1`,
      [sellerId],
    );
    return {
      received: cents(Number(rows[0]?.received ?? 0)),
      soldCount: Number(rows[0]?.sold ?? 0),
    };
  }
}

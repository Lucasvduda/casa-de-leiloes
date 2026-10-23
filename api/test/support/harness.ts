import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { MAX_SINGLE_DEPOSIT_CENTS } from '../../src/domain/wallet.js';
import { cryptoIds, createMac } from '../../src/adapters/outbound/system.js';
import { AuditLot } from '../../src/application/usecases/audit-lot.js';
import { CancelLot } from '../../src/application/usecases/cancel-lot.js';
import { CreateLot } from '../../src/application/usecases/create-lot.js';
import { Deposit } from '../../src/application/usecases/deposit.js';
import { PlaceBid } from '../../src/application/usecases/place-bid.js';
import { SettleLot } from '../../src/application/usecases/settle-lot.js';
import type {
  Actor,
  AuctionEvent,
  Clock,
  EventPublisher,
  LotRecord,
  Role,
} from '../../src/application/ports.js';
import type { TestDb } from './test-db.js';

export const SECRET = 'segredo-de-teste-0123456789abcdef0123456789';

export class FakeClock implements Clock {
  private current: Date;
  constructor(start = new Date('2026-11-01T12:00:00.000Z')) {
    this.current = start;
  }
  now(): Date {
    return new Date(this.current);
  }
  set(date: Date): void {
    this.current = date;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class RecordingBus implements EventPublisher {
  readonly events: AuctionEvent[] = [];
  publish(event: AuctionEvent): void {
    this.events.push(event);
  }
  ofType<T extends AuctionEvent['type']>(type: T) {
    return this.events.filter((e): e is Extract<AuctionEvent, { type: T }> => e.type === type);
  }
}

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const reais = (n: number): number => n * 100;

export function createHarness(db: TestDb, clock = new FakeClock()) {
  const mac = createMac(SECRET);
  const events = new RecordingBus();
  const base = { uow: db.uow, clock, mac, ids: cryptoIds, events };

  const placeBid = new PlaceBid(base);
  const createLot = new CreateLot(base);
  /** Com estorno ao lider (opcao ALLOW_CANCEL_WITH_BIDS ligada). */
  const cancelLot = new CancelLot({ ...base, allowCancelWithBids: true });
  /** Padrao de producao: lote com lances nao pode ser cancelado. */
  const strictCancelLot = new CancelLot(base);
  const settleLot = new SettleLot(base);
  const deposit = new Deposit({ uow: db.uow });
  const audit = new AuditLot({ uow: db.uow, mac });

  async function seedUser(role: Role, label: string = role): Promise<Actor> {
    const id = randomUUID();
    await db.pool.query(
      `INSERT INTO users (id, email, display_name, password_hash, role) VALUES ($1,$2,$3,'x',$4)`,
      [id, `${label}-${id}@teste.local`, `${label} ${id.slice(0, 4)}`, role],
    );
    await db.pool.query(`INSERT INTO wallets (user_id) VALUES ($1)`, [id]);
    return { id, role };
  }

  /** Credita saldo pelo caso de uso real (gera extrato), em depositos dentro do teto por operacao. */
  async function fund(actor: Actor, amountCents: number): Promise<void> {
    let remaining = amountCents;
    while (remaining > 0) {
      const chunk = Math.min(remaining, MAX_SINGLE_DEPOSIT_CENTS);
      await deposit.execute(actor, { amount: chunk });
      remaining -= chunk;
    }
  }

  const item = (title = 'Obra de teste') => ({
    source: 'artic',
    sourceId: '1234',
    sourceUrl: 'https://www.artic.edu/artworks/1234',
    title,
    imageUrl: 'https://www.artic.edu/iiif/2/abc/full/843,/0/default.jpg',
    attributes: { artista: 'Fulano', tecnica: 'Oleo sobre tela' },
  });

  /**
   * Cria um lote pelo caso de uso real. Por padrao ja nasce ao vivo: comeca agora, dura 1h.
   * (O inicio e inclusivo, entao `startsAt == now` ja esta ao vivo.)
   */
  async function newLot(
    seller: Actor,
    o: {
      startingBid?: number;
      minIncrement?: number;
      startInMs?: number;
      durationMs?: number;
    } = {},
  ): Promise<LotRecord> {
    const now = clock.now().getTime();
    const startsAt = new Date(now + (o.startInMs ?? 0));
    const endsAt = new Date(startsAt.getTime() + (o.durationMs ?? HOUR));
    return createLot.execute({
      actor: seller,
      input: {
        item: item(),
        startingBid: o.startingBid ?? reais(100),
        minIncrement: o.minIncrement ?? reais(5),
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
      },
    });
  }

  async function walletOf(userId: string) {
    const { rows } = await db.pool.query<{ total_cents: string; committed_cents: string }>(
      `SELECT total_cents, committed_cents FROM wallets WHERE user_id = $1`,
      [userId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('carteira inexistente');
    const total = Number(row.total_cents);
    const committed = Number(row.committed_cents);
    return { total, committed, available: total - committed };
  }

  async function lotRow(lotId: string) {
    const { rows } = await db.pool.query(`SELECT * FROM lots WHERE id = $1`, [lotId]);
    return rows[0] as Record<string, unknown>;
  }

  /**
   * Invariantes que valem em QUALQUER estado, depois de QUALQUER cenario.
   * Se um bug de concorrencia criar ou perder dinheiro, uma delas quebra.
   */
  async function assertInvariants(opts: { expectIntactChains?: boolean } = {}): Promise<void> {
    const q = async <R extends Record<string, unknown>>(sql: string) =>
      (await db.pool.query<R>(sql)).rows;

    // A) comprometido == soma dos lances que a pessoa lidera em lotes ABERTOS
    const a = await q<{ user_id: string; committed: string; expected: string }>(`
      SELECT w.user_id, w.committed_cents AS committed,
             COALESCE((SELECT SUM(l.current_amount_cents) FROM lots l
                       WHERE l.status = 'open' AND l.leader_id = w.user_id), 0) AS expected
      FROM wallets w`);
    for (const r of a) {
      expect(Number(r.committed), `comprometido de ${r.user_id}`).toBe(Number(r.expected));
    }

    // B) total == depositos - debitos + creditos (reconstruido so pelo extrato)
    const b = await q<{ user_id: string; total: string; expected: string }>(`
      SELECT w.user_id, w.total_cents AS total,
             COALESCE((SELECT SUM(CASE e.kind
                         WHEN 'deposit' THEN e.amount_cents
                         WHEN 'settle_credit' THEN e.amount_cents
                         WHEN 'settle_debit' THEN -e.amount_cents
                         ELSE 0 END)
                       FROM wallet_ledger e WHERE e.user_id = w.user_id), 0) AS expected
      FROM wallets w`);
    for (const r of b) {
      expect(Number(r.total), `total de ${r.user_id}`).toBe(Number(r.expected));
    }

    // C) conservacao: nenhum centavo nasce ou some alem dos depositos
    const [c] = await q<{ total: string; deposits: string }>(`
      SELECT (SELECT COALESCE(SUM(total_cents), 0) FROM wallets) AS total,
             (SELECT COALESCE(SUM(amount_cents), 0) FROM wallet_ledger WHERE kind = 'deposit') AS deposits`);
    expect(Number(c?.total), 'soma dos saldos == soma dos depositos').toBe(Number(c?.deposits));

    // D) ultima linha do extrato de cada pessoa == estado atual da carteira
    const d = await q<{ user_id: string; t: string; c: string; wt: string; wc: string }>(`
      SELECT w.user_id, e.total_after_cents AS t, e.committed_after_cents AS c,
             w.total_cents AS wt, w.committed_cents AS wc
      FROM wallets w
      JOIN LATERAL (SELECT * FROM wallet_ledger WHERE user_id = w.user_id ORDER BY id DESC LIMIT 1) e ON true`);
    for (const r of d) {
      expect(Number(r.t), `total_after de ${r.user_id}`).toBe(Number(r.wt));
      expect(Number(r.c), `committed_after de ${r.user_id}`).toBe(Number(r.wc));
    }

    // E) seq contiguo e toda cadeia integra
    if (opts.expectIntactChains !== false) {
      const lots = await q<{ id: string }>(`SELECT id FROM lots`);
      for (const { id } of lots) {
        const report = await audit.execute(id);
        expect(report.integrity.issues, `auditoria do lote ${id}`).toEqual([]);
      }
    }
  }

  return {
    base,
    mac,
    clock,
    events,
    placeBid,
    createLot,
    cancelLot,
    strictCancelLot,
    settleLot,
    /** Outra instancia (simula outro processo): nao compartilha o single-flight, so o banco. */
    newSettleLot: () => new SettleLot(base),
    deposit,
    audit,
    seedUser,
    fund,
    newLot,
    walletOf,
    lotRow,
    assertInvariants,
    item,
  };
}

export type Harness = ReturnType<typeof createHarness>;

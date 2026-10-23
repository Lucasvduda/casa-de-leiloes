import { verifyChain } from '../../domain/hash-chain.js';
import type { ChainIssue, Mac } from '../../domain/hash-chain.js';
import type { LotStatus } from '../../domain/lot.js';
import type { Cents } from '../../domain/money.js';
import { publicBidderRef } from '../../domain/public-bidder-ref.js';
import { verifyReceiptSignature } from '../../domain/receipt.js';
import { NotFoundError } from '../errors.js';
import { lotTermsOf } from '../integrity.js';
import type { UnitOfWork } from '../ports.js';
import { assertLotId } from '../validation.js';

export type AuditIssueCode =
  | ChainIssue['code']
  | 'SUMMARY_MISMATCH'
  | 'LEDGER_MISMATCH'
  | 'RECEIPT_MISSING'
  | 'RECEIPT_MISMATCH';

export interface AuditIssue {
  readonly code: AuditIssueCode;
  readonly seq?: number;
}

export interface AuditReport {
  readonly lot: {
    readonly id: string;
    readonly title: string;
    readonly imageUrl: string | null;
    readonly status: LotStatus;
    readonly startingBid: Cents;
    readonly minIncrement: Cents;
    readonly startsAt: Date;
    readonly endsAt: Date;
  };
  readonly bidCount: number;
  /** Hash do ultimo lance: qualquer pessoa pode anota-lo e conferir depois que nada mudou. */
  readonly headHash: string;
  readonly bids: readonly {
    readonly seq: number;
    /** Referencia anonima, estavel dentro do lote. Nunca nome, e-mail ou id interno. */
    readonly bidder: string;
    readonly amount: Cents;
    readonly placedAt: Date;
    readonly prevHash: string;
    readonly hash: string;
  }[];
  readonly integrity: { readonly intact: boolean; readonly issues: readonly AuditIssue[] };
  readonly receipt: {
    readonly code: string;
    readonly amount: Cents;
    readonly issuedAt: Date;
    readonly winner: string;
    readonly signatureValid: boolean;
  } | null;
}

/**
 * Auditoria PUBLICA (sem login) do historico de um lote.
 *
 * Alem da cadeia de HMAC (edicao, remocao, insercao, truncamento, selo), cruza tres fontes
 * independentes: o resumo do lote (lider/valor/contagem), o extrato da carteira (cada lance deve
 * ter exatamente um "hold" correspondente) e o comprovante (assinado, amarrado ao hash final).
 * Uma adulteracao precisa enganar TODAS ao mesmo tempo, sem a chave do servidor.
 */
export class AuditLot {
  constructor(private readonly deps: { uow: UnitOfWork; mac: Mac }) {}

  async execute(rawLotId: string): Promise<AuditReport> {
    const lotId = assertLotId(rawLotId);
    const { mac } = this.deps;
    const data = await this.deps.uow.readSnapshot(async (repos) => {
      const lot = await repos.lots.findById(lotId);
      if (lot === null) throw new NotFoundError('LOT_NOT_FOUND', 'Lote nao encontrado.');
      // Sequencial de proposito: uma transacao e uma unica conexao, que executa uma consulta por vez.
      const bids = await repos.bids.listByLot(lotId);
      const ledger = await repos.wallets.ledgerByLot(lotId);
      const receipt = await repos.receipts.findByLot(lotId);
      return { lot, bids, ledger, receipt };
    });
    const { lot, bids, ledger, receipt } = data;

    const issues: AuditIssue[] = [...verifyChain(mac, lotTermsOf(lot), bids, lot.seal).issues];
    const ordered = [...bids].sort((a, b) => a.seq - b.seq);
    const last = ordered[ordered.length - 1] ?? null;

    // 1) Resumo do lote precisa bater com o que a cadeia diz.
    const expectedAmount = last?.amount ?? null;
    const expectedLeader = last?.bidderId ?? null;
    if (
      lot.currentAmount !== expectedAmount ||
      lot.leaderId !== expectedLeader ||
      lot.bidCount !== ordered.length
    ) {
      issues.push({ code: 'SUMMARY_MISMATCH' });
    }

    // 2) Extrato: cada lance tem exatamente um "hold" (mesmo usuario, mesmo valor), sem sobras.
    const holds = ledger.filter((e) => e.kind === 'hold');
    const holdByBid = new Map<string, (typeof holds)[number][]>();
    for (const h of holds) {
      if (h.bidId === null) continue;
      holdByBid.set(h.bidId, [...(holdByBid.get(h.bidId) ?? []), h]);
    }
    const knownBidIds = new Set(ordered.map((b) => b.id));
    for (const bid of ordered) {
      const entries = holdByBid.get(bid.id) ?? [];
      const ok =
        entries.length === 1 &&
        entries[0]?.userId === bid.bidderId &&
        entries[0]?.amount === bid.amount;
      if (!ok) issues.push({ code: 'LEDGER_MISMATCH', seq: bid.seq });
    }
    const orphanHolds = holds.filter((h) => h.bidId === null || !knownBidIds.has(h.bidId));
    if (orphanHolds.length > 0) issues.push({ code: 'LEDGER_MISMATCH' });

    // 3) Comprovante: assinado, e amarrado ao resultado e ao hash final da cadeia.
    let receiptView: AuditReport['receipt'] = null;
    if (lot.status === 'closed' && ordered.length > 0) {
      if (receipt === null) {
        issues.push({ code: 'RECEIPT_MISSING' });
      } else {
        const signatureValid = verifyReceiptSignature(mac, receipt, receipt.signature);
        const matchesChain =
          last !== null &&
          receipt.finalHeadHash === last.hash &&
          receipt.bidCount === ordered.length &&
          receipt.amount === last.amount &&
          receipt.winnerId === last.bidderId &&
          receipt.sellerId === lot.sellerId;
        if (!signatureValid || !matchesChain) issues.push({ code: 'RECEIPT_MISMATCH' });
        receiptView = {
          code: receipt.code,
          amount: receipt.amount,
          issuedAt: receipt.issuedAt,
          winner: publicBidderRef(mac, receipt.winnerId, lot.id),
          signatureValid,
        };
      }
    } else if (receipt !== null) {
      issues.push({ code: 'RECEIPT_MISMATCH' });
    }

    return {
      lot: {
        id: lot.id,
        title: lot.title,
        imageUrl: lot.item.imageUrl,
        status: lot.status,
        startingBid: lot.startingBid,
        minIncrement: lot.minIncrement,
        startsAt: lot.startsAt,
        endsAt: lot.endsAt,
      },
      bidCount: ordered.length,
      headHash: last?.hash ?? lot.seal.headHash,
      bids: ordered.map((b) => ({
        seq: b.seq,
        bidder: publicBidderRef(mac, b.bidderId, lot.id),
        amount: b.amount,
        placedAt: b.placedAt,
        prevHash: b.prevHash,
        hash: b.hash,
      })),
      integrity: { intact: issues.length === 0, issues },
      receipt: receiptView,
    };
  }
}

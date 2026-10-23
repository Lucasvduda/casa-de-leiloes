import { Router } from 'express';
import { z } from 'zod';
import type { BidRejectionReason } from '../../../../domain/bid-policy.js';
import type { Catalog } from '../../../../application/ports.js';
import type { AuctionQueries } from '../../../../application/usecases/auction-queries.js';
import type { AuditLot } from '../../../../application/usecases/audit-lot.js';
import type { CancelLot } from '../../../../application/usecases/cancel-lot.js';
import type { CreateLot } from '../../../../application/usecases/create-lot.js';
import type { PlaceBid } from '../../../../application/usecases/place-bid.js';
import { parseWith } from '../../../../application/validation.js';
import { HttpError } from '../http-error.js';
import type { RateLimiters } from '../middlewares/rate-limits.js';
import { requireRole } from '../middlewares/session.js';

/** Mensagens para quem consome a API por fora; a tela traduz pelo `code`. */
const BID_REJECTION_MESSAGES: Record<BidRejectionReason, string> = {
  LOT_CANCELLED: 'Este lote foi cancelado pelo leiloeiro.',
  LOT_NOT_STARTED: 'Este lote ainda nao comecou.',
  LOT_ENDED: 'Este lote ja encerrou.',
  SELLER_CANNOT_BID: 'Leiloeiros nao dao lances.',
  ALREADY_LEADING: 'Voce ja esta liderando este lote.',
  BELOW_MINIMUM: 'O lance esta abaixo do minimo exigido.',
  INSUFFICIENT_FUNDS: 'Saldo disponivel insuficiente para este lance.',
};

/** `sourceId` entra no caminho da URL do catalogo externo: so caracteres inofensivos. */
const createLotRequestSchema = z.object({
  sourceId: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/, 'identificador de item invalido'),
});

export function lotsRoutes(deps: {
  queries: AuctionQueries;
  placeBid: PlaceBid;
  createLot: CreateLot;
  cancelLot: CancelLot;
  audit: AuditLot;
  catalog: Catalog;
  limiters: RateLimiters;
}): Router {
  const { queries, placeBid, createLot, cancelLot, audit, catalog, limiters } = deps;
  const router = Router();

  router.get('/lots', async (req, res) => {
    res.json(await queries.listLots(req.auth?.actor ?? null, req.query));
  });

  router.get('/lots/:id', async (req, res) => {
    res.json({ lot: await queries.getLot(req.auth?.actor ?? null, String(req.params.id)) });
  });

  /** Publica, sem login: qualquer pessoa confere a cadeia de lances e o comprovante. */
  router.get('/lots/:id/audit', async (req, res) => {
    res.json(await audit.execute(String(req.params.id)));
  });

  router.post('/lots', requireRole('seller'), limiters.write, async (req, res) => {
    const { sourceId } = parseWith(createLotRequestSchema, req.body);
    // O item vem do SERVIDOR (catalogo), nunca do corpo: o cliente nao forja titulo, imagem ou atributos.
    const item = await catalog.getItem(sourceId);
    const lot = await createLot.execute({
      actor: req.auth!.actor,
      input: { ...(req.body as Record<string, unknown>), item },
    });
    res
      .status(201)
      .location(`/api/lots/${lot.id}`)
      .json({
        lot: await queries.getLot(req.auth!.actor, lot.id),
      });
  });

  router.post('/lots/:id/cancel', requireRole('seller'), limiters.write, async (req, res) => {
    const result = await cancelLot.execute(req.auth!.actor, String(req.params.id));
    if (!result.cancelled) {
      throw new HttpError(
        409,
        result.reason,
        'O lote ja encerrou e foi liquidado; nao pode mais ser cancelado.',
      );
    }
    res.json({ cancelled: true, refunded: result.refunded });
  });

  router.post('/lots/:id/bids', requireRole('bidder'), limiters.bid, async (req, res) => {
    const result = await placeBid.execute({
      actor: req.auth!.actor,
      lotId: String(req.params.id),
      amount: (req.body as { amount?: unknown } | undefined)?.amount,
      idempotencyKey: req.get('idempotency-key'),
    });
    if (!result.accepted) {
      const details: Record<string, unknown> = {};
      if (result.minimumRequired !== undefined) details.minimumRequired = result.minimumRequired;
      if (result.available !== undefined) details.available = result.available;
      throw new HttpError(409, result.reason, BID_REJECTION_MESSAGES[result.reason], details);
    }
    // 201 no lance novo; 200 quando e a repeticao (mesma Idempotency-Key): nada novo foi gravado.
    res.status(result.replayed ? 200 : 201).json({
      replayed: result.replayed,
      bid: { seq: result.bid.seq, amount: result.bid.amount, placedAt: result.bid.placedAt },
      endsAt: result.endsAt,
      extended: result.extended,
      bidCount: result.bidCount,
    });
  });

  return router;
}

import { Router } from 'express';
import { z } from 'zod';
import type { Catalog } from '../../../../application/ports.js';
import type { AuctionQueries } from '../../../../application/usecases/auction-queries.js';
import type { Deposit } from '../../../../application/usecases/deposit.js';
import { parseWith } from '../../../../application/validation.js';
import type { RateLimiters } from '../middlewares/rate-limits.js';
import { requireAuth, requireRole } from '../middlewares/session.js';

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

const catalogQuerySchema = z.object({
  q: z
    .string()
    .transform((s) => s.replace(CONTROL_CHARS, ' ').trim())
    .pipe(z.string().max(100))
    .optional()
    .transform((s) => s ?? ''),
  page: z.coerce.number().int().min(1).max(100).default(1),
});

/** Carteira, paineis da pessoa logada, comprovante publico e busca do catalogo (leiloeiro). */
export function accountRoutes(deps: {
  queries: AuctionQueries;
  deposit: Deposit;
  catalog: Catalog;
  limiters: RateLimiters;
}): Router {
  const { queries, deposit, catalog, limiters } = deps;
  const router = Router();

  router.get('/wallet', requireAuth, async (req, res) => {
    res.json(await queries.wallet(req.auth!.actor, req.query));
  });

  router.post('/wallet/deposits', requireRole('bidder'), limiters.deposit, async (req, res) => {
    const result = await deposit.execute(req.auth!.actor, {
      amount: (req.body as { amount?: unknown } | undefined)?.amount,
      idempotencyKey: req.get('idempotency-key'),
    });
    res.status(result.replayed ? 200 : 201).json(result);
  });

  router.get('/me/lots', requireRole('seller'), async (req, res) => {
    res.json(await queries.myLots(req.auth!.actor, req.query));
  });

  router.get('/me/bids', requireRole('bidder'), async (req, res) => {
    res.json(await queries.myBids(req.auth!.actor, req.query));
  });

  router.get('/me/wins', requireRole('bidder'), async (req, res) => {
    res.json(await queries.myWins(req.auth!.actor, req.query));
  });

  /** Publico: o codigo do comprovante (128 bits) e o segredo do link. */
  router.get('/receipts/:code', async (req, res) => {
    res.json({ receipt: await queries.receipt(String(req.params.code)) });
  });

  router.get('/catalog/search', requireRole('seller'), limiters.catalog, async (req, res) => {
    const { q, page } = parseWith(catalogQuerySchema, req.query);
    res.json(await catalog.search(q, page));
  });

  return router;
}

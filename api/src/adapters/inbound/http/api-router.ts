import cookieParser from 'cookie-parser';
import { Router } from 'express';
import type { Catalog } from '../../../application/ports.js';
import type { AuctionQueries } from '../../../application/usecases/auction-queries.js';
import type { AuditLot } from '../../../application/usecases/audit-lot.js';
import type { AuthService } from '../../../application/usecases/auth.js';
import type { CancelLot } from '../../../application/usecases/cancel-lot.js';
import type { CreateLot } from '../../../application/usecases/create-lot.js';
import type { Deposit } from '../../../application/usecases/deposit.js';
import type { PlaceBid } from '../../../application/usecases/place-bid.js';
import { mutationGuard } from './middlewares/mutation-guard.js';
import { DEFAULT_RATE_LIMITS, createRateLimiters } from './middlewares/rate-limits.js';
import type { RateLimitRules } from './middlewares/rate-limits.js';
import { loadSession } from './middlewares/session.js';
import type { CookieSettings } from './middlewares/session.js';
import { accountRoutes } from './routes/account-routes.js';
import { authRoutes } from './routes/auth-routes.js';
import { lotsRoutes } from './routes/lots-routes.js';

export interface ApiDeps {
  readonly auth: AuthService;
  readonly cookie: CookieSettings;
  readonly rateLimits?: RateLimitRules;
  readonly queries: AuctionQueries;
  readonly placeBid: PlaceBid;
  readonly createLot: CreateLot;
  readonly cancelLot: CancelLot;
  readonly deposit: Deposit;
  readonly audit: AuditLot;
  readonly catalog: Catalog;
}

/**
 * Tudo que mora sob /api. Ordem importa:
 * limite por IP -> cookies -> sessao -> guarda de escrita (CSRF) -> rotas.
 */
export function createApiRouter(deps: ApiDeps): Router {
  const limiters = createRateLimiters(deps.rateLimits ?? DEFAULT_RATE_LIMITS);
  const router = Router();

  // Respostas da API carregam dado de sessao ou de saldo: nada de cache em proxy ou navegador.
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.use(limiters.api);
  router.use(cookieParser());
  router.use(loadSession(deps.auth, deps.cookie));
  router.use(mutationGuard());

  router.use(authRoutes({ auth: deps.auth, cookie: deps.cookie, limiters }));
  router.use(
    lotsRoutes({
      queries: deps.queries,
      placeBid: deps.placeBid,
      createLot: deps.createLot,
      cancelLot: deps.cancelLot,
      audit: deps.audit,
      catalog: deps.catalog,
      limiters,
    }),
  );
  router.use(
    accountRoutes({
      queries: deps.queries,
      deposit: deps.deposit,
      catalog: deps.catalog,
      limiters,
    }),
  );

  return router;
}

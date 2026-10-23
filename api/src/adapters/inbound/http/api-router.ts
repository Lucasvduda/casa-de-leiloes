import cookieParser from 'cookie-parser';
import { Router } from 'express';
import type { AuthService } from '../../../application/usecases/auth.js';
import { mutationGuard } from './middlewares/mutation-guard.js';
import { DEFAULT_RATE_LIMITS, createRateLimiters } from './middlewares/rate-limits.js';
import type { RateLimitRules } from './middlewares/rate-limits.js';
import { loadSession } from './middlewares/session.js';
import type { CookieSettings } from './middlewares/session.js';
import { authRoutes } from './routes/auth-routes.js';

export interface ApiDeps {
  readonly auth: AuthService;
  readonly cookie: CookieSettings;
  readonly rateLimits?: RateLimitRules;
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

  return router;
}

import { Router } from 'express';
import type { AuthService } from '../../../../application/usecases/auth.js';
import type { RateLimiters } from '../middlewares/rate-limits.js';
import { clearSessionCookie, requireAuth, sessionCookieOptions } from '../middlewares/session.js';
import type { CookieSettings } from '../middlewares/session.js';

export function authRoutes(deps: {
  auth: AuthService;
  cookie: CookieSettings;
  limiters: RateLimiters;
}): Router {
  const { auth, cookie, limiters } = deps;
  const router = Router();

  router.post('/auth/register', limiters.register, async (req, res) => {
    const result = await auth.register(req.body);
    res.cookie(cookie.name, result.token, sessionCookieOptions(cookie));
    res.status(201).json({ user: result.user, csrfToken: result.csrfToken });
  });

  router.post('/auth/login', limiters.loginPerIp, limiters.loginPerAccount, async (req, res) => {
    const result = await auth.login(req.body);
    res.cookie(cookie.name, result.token, sessionCookieOptions(cookie));
    res.json({ user: result.user, csrfToken: result.csrfToken });
  });

  /** Idempotente: sair sem sessao tambem e sucesso. Invalida o token NO SERVIDOR. */
  router.post('/auth/logout', async (req, res) => {
    const token: unknown = req.cookies?.[cookie.name];
    await auth.logout(token);
    clearSessionCookie(res, cookie);
    res.status(204).end();
  });

  router.get('/auth/me', requireAuth, (req, res) => {
    // `requireAuth` garante `req.auth`; o `!` documenta essa garantia.
    const session = req.auth!;
    res.json({ user: session.user, csrfToken: session.csrfToken });
  });

  return router;
}

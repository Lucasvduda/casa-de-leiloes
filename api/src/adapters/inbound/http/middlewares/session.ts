import type { CookieOptions, NextFunction, Request, RequestHandler, Response } from 'express';
import type { AuthService, ResolvedSession } from '../../../../application/usecases/auth.js';
import { HttpError } from '../http-error.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Presente so quando o cookie de sessao e valido. Preenchido por `loadSession`. */
    auth?: ResolvedSession;
  }
}

export interface CookieSettings {
  readonly name: string;
  /** Em producao (HTTPS) o cookie so trafega por conexao segura. */
  readonly secure: boolean;
  readonly maxAgeMs: number;
}

/**
 * httpOnly: JavaScript da pagina nao le o cookie (XSS nao rouba a sessao).
 * SameSite=Lax: o navegador nao envia o cookie em POST vindo de outro site.
 */
export function sessionCookieOptions(settings: CookieSettings): CookieOptions {
  return {
    httpOnly: true,
    secure: settings.secure,
    sameSite: 'lax',
    path: '/',
    maxAge: settings.maxAgeMs,
  };
}

export function clearSessionCookie(res: Response, settings: CookieSettings): void {
  // clearCookie precisa dos MESMOS atributos do cookie original (path, secure, sameSite), sem maxAge.
  const options = sessionCookieOptions(settings);
  delete options.maxAge;
  res.clearCookie(settings.name, options);
}

/** Resolve a sessao a cada requisicao. Cookie invalido ou vencido e limpo e tratado como anonimo. */
export function loadSession(auth: AuthService, settings: CookieSettings): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token: unknown = req.cookies?.[settings.name];
    if (token === undefined) {
      next();
      return;
    }
    const session = await auth.resolve(token);
    if (session === null) {
      clearSessionCookie(res, settings);
    } else {
      req.auth = session;
    }
    next();
  };
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (req.auth === undefined) {
    next(new HttpError(401, 'UNAUTHENTICATED', 'Entre na sua conta para continuar.'));
    return;
  }
  next();
}

/** 403 (e nao 404): a rota existe e e publica, o que falta e o papel certo. */
export function requireRole(role: 'seller' | 'bidder'): RequestHandler {
  return (req, _res, next) => {
    if (req.auth === undefined) {
      next(new HttpError(401, 'UNAUTHENTICATED', 'Entre na sua conta para continuar.'));
      return;
    }
    if (req.auth.actor.role !== role) {
      const who = role === 'seller' ? 'leiloeiros' : 'licitantes';
      next(new HttpError(403, 'FORBIDDEN_ROLE', `Esta acao e exclusiva para ${who}.`));
      return;
    }
    next();
  };
}

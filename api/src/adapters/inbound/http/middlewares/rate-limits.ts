import { createHash } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';

export interface LimitRule {
  readonly windowMs: number;
  readonly limit: number;
}

export interface RateLimitRules {
  /** Todas as rotas /api, por IP. Teto generoso: so barra varredura e abuso grosseiro. */
  readonly api: LimitRule;
  /** Tentativas de login que FALHARAM, por IP + e-mail (freia forca bruta em uma conta). */
  readonly loginFailuresPerAccount: LimitRule;
  /** Tentativas de login que FALHARAM, por IP (freia varredura de varias contas). */
  readonly loginFailuresPerIp: LimitRule;
  readonly register: LimitRule;
  /** Por usuario logado. */
  readonly bid: LimitRule;
  readonly deposit: LimitRule;
  readonly catalog: LimitRule;
  readonly write: LimitRule;
}

const MIN = 60_000;

export const DEFAULT_RATE_LIMITS: RateLimitRules = {
  api: { windowMs: MIN, limit: 600 },
  loginFailuresPerAccount: { windowMs: 15 * MIN, limit: 8 },
  loginFailuresPerIp: { windowMs: 15 * MIN, limit: 40 },
  register: { windowMs: 60 * MIN, limit: 20 },
  bid: { windowMs: MIN, limit: 60 },
  deposit: { windowMs: MIN, limit: 20 },
  catalog: { windowMs: MIN, limit: 40 },
  write: { windowMs: MIN, limit: 120 },
};

const ipKey = (req: Request): string => ipKeyGenerator(req.ip ?? 'desconhecido');

/** Usuario logado conta por id; anonimo, por IP. */
const userOrIpKey = (req: Request): string =>
  req.auth !== undefined ? `u:${req.auth.actor.id}` : `ip:${ipKey(req)}`;

const emailHash = (req: Request): string => {
  const email: unknown = req.body?.email;
  const normalized = typeof email === 'string' ? email.trim().toLowerCase().slice(0, 254) : '';
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
};

function limiter(
  rule: LimitRule,
  keyGenerator: (req: Request) => string,
  options: { skipSuccessfulRequests?: boolean } = {},
): RequestHandler {
  return rateLimit({
    windowMs: rule.windowMs,
    limit: rule.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator,
    skipSuccessfulRequests: options.skipSuccessfulRequests ?? false,
    handler: (req, res) => {
      const resetSeconds = Math.max(1, Math.ceil(rule.windowMs / 1000));
      res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: 'Muitas requisicoes. Aguarde um instante e tente novamente.',
          requestId: req.id,
          details: { retryAfterSeconds: resetSeconds },
        },
      });
    },
  });
}

export function createRateLimiters(rules: RateLimitRules) {
  return {
    api: limiter(rules.api, ipKey),
    loginPerAccount: limiter(
      rules.loginFailuresPerAccount,
      (req) => `${ipKey(req)}|${emailHash(req)}`,
      { skipSuccessfulRequests: true },
    ),
    loginPerIp: limiter(rules.loginFailuresPerIp, ipKey, { skipSuccessfulRequests: true }),
    register: limiter(rules.register, ipKey),
    bid: limiter(rules.bid, userOrIpKey),
    deposit: limiter(rules.deposit, userOrIpKey),
    catalog: limiter(rules.catalog, userOrIpKey),
    write: limiter(rules.write, userOrIpKey),
  };
}

export type RateLimiters = ReturnType<typeof createRateLimiters>;

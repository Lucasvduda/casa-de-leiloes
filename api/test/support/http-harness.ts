import { createHash } from 'node:crypto';
import { pino } from 'pino';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/adapters/inbound/http/app.js';
import type { RateLimitRules } from '../../src/adapters/inbound/http/middlewares/rate-limits.js';
import { Argon2Hasher } from '../../src/adapters/outbound/argon2-hasher.js';
import { cryptoIds } from '../../src/adapters/outbound/system.js';
import type { PasswordHasher } from '../../src/application/ports.js';
import { AuthService, SESSION_TTL_MS } from '../../src/application/usecases/auth.js';
import { FakeClock } from './harness.js';
import type { TestDb } from './test-db.js';

const HUGE = { windowMs: 60_000, limit: 1_000_000 };

/** Limites enormes: os testes funcionais nao devem esbarrar em rate limit sem querer. */
export const LOOSE_RATE_LIMITS: RateLimitRules = {
  api: HUGE,
  loginFailuresPerAccount: HUGE,
  loginFailuresPerIp: HUGE,
  register: HUGE,
  bid: HUGE,
  deposit: HUGE,
  catalog: HUGE,
  write: HUGE,
};

/** argon2id de verdade, so com custo baixo para a suite nao demorar. */
export class CountingHasher implements PasswordHasher {
  verifyCalls = 0;
  /** Hashes entregues ao verify: prova que e-mail inexistente tambem gasta um argon2 valido. */
  readonly verifiedHashes: string[] = [];
  hashCalls = 0;
  private readonly inner = new Argon2Hasher({ memoryCost: 1024, timeCost: 1, parallelism: 1 });
  hash(plain: string): Promise<string> {
    this.hashCalls += 1;
    return this.inner.hash(plain);
  }
  verify(hash: string, plain: string): Promise<boolean> {
    this.verifyCalls += 1;
    this.verifiedHashes.push(hash);
    return this.inner.verify(hash, plain);
  }
}

export interface HttpHarnessOptions {
  readonly rateLimits?: RateLimitRules;
  readonly cookieName?: string;
  readonly cookieSecure?: boolean;
  readonly clock?: FakeClock;
}

export function createHttpHarness(db: TestDb, options: HttpHarnessOptions = {}) {
  const clock = options.clock ?? new FakeClock();
  const hasher = new CountingHasher();
  const auth = new AuthService({ uow: db.uow, clock, ids: cryptoIds, hasher });
  const cookie = {
    name: options.cookieName ?? 'leilao_sid',
    secure: options.cookieSecure ?? false,
    maxAgeMs: SESSION_TTL_MS,
  };
  const app: Express = createApp({
    logger: pino({ level: 'silent' }),
    readinessProbe: async () => true,
    api: { auth, cookie, rateLimits: options.rateLimits ?? LOOSE_RATE_LIMITS },
  });
  return { app, auth, clock, hasher, cookie };
}

export type HttpHarness = ReturnType<typeof createHttpHarness>;

let counter = 0;
export const uniqueEmail = (prefix = 'user'): string =>
  `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}@teste.local`;

export const STRONG_PASSWORD = 'Senha-Forte-Do-Teste-42';

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Cliente com cookie jar e token CSRF, como o navegador do usuario. */
export class Client {
  readonly agent: ReturnType<typeof request.agent>;
  csrfToken: string | null = null;
  userId: string | null = null;

  constructor(readonly app: Express) {
    this.agent = request.agent(app);
  }

  async register(
    overrides: Partial<{ email: string; displayName: string; password: string; role: string }> = {},
  ) {
    const body = {
      email: uniqueEmail(),
      displayName: 'Pessoa de Teste',
      password: STRONG_PASSWORD,
      role: 'bidder',
      ...overrides,
    };
    const res = await this.agent.post('/api/auth/register').send(body);
    if (res.status === 201) {
      this.csrfToken = res.body.csrfToken;
      this.userId = res.body.user.id;
    }
    return { res, body };
  }

  async login(email: string, password = STRONG_PASSWORD) {
    const res = await this.agent.post('/api/auth/login').send({ email, password });
    if (res.status === 200) {
      this.csrfToken = res.body.csrfToken;
      this.userId = res.body.user.id;
    }
    return res;
  }

  get(url: string) {
    return this.agent.get(url);
  }

  /** POST/PUT/DELETE com o cabecalho CSRF da sessao. */
  post(url: string, body: unknown = {}, headers: Record<string, string> = {}) {
    const req = this.agent.post(url).send(body as object);
    if (this.csrfToken !== null) req.set('X-CSRF-Token', this.csrfToken);
    for (const [k, v] of Object.entries(headers)) req.set(k, v);
    return req;
  }
}

import type { Express } from 'express';
import type pg from 'pg';
import type { Logger } from 'pino';
import { createApp } from '../adapters/inbound/http/app.js';
import { LotEventHub } from '../adapters/inbound/http/sse/lot-event-hub.js';
import type { CookieSettings } from '../adapters/inbound/http/middlewares/session.js';
import { Argon2Hasher } from '../adapters/outbound/argon2-hasher.js';
import { ClevelandCatalog } from '../adapters/outbound/catalog/cleveland-catalog.js';
import { OFFLINE_ITEMS } from '../adapters/outbound/catalog/offline-catalog.data.js';
import { runMigrations } from '../adapters/outbound/postgres/migrate.js';
import {
  assertUtf8,
  postgresReadiness,
  withAdvisoryLock,
} from '../adapters/outbound/postgres/operations.js';
import { PgAuctionReadModel } from '../adapters/outbound/postgres/pg-auction-read-model.js';
import { PgUnitOfWork } from '../adapters/outbound/postgres/pg-unit-of-work.js';
import { createPool } from '../adapters/outbound/postgres/pool.js';
import {
  InMemoryEventBus,
  createMac,
  cryptoIds,
  systemClock,
} from '../adapters/outbound/system.js';
import { ensureDemoData } from '../application/seed/demo-data.js';
import type { Catalog, Clock } from '../application/ports.js';
import { AuctionQueries } from '../application/usecases/auction-queries.js';
import { AuditLot } from '../application/usecases/audit-lot.js';
import { AuthService, SESSION_TTL_MS } from '../application/usecases/auth.js';
import { CancelLot } from '../application/usecases/cancel-lot.js';
import { CreateLot } from '../application/usecases/create-lot.js';
import { Deposit } from '../application/usecases/deposit.js';
import { PlaceBid } from '../application/usecases/place-bid.js';
import { SettleLot } from '../application/usecases/settle-lot.js';
import type { AppConfig } from './config.js';
import { Scheduler, purgeSessionsTask, settleDueTask } from './scheduler.js';

/** Identificador do advisory lock do seed (diferente do das migracoes). */
const SEED_LOCK_ID = 727_002;

/** Pontos de troca para teste. Em producao nada disto e informado. */
export interface ContainerOverrides {
  readonly clock?: Clock;
  readonly catalog?: Catalog;
  /** Forca o seed mesmo com SEED_ON_BOOT=false (usado pelo `npm run seed`). */
  readonly forceSeed?: boolean;
  readonly settleEveryMs?: number;
}

export interface Container {
  readonly app: Express;
  readonly pool: pg.Pool;
  readonly hub: LotEventHub;
  readonly scheduler: Scheduler;
  readonly config: AppConfig;
}

/**
 * Cookie de sessao. Em producao: `Secure` e prefixo `__Host-` (o navegador so aceita o cookie se
 * ele for Secure, Path=/ e sem Domain, ou seja, nao da para um subdominio irmao sobrescreve-lo).
 */
export function cookieSettings(
  config: Pick<AppConfig, 'NODE_ENV' | 'COOKIE_SECURE'>,
): CookieSettings {
  const secure = config.COOKIE_SECURE ?? config.NODE_ENV === 'production';
  return {
    name: secure ? '__Host-leilao_sid' : 'leilao_sid',
    secure,
    maxAgeMs: SESSION_TTL_MS,
  };
}

/**
 * Raiz de composicao: unico lugar que conhece todos os adaptadores. Prepara banco (UTF8, migracoes,
 * seed) e monta app, hub SSE e agendador. NAO abre porta nem inicia timers: quem decide e o
 * `startServer`. Se algo falha no meio, o pool e fechado antes de propagar o erro.
 */
export async function buildContainer(
  config: AppConfig,
  logger: Logger,
  overrides: ContainerOverrides = {},
): Promise<Container> {
  if (config.DATABASE_URL === undefined) {
    throw new Error('DATABASE_URL e obrigatoria. Veja .env.example.');
  }
  const pool = createPool(config.DATABASE_URL, config.DB_POOL_MAX);
  try {
    return await assemble(pool, config, logger, overrides);
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}

async function assemble(
  pool: pg.Pool,
  config: AppConfig,
  logger: Logger,
  overrides: ContainerOverrides,
): Promise<Container> {
  await assertUtf8(pool);
  const migrations = await runMigrations(pool);
  logger.info(
    { applied: migrations.applied, skipped: migrations.skipped.length },
    'migrations_done',
  );

  const clock = overrides.clock ?? systemClock;
  const mac = createMac(config.INTEGRITY_SECRET);
  const events = new InMemoryEventBus();
  const uow = new PgUnitOfWork(pool);
  const base = { uow, clock, mac, ids: cryptoIds, events };

  const hasher = new Argon2Hasher();
  const auth = new AuthService({ uow, clock, ids: cryptoIds, hasher });
  const settle = new SettleLot(base);
  const queries = new AuctionQueries({
    uow,
    readModel: new PgAuctionReadModel(pool),
    clock,
    mac,
    settle,
  });
  const placeBid = new PlaceBid(base);
  const createLot = new CreateLot(base);
  const deposit = new Deposit({ uow });
  const catalog = overrides.catalog ?? new ClevelandCatalog({ logger });

  const hub = new LotEventHub({
    bus: events,
    loadSnapshot: (viewer, lotId) => queries.getLot(viewer, lotId),
    mac,
    now: () => clock.now().getTime(),
    logger,
  });

  if (config.SEED_ON_BOOT || overrides.forceSeed === true) {
    await withAdvisoryLock(pool, SEED_LOCK_ID, () =>
      ensureDemoData({
        auth,
        deposit,
        queries,
        settle,
        uow,
        clock,
        writers: (seedClock) => ({
          createLot: new CreateLot({ ...base, clock: seedClock }),
          placeBid: new PlaceBid({ ...base, clock: seedClock }),
          cancelLot: new CancelLot({ ...base, clock: seedClock }),
        }),
        items: OFFLINE_ITEMS,
        password: config.DEMO_PASSWORD,
        logger,
      }),
    );
  }

  const app = createApp({
    logger,
    readinessProbe: postgresReadiness(pool),
    ...(config.WEB_DIST_DIR !== undefined ? { webDistDir: config.WEB_DIST_DIR } : {}),
    trustProxyHops: config.TRUST_PROXY_HOPS,
    api: {
      auth,
      cookie: cookieSettings(config),
      queries,
      placeBid,
      createLot,
      cancelLot: new CancelLot({ ...base, allowCancelWithBids: config.ALLOW_CANCEL_WITH_BIDS }),
      deposit,
      audit: new AuditLot({ uow, mac }),
      catalog,
      events: hub,
    },
  });

  const scheduler = new Scheduler(
    [
      settleDueTask(
        settle,
        logger,
        overrides.settleEveryMs ? { everyMs: overrides.settleEveryMs } : {},
      ),
      purgeSessionsTask(auth),
    ],
    logger,
  );

  return { app, pool, hub, scheduler, config };
}

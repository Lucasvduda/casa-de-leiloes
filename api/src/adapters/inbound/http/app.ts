import express from 'express';
import type { Express } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { createErrorHandler, notFoundHandler } from './middlewares/error-handler.js';
import { requestId } from './middlewares/request-id.js';

export interface AppDeps {
  readonly logger: Logger;
  /** Verifica dependencias criticas (banco). Liveness nao depende disso; readiness sim. */
  readonly readinessProbe: () => Promise<boolean>;
}

/** Limite de corpo: nenhuma rota do leilao precisa de mais que isso. */
const JSON_BODY_LIMIT = '16kb';

export function createApp(deps: AppDeps): Express {
  const { logger, readinessProbe } = deps;
  const app = express();

  // Atras do proxy do Render: necessario para IP real (rate limit) e cookies Secure.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(requestId);
  app.use((req, res, next) => {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      logger.info(
        { requestId: req.id, method: req.method, path: req.path, status: res.statusCode, ms },
        'http_request',
      );
    });
    next();
  });
  app.use(helmet());
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  /** Liveness: o processo esta de pe. Nunca toca em banco. */
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  /** Readiness: so recebe trafego se o banco responde. */
  app.get('/ready', async (_req, res) => {
    const ready = await readinessProbe().catch(() => false);
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unavailable' });
  });

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
  return app;
}

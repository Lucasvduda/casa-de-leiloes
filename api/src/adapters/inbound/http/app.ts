import express from 'express';
import type { Express } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { loggablePath } from '../../../infrastructure/log-safety.js';
import { createApiRouter } from './api-router.js';
import type { ApiDeps } from './api-router.js';
import { createErrorHandler, notFoundHandler } from './middlewares/error-handler.js';
import { requestId } from './middlewares/request-id.js';
import { serveWebApp } from './middlewares/web-app.js';

export interface AppDeps {
  readonly logger: Logger;
  /** Verifica dependencias criticas (banco). Liveness nao depende disso; readiness sim. */
  readonly readinessProbe: () => Promise<boolean>;
  /** Rotas de negocio sob /api. Opcional para testar so a fundacao (health, erros, cabecalhos). */
  readonly api?: ApiDeps;
  /** Pasta do build do front-end. Se informada, a API serve o app na mesma origem. */
  readonly webDistDir?: string;
  /** Quantos proxies confiaveis ha na frente do app (padrao 1). Define o IP real usado nos limites. */
  readonly trustProxyHops?: number;
}

/** Unico host externo permitido: as imagens CC0 do museu (o mapeador ja aceita so esse host). */
const IMAGE_HOSTS = ['https://openaccess-cdn.clevelandart.org'];

/** Limite de corpo: nenhuma rota do leilao precisa de mais que isso. */
const JSON_BODY_LIMIT = '16kb';

export function createApp(deps: AppDeps): Express {
  const { logger, readinessProbe } = deps;
  const app = express();

  // Atras do proxy da hospedagem: necessario para o IP real (rate limit) e cookies Secure.
  // Se houver mais de um salto (ex.: CDN + balanceador), req.ip viraria o IP do proxy e todos os
  // visitantes dividiriam os mesmos limites: por isso o numero e configuravel (TRUST_PROXY_HOPS)
  // e as primeiras requisicoes registram ip e x-forwarded-for para conferir depois do deploy.
  app.set('trust proxy', deps.trustProxyHops ?? 1);
  app.disable('x-powered-by');

  app.use(requestId);
  let proxyProbesLeft = 5;
  app.use((req, res, next) => {
    const startedAt = process.hrtime.bigint();
    const probe = proxyProbesLeft > 0 && req.originalUrl !== '/health';
    if (probe) proxyProbesLeft -= 1;
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      if (probe) {
        logger.info(
          { ip: req.ip, forwardedFor: req.headers['x-forwarded-for'] ?? null },
          'proxy_probe',
        );
      }
      logger.info(
        {
          requestId: req.id,
          method: req.method,
          path: loggablePath(req.originalUrl),
          status: res.statusCode,
          ms,
        },
        'http_request',
      );
    });
    next();
  });
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'img-src': ["'self'", 'data:', ...IMAGE_HOSTS],
          'connect-src': ["'self'"],
          // O TLS termina no proxy da hospedagem; forcar upgrade quebraria http://localhost.
          'upgrade-insecure-requests': null,
        },
      },
    }),
  );
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  if (deps.api !== undefined) {
    app.use('/api', createApiRouter(deps.api));
  }

  /** Liveness: o processo esta de pe. Nunca toca em banco. */
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  /** Readiness: so recebe trafego se o banco responde. */
  app.get('/ready', async (_req, res) => {
    const ready = await readinessProbe().catch(() => false);
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unavailable' });
  });

  if (deps.webDistDir !== undefined) {
    app.use(serveWebApp(deps.webDistDir));
  }

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
  return app;
}

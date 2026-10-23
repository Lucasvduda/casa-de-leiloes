import { pino } from 'pino';
import type { Logger } from 'pino';
import type { AppConfig } from './config.js';

/**
 * Log estruturado (JSON). Campos sensiveis nunca devem ser logados; o redact abaixo e a rede
 * de seguranca caso alguem logue um objeto de requisicao ou de usuario por engano.
 */
export function createLogger(config: Pick<AppConfig, 'LOG_LEVEL' | 'NODE_ENV'>): Logger {
  return pino({
    level: config.LOG_LEVEL,
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        '*.password',
        '*.passwordHash',
        '*.email',
        '*.token',
      ],
      censor: '[redacted]',
    },
    ...(config.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  });
}

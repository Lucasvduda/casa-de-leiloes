import { pino } from 'pino';
import type { Logger } from 'pino';
import type { AppConfig } from './config.js';
import { serializeError } from './log-safety.js';

/**
 * Log estruturado (JSON). Campos sensiveis nunca devem ser logados; o redact abaixo e a rede
 * de seguranca caso alguem logue um objeto de requisicao ou de usuario por engano.
 */
export function createLogger(config: Pick<AppConfig, 'LOG_LEVEL' | 'NODE_ENV'>): Logger {
  return pino({
    level: config.LOG_LEVEL,
    // Erro do driver do Postgres carrega o VALOR que violou a regra (e-mail, por exemplo).
    serializers: { err: serializeError },
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

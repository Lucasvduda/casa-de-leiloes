import { DomainError, InvalidMoneyError, WalletInvariantError } from '../../../domain/errors.js';
import {
  AuthenticationError,
  CatalogUnavailableError,
  ConflictError,
  ForbiddenError,
  IntegrityError,
  NotFoundError,
  ValidationError,
} from '../../../application/errors.js';

export interface MappedError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly retryAfterSeconds?: number;
}

/** SQLSTATEs que significam "tente de novo daqui a pouco", nunca "bug nosso". */
const TRANSIENT_DB_CODES = new Set([
  '55P03', // lock_not_available (lock_timeout)
  '57014', // query_canceled (statement_timeout)
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '08000',
  '08003',
  '08006', // connection_failure
  '40001', // serialization_failure
  '40P01', // deadlock_detected (depois dos retries)
]);

const TRANSIENT_NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']);

export function isTransientInfrastructureError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return false;
  return TRANSIENT_DB_CODES.has(code) || TRANSIENT_NETWORK_CODES.has(code);
}

/** Traduz o erro da aplicacao/dominio para o contrato HTTP. `null` = nao e erro conhecido (500). */
export function mapKnownError(error: unknown): MappedError | null {
  if (error instanceof ValidationError) {
    return {
      status: 400,
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }
  if (error instanceof CatalogUnavailableError) {
    return {
      status: 503,
      code: error.code,
      message: error.message,
      retryAfterSeconds: 10,
    };
  }
  if (error instanceof AuthenticationError) {
    return { status: 401, code: error.code, message: error.message };
  }
  if (error instanceof ForbiddenError) {
    return { status: 403, code: error.code, message: error.message };
  }
  if (error instanceof NotFoundError) {
    return { status: 404, code: error.code, message: error.message };
  }
  if (error instanceof ConflictError || error instanceof IntegrityError) {
    return { status: 409, code: error.code, message: error.message };
  }
  if (error instanceof InvalidMoneyError) {
    return { status: 400, code: error.code, message: error.message };
  }
  if (error instanceof WalletInvariantError) {
    return { status: 422, code: error.code, message: error.message };
  }
  if (error instanceof DomainError) {
    return { status: 422, code: error.code, message: error.message };
  }
  if (isTransientInfrastructureError(error)) {
    return {
      status: 503,
      code: 'TEMPORARILY_UNAVAILABLE',
      message: 'Servico momentaneamente indisponivel. Tente novamente em instantes.',
      retryAfterSeconds: 2,
    };
  }
  return null;
}

import { DomainError } from '../domain/errors.js';

/** Recurso inexistente (ou que o usuario nao pode saber que existe). */
export class NotFoundError extends DomainError {
  constructor(code: string, message: string) {
    super(code, message);
  }
}

/** Nao autenticado (sem sessao valida) ou credenciais incorretas. */
export class AuthenticationError extends DomainError {
  constructor(code: string, message: string) {
    super(code, message);
  }
}

/** Autenticado, mas sem permissao para a operacao. */
export class ForbiddenError extends DomainError {
  constructor(code: string, message: string) {
    super(code, message);
  }
}

/** Entrada invalida. `details` mapeia campo -> mensagem. */
export class ValidationError extends DomainError {
  constructor(
    message: string,
    readonly details: Record<string, string> = {},
  ) {
    super('VALIDATION_ERROR', message);
  }
}

/** Estado atual do recurso nao permite a operacao. */
export class ConflictError extends DomainError {
  constructor(code: string, message: string) {
    super(code, message);
  }
}

/**
 * O historico de lances nao confere com o selo. A operacao e RECUSADA (nunca se move dinheiro
 * em cima de dados suspeitos) e o fato fica visivel na auditoria publica.
 */
export class IntegrityError extends DomainError {
  constructor(message: string) {
    super('INTEGRITY_VIOLATION', message);
  }
}

/** A API externa de itens esta fora e nao ha copia local util. Nada alem da busca do leiloeiro para. */
export class CatalogUnavailableError extends DomainError {
  constructor() {
    super('CATALOG_UNAVAILABLE', 'O catalogo de itens esta indisponivel no momento.');
  }
}

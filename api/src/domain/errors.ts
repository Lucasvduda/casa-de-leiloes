/**
 * Erro base do dominio. Carrega um `code` estavel (contrato com a API e com o front),
 * separado da mensagem, que pode mudar sem quebrar clientes.
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(value: unknown) {
    super('INVALID_MONEY', `Valor monetario invalido: ${String(value)}`);
  }
}

export class WalletInvariantError extends DomainError {
  constructor(code: string, message: string) {
    super(code, message);
  }
}

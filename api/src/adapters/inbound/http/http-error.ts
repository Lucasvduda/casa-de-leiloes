/**
 * Erro com contrato estavel para o cliente: `code` para maquina, `message` para pessoa.
 * Tudo que NAO for HttpError/DomainError vira 500 generico, sem vazar detalhe interno.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

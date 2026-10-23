/**
 * O que pode e o que nao pode ir para o log.
 *
 * Log vai para servicos de terceiros (hospedagem) e fica guardado: nada que seja segredo ou dado
 * pessoal entra nele. Duas fontes de vazamento acidental tratadas aqui:
 *  - o caminho da requisicao (o codigo do comprovante e uma "chave" de acesso; a query string pode
 *    carregar termos de busca);
 *  - o objeto de erro do driver do Postgres (`detail` traz o VALOR que violou a regra, por exemplo
 *    "Key (email)=(pessoa@x.com) already exists").
 */

/** Caminho sem query string, sem segredo na rota e sem caracteres de controle. */
export function loggablePath(originalUrl: string): string {
  const [rawPath = ''] = originalUrl.split('?', 1);
  let path = '';
  for (const char of rawPath) path += char.charCodeAt(0) < 0x20 || char === '\u007f' ? '?' : char;
  path = path.replace(/^(\/api\/receipts\/)[^/]*/i, '$1:code');
  return path.length > 200 ? `${path.slice(0, 200)}...` : path;
}

/** Campos do erro que podem ir para o log. Valores de coluna (`detail`, `parameters`...) ficam de fora. */
const SAFE_ERROR_FIELDS = ['code', 'severity', 'routine', 'constraint', 'table', 'schema'] as const;

export interface SerializedError {
  type: string;
  message: string;
  stack?: string;
  code?: string;
  severity?: string;
  routine?: string;
  constraint?: string;
  table?: string;
  schema?: string;
}

export function serializeError(error: unknown): SerializedError | { value: string } {
  if (!(error instanceof Error)) {
    return { value: typeof error === 'string' ? error.slice(0, 300) : typeof error };
  }
  const serialized: SerializedError = {
    type: error.constructor.name,
    message: error.message,
    ...(error.stack !== undefined ? { stack: error.stack } : {}),
  };
  const source = error as unknown as Record<string, unknown>;
  for (const field of SAFE_ERROR_FIELDS) {
    const value = source[field];
    if (typeof value === 'string') serialized[field] = value;
  }
  return serialized;
}

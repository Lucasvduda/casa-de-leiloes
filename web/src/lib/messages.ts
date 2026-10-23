import { isApiError, isNetworkError } from '../api/errors';
import { formatBRL } from './money';

/**
 * Mensagens em portugues (com acento) por CODIGO de erro. O texto do servidor e para quem consome
 * a API por fora; a tela nunca depende dele (pode mudar sem quebrar nada aqui).
 */
const BY_CODE: Record<string, string> = {
  UNAUTHENTICATED: 'Sua sessão expirou. Entre novamente para continuar.',
  INVALID_CREDENTIALS: 'E-mail ou senha incorretos.',
  EMAIL_TAKEN: 'Já existe uma conta com este e-mail.',
  FORBIDDEN_ROLE: 'Seu tipo de conta não permite esta ação.',
  ONLY_BIDDERS_CAN_DEPOSIT: 'Apenas contas de licitante adicionam saldo.',
  ONLY_SELLERS_CAN_CREATE_LOTS: 'Apenas leiloeiros criam lotes.',
  ONLY_SELLERS_CAN_CANCEL: 'Apenas o leiloeiro do lote pode cancelá-lo.',

  CSRF_INVALID: 'Não foi possível validar sua sessão. Recarregue a página e tente de novo.',
  CROSS_SITE_REQUEST: 'Requisição recusada por segurança. Recarregue a página.',
  CROSS_ORIGIN_REQUEST: 'Requisição recusada por segurança. Recarregue a página.',
  UNSUPPORTED_MEDIA_TYPE: 'Requisição em formato inválido. Recarregue a página.',

  LOT_NOT_FOUND: 'Lote não encontrado.',
  RECEIPT_NOT_FOUND: 'Comprovante não encontrado.',
  ITEM_NOT_FOUND: 'Este item não existe mais no catálogo. Escolha outro.',
  CATALOG_UNAVAILABLE: 'O catálogo de itens está indisponível agora. Tente em instantes.',

  LOT_CANCELLED: 'Este lote foi cancelado pelo leiloeiro.',
  LOT_NOT_STARTED: 'Este lote ainda não começou.',
  LOT_ENDED: 'Este lote já encerrou.',
  SELLER_CANNOT_BID: 'Leiloeiros não dão lances.',
  ALREADY_LEADING: 'Você já está liderando este lote.',
  LOT_HAS_BIDS: 'Este lote já recebeu lances e não pode mais ser cancelado.',
  LOT_ALREADY_CANCELLED: 'Este lote já foi cancelado.',
  LOT_ALREADY_CLOSED: 'Este lote já encerrou e foi liquidado; não pode mais ser cancelado.',

  INVALID_DEPOSIT: 'O valor do depósito precisa ser maior que zero.',
  DEPOSIT_TOO_LARGE: 'Valor acima do limite por depósito (R$ 100.000,00).',
  WALLET_LIMIT_EXCEEDED: 'Este depósito ultrapassaria o limite de saldo da carteira.',
  INVALID_MONEY: 'Valor inválido.',

  RATE_LIMITED: 'Muitas tentativas em pouco tempo. Aguarde um instante e tente de novo.',
  TOO_MANY_STREAMS: 'Há salas demais abertas neste dispositivo. Feche outras abas.',
  STREAM_CAPACITY: 'Muita gente acompanhando agora. Tente em instantes.',
  SHUTTING_DOWN: 'Servidor reiniciando. Tente em instantes.',
  TEMPORARILY_UNAVAILABLE: 'Serviço momentaneamente indisponível. Tente em instantes.',
  INTEGRITY_VIOLATION:
    'O histórico deste lote falhou na verificação de integridade. Veja a auditoria.',
  INVALID_JSON: 'Requisição inválida.',
  PAYLOAD_TOO_LARGE: 'Requisição grande demais.',
  NOT_FOUND: 'Recurso não encontrado.',
  INTERNAL_ERROR: 'Erro interno. Tente novamente em instantes.',
  INVALID_RESPONSE: 'O servidor respondeu algo inesperado. Tente novamente.',
};

const FALLBACK = 'Algo deu errado. Tente novamente.';

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Mensagem para mostrar a quem usa a tela, a partir de qualquer erro. */
export function messageForError(error: unknown): string {
  if (isNetworkError(error)) {
    return error.kind === 'timeout'
      ? 'O servidor demorou demais para responder. Tente novamente.'
      : 'Sem conexão com o servidor. Verifique sua internet e tente de novo.';
  }
  if (!isApiError(error)) return FALLBACK;

  if (error.code === 'BELOW_MINIMUM') {
    const min = asNumber(error.details?.minimumRequired);
    return min === null
      ? 'O lance está abaixo do mínimo exigido.'
      : `O lance mínimo agora é ${formatBRL(min)}.`;
  }
  if (error.code === 'INSUFFICIENT_FUNDS') {
    const available = asNumber(error.details?.available);
    return available === null
      ? 'Saldo disponível insuficiente.'
      : `Saldo disponível insuficiente (você tem ${formatBRL(available)}). Adicione saldo na carteira.`;
  }
  if (error.code === 'RATE_LIMITED' && error.retryAfterSeconds !== undefined) {
    return `${BY_CODE.RATE_LIMITED ?? FALLBACK} (cerca de ${error.retryAfterSeconds} s)`;
  }
  if (error.code === 'VALIDATION_ERROR') {
    const first = firstFieldError(error.details);
    return first === null ? 'Confira os dados informados.' : first;
  }
  if (error.status >= 500 && BY_CODE[error.code] === undefined) {
    return 'Erro no servidor. Tente novamente em instantes.';
  }
  return BY_CODE[error.code] ?? FALLBACK;
}

/**
 * Textos de validacao do servidor (sem acento) -> portugues correto. O que nao estiver aqui e
 * mostrado como veio, exceto mensagens padrao do zod (em ingles), que viram um texto neutro.
 */
const SERVER_TEXT: Record<string, string> = {
  'e-mail invalido': 'E-mail inválido.',
  'e-mail muito longo': 'E-mail muito longo.',
  'use pelo menos 8 caracteres': 'Use pelo menos 8 caracteres.',
  'use no maximo 128 caracteres': 'Use no máximo 128 caracteres.',
  'senha muito comum': 'Essa senha é muito comum. Escolha outra.',
  'senha muito repetitiva': 'Essa senha é muito repetitiva. Escolha outra.',
  'deve ser um inteiro positivo em centavos': 'Informe um valor maior que zero.',
  'valor acima do maximo permitido': 'Valor acima do máximo permitido.',
  'o inicio nao pode estar no passado': 'O início não pode estar no passado.',
  'o inicio nao pode estar a mais de 1 ano': 'O início não pode estar a mais de 1 ano.',
  'o lote precisa durar pelo menos 1 minuto': 'O lote precisa durar pelo menos 1 minuto.',
  'o lote pode durar no maximo 30 dias': 'O lote pode durar no máximo 30 dias.',
  'identificador de item invalido': 'Item inválido.',
};

function translateServerText(text: string): string {
  const known = SERVER_TEXT[text.trim().toLowerCase()];
  if (known !== undefined) return known;
  if (/^(too (small|big)|invalid|expected|required)/i.test(text)) return 'Valor inválido.';
  return capitalize(text);
}

/** Erros por campo (`details` do VALIDATION_ERROR), ja prontos para exibir ao lado do campo. */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!isApiError(error) || error.code !== 'VALIDATION_ERROR' || error.details === undefined) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [field, text] of Object.entries(error.details)) {
    if (typeof text === 'string') result[field] = translateServerText(text);
  }
  return result;
}

function firstFieldError(details: Readonly<Record<string, unknown>> | undefined): string | null {
  if (details === undefined) return null;
  for (const text of Object.values(details)) {
    if (typeof text === 'string') return translateServerText(text);
  }
  return null;
}

const capitalize = (text: string): string =>
  text === '' ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** Codigos de auditoria em linguagem de gente (a tela publica nao pode ser enigmatica). */
export const AUDIT_ISSUE_TEXT: Record<string, string> = {
  SEQ_DUPLICATE: 'Dois lances com o mesmo número de ordem.',
  SEQ_GAP: 'Falta um lance na sequência (possível remoção).',
  PREV_HASH_MISMATCH: 'A ligação entre dois lances foi quebrada.',
  HASH_MISMATCH: 'O conteúdo de um lance não confere com o seu selo (possível edição).',
  SEAL_INVALID: 'O selo inicial do lote não confere.',
  HEAD_MISMATCH: 'O último lance não confere com o selo do lote (possível truncamento).',
  SUMMARY_MISMATCH: 'O resumo do lote (valor, líder ou contagem) não confere com os lances.',
  LEDGER_MISMATCH: 'O extrato das carteiras não confere com os lances.',
  RECEIPT_MISSING: 'Lote encerrado com lances, mas sem comprovante.',
  RECEIPT_MISMATCH: 'O comprovante não confere com o resultado do leilão.',
};

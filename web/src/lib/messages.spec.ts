import { describe, expect, it } from 'vitest';
import { ApiError, NetworkError } from '../api/errors';
import { AUDIT_ISSUE_TEXT, fieldErrors, messageForError } from './messages';

const apiError = (code: string, extra: Partial<ConstructorParameters<typeof ApiError>[0]> = {}) =>
  new ApiError({ status: 409, code, message: 'texto do servidor', ...extra });

const norm = (text: string) => text.replace(/\s/g, ' ');

describe('messageForError', () => {
  it('usa o CODIGO, nunca o texto do servidor', () => {
    const message = messageForError(apiError('LOT_ENDED'));
    expect(message).toBe('Este lote já encerrou.');
    expect(message).not.toContain('servidor');
  });

  it('lance abaixo do minimo informa o valor exigido', () => {
    const message = messageForError(
      apiError('BELOW_MINIMUM', { details: { minimumRequired: 25050 } }),
    );
    expect(norm(message)).toBe('O lance mínimo agora é R$ 250,50.');
  });

  it('lance abaixo do minimo sem detalhe ainda e compreensivel', () => {
    expect(messageForError(apiError('BELOW_MINIMUM'))).toBe(
      'O lance está abaixo do mínimo exigido.',
    );
    expect(messageForError(apiError('BELOW_MINIMUM', { details: { minimumRequired: 'x' } }))).toBe(
      'O lance está abaixo do mínimo exigido.',
    );
  });

  it('saldo insuficiente informa o disponivel e aponta a carteira', () => {
    const message = norm(
      messageForError(apiError('INSUFFICIENT_FUNDS', { details: { available: 1000 } })),
    );
    expect(message).toContain('R$ 10,00');
    expect(message).toContain('carteira');
  });

  it('erro de rede e timeout tem texto proprio', () => {
    expect(messageForError(new NetworkError('offline'))).toContain('Sem conexão');
    expect(messageForError(new NetworkError('timeout'))).toContain('demorou demais');
  });

  it('limite de requisicoes mostra a espera quando conhecida', () => {
    const message = messageForError(
      apiError('RATE_LIMITED', { status: 429, retryAfterSeconds: 30 }),
    );
    expect(message).toContain('30 s');
  });

  it('erro de validacao traduz o texto do servidor (sem acento) para portugues correto', () => {
    const message = messageForError(
      apiError('VALIDATION_ERROR', { status: 400, details: { email: 'e-mail invalido' } }),
    );
    expect(message).toBe('E-mail inválido.');
  });

  it('mensagem padrao do zod (ingles) vira texto neutro, e texto desconhecido ganha inicial maiuscula', () => {
    const zod = apiError('VALIDATION_ERROR', {
      status: 400,
      details: { displayName: 'Too small: expected string to have >=2 characters' },
    });
    expect(messageForError(zod)).toBe('Valor inválido.');
    const other = apiError('VALIDATION_ERROR', { status: 400, details: { x: 'algo novo' } });
    expect(messageForError(other)).toBe('Algo novo');
  });

  it('validacao sem detalhes pede para conferir os dados', () => {
    expect(messageForError(apiError('VALIDATION_ERROR', { status: 400 }))).toBe(
      'Confira os dados informados.',
    );
  });

  it('5xx desconhecido vira mensagem generica, sem vazar detalhe', () => {
    const message = messageForError(
      new ApiError({ status: 500, code: 'SOMETHING_NEW', message: 'stack trace secreto' }),
    );
    expect(message).toBe('Erro no servidor. Tente novamente em instantes.');
  });

  it('codigo desconhecido e erro que nao e da API caem na mensagem padrao', () => {
    expect(messageForError(apiError('CODIGO_NOVO'))).toBe('Algo deu errado. Tente novamente.');
    expect(messageForError(new Error('boom'))).toBe('Algo deu errado. Tente novamente.');
    expect(messageForError('texto')).toBe('Algo deu errado. Tente novamente.');
    expect(messageForError(null)).toBe('Algo deu errado. Tente novamente.');
  });

  it('todo motivo de recusa de lance do servidor tem mensagem propria', () => {
    for (const code of [
      'LOT_CANCELLED',
      'LOT_NOT_STARTED',
      'LOT_ENDED',
      'SELLER_CANNOT_BID',
      'ALREADY_LEADING',
      'BELOW_MINIMUM',
      'INSUFFICIENT_FUNDS',
    ]) {
      expect(messageForError(apiError(code))).not.toBe('Algo deu errado. Tente novamente.');
    }
  });
});

describe('fieldErrors', () => {
  it('extrai erros por campo so do VALIDATION_ERROR', () => {
    const error = apiError('VALIDATION_ERROR', {
      status: 400,
      details: { password: 'use pelo menos 8 caracteres', n: 5 },
    });
    expect(fieldErrors(error)).toEqual({ password: 'Use pelo menos 8 caracteres.' });
    expect(fieldErrors(apiError('EMAIL_TAKEN'))).toEqual({});
    expect(fieldErrors(new Error('x'))).toEqual({});
  });
});

describe('AUDIT_ISSUE_TEXT', () => {
  it('cobre todos os codigos de auditoria do servidor', () => {
    for (const code of [
      'SEQ_DUPLICATE',
      'SEQ_GAP',
      'PREV_HASH_MISMATCH',
      'HASH_MISMATCH',
      'SEAL_INVALID',
      'HEAD_MISMATCH',
      'SUMMARY_MISMATCH',
      'LEDGER_MISMATCH',
      'RECEIPT_MISSING',
      'RECEIPT_MISMATCH',
    ]) {
      expect(AUDIT_ISSUE_TEXT[code]).toBeTruthy();
    }
  });
});

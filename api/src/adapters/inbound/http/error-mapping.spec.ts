import { describe, expect, it } from 'vitest';
import { DomainError, InvalidMoneyError, WalletInvariantError } from '../../../domain/errors.js';
import {
  AuthenticationError,
  ConflictError,
  ForbiddenError,
  IntegrityError,
  NotFoundError,
  ValidationError,
} from '../../../application/errors.js';
import { isTransientInfrastructureError, mapKnownError } from './error-mapping.js';

describe('mapKnownError: erro de dominio -> status HTTP', () => {
  it.each([
    ['ValidationError', new ValidationError('x', { campo: 'ruim' }), 400, 'VALIDATION_ERROR'],
    [
      'AuthenticationError',
      new AuthenticationError('INVALID_CREDENTIALS', 'x'),
      401,
      'INVALID_CREDENTIALS',
    ],
    ['ForbiddenError', new ForbiddenError('NOPE', 'x'), 403, 'NOPE'],
    ['NotFoundError', new NotFoundError('LOT_NOT_FOUND', 'x'), 404, 'LOT_NOT_FOUND'],
    ['ConflictError', new ConflictError('EMAIL_TAKEN', 'x'), 409, 'EMAIL_TAKEN'],
    ['IntegrityError', new IntegrityError('x'), 409, 'INTEGRITY_VIOLATION'],
    ['InvalidMoneyError', new InvalidMoneyError(1.5), 400, 'INVALID_MONEY'],
    [
      'WalletInvariantError',
      new WalletInvariantError('DEPOSIT_TOO_LARGE', 'x'),
      422,
      'DEPOSIT_TOO_LARGE',
    ],
    ['DomainError generico', new DomainError('OUTRO', 'x'), 422, 'OUTRO'],
  ])('%s', (_name, error, status, code) => {
    expect(mapKnownError(error)).toMatchObject({ status, code });
  });

  it('ValidationError carrega os detalhes por campo', () => {
    expect(mapKnownError(new ValidationError('x', { amount: 'invalido' }))?.details).toEqual({
      amount: 'invalido',
    });
  });

  it.each([
    ['lock timeout', { code: '55P03' }],
    ['statement timeout', { code: '57014' }],
    ['servidor desligando', { code: '57P01' }],
    ['conexoes esgotadas', { code: '53300' }],
    ['deadlock apos retries', { code: '40P01' }],
    ['conexao recusada', { code: 'ECONNREFUSED' }],
    ['conexao resetada', { code: 'ECONNRESET' }],
  ])('falha transitoria (%s) -> 503 com Retry-After, nunca 500', (_name, error) => {
    expect(isTransientInfrastructureError(error)).toBe(true);
    expect(mapKnownError(error)).toMatchObject({
      status: 503,
      code: 'TEMPORARILY_UNAVAILABLE',
      retryAfterSeconds: expect.any(Number),
    });
  });

  it.each([
    ['violacao de unicidade inesperada', { code: '23505' }],
    ['sintaxe SQL', { code: '42601' }],
    ['erro comum', new Error('boom')],
    ['null', null],
    ['string', 'erro'],
    ['codigo nao textual', { code: 500 }],
  ])('%s NAO e mapeado (vira 500 generico, e o log registra a causa)', (_name, error) => {
    expect(mapKnownError(error)).toBeNull();
  });

  it('a mensagem do erro de infraestrutura nunca expoe detalhe interno', () => {
    const mapped = mapKnownError(
      Object.assign(new Error('senha do banco: xyz'), { code: 'ECONNREFUSED' }),
    );
    expect(JSON.stringify(mapped)).not.toContain('xyz');
  });
});

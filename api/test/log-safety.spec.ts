import { Writable } from 'node:stream';
import { pino } from 'pino';
import request from 'supertest';
import { createApp } from '../src/adapters/inbound/http/app.js';
import { describe, expect, it } from 'vitest';
import { loggablePath, serializeError } from '../src/infrastructure/log-safety.js';

describe('loggablePath', () => {
  it('remove a query string (termos de busca, filtros)', () => {
    expect(loggablePath('/api/lots?q=ana%40x.com&page=2')).toBe('/api/lots');
  });

  it('esconde o codigo do comprovante (e uma chave de acesso)', () => {
    expect(loggablePath('/api/receipts/AbCdEfGhIjKlMnOpQrStUv')).toBe('/api/receipts/:code');
    expect(loggablePath('/API/receipts/segredo?x=1')).toBe('/API/receipts/:code');
  });

  it('mantem rotas normais, com id de lote (publico)', () => {
    expect(loggablePath('/api/lots/11111111-1111-4111-8111-111111111111/bids')).toBe(
      '/api/lots/11111111-1111-4111-8111-111111111111/bids',
    );
  });

  it('troca caractere de controle (injecao de linha de log) e limita o tamanho', () => {
    expect(loggablePath('/api/a\nb\u0000c')).toBe('/api/a?b?c');
    expect(loggablePath(`/${'x'.repeat(500)}`).length).toBeLessThan(210);
  });
});

describe('serializeError', () => {
  const pgDuplicate = Object.assign(
    new Error('duplicate key value violates unique constraint "users_email_key"'),
    {
      code: '23505',
      severity: 'ERROR',
      constraint: 'users_email_key',
      table: 'users',
      detail: 'Key (email)=(pessoa@secreta.com) already exists.',
      where: 'valor secreto',
      parameters: ['pessoa@secreta.com', 'hash-da-senha'],
      query: 'INSERT INTO users (email) VALUES ($1)',
    },
  );

  it('guarda causa e codigo, mas NUNCA o valor que violou a regra', () => {
    const out = JSON.stringify(serializeError(pgDuplicate));
    expect(out).toContain('23505');
    expect(out).toContain('users_email_key');
    expect(out).not.toContain('pessoa@secreta.com');
    expect(out).not.toContain('hash-da-senha');
    expect(out).not.toContain('valor secreto');
    expect(out).not.toContain('INSERT INTO');
  });

  it('erro comum mantem tipo, mensagem e stack', () => {
    const out = serializeError(new TypeError('quebrou')) as {
      type: string;
      message: string;
      stack?: string;
    };
    expect(out.type).toBe('TypeError');
    expect(out.message).toBe('quebrou');
    expect(out.stack).toContain('quebrou');
  });

  it('valor que nao e Error nao vira objeto arbitrario no log', () => {
    expect(serializeError('texto')).toEqual({ value: 'texto' });
    expect(serializeError({ password: 'x' })).toEqual({ value: 'object' });
    expect(serializeError(null)).toEqual({ value: 'object' });
  });
});

describe('log de requisicao do app', () => {
  it('registra o caminho COMPLETO sem query string e sem o codigo do comprovante', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const app = createApp({
      logger: pino({ serializers: { err: serializeError } }, sink),
      readinessProbe: async () => true,
    });
    await request(app).get('/api/receipts/SEGREDO-DO-COMPROVANTE?q=pessoa@x.com');
    await request(app).get('/health');
    const log = lines.join('');
    expect(log).not.toContain('SEGREDO-DO-COMPROVANTE');
    expect(log).not.toContain('pessoa@x.com');
    expect(log).toContain('"path":"/api/receipts/:code"');
    expect(log).toContain('"path":"/health"');
  });
});

describe('integracao com o pino (como o logger real usa)', () => {
  it('o objeto de erro do Postgres gravado no log nao carrega o e-mail', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const logger = pino({ serializers: { err: serializeError } }, sink);
    logger.error(
      {
        err: Object.assign(new Error('x'), {
          code: '23505',
          detail: 'Key (email)=(pessoa@secreta.com) already exists.',
        }),
      },
      'unhandled_error',
    );
    expect(lines.join('')).not.toContain('pessoa@secreta.com');
    expect(lines.join('')).toContain('23505');
  });
});

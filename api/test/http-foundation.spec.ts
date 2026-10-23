import request from 'supertest';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/adapters/inbound/http/app.js';
import { loadConfig } from '../src/infrastructure/config.js';

const silent = pino({ level: 'silent' });
const app = (ready = true) => createApp({ logger: silent, readinessProbe: async () => ready });

describe('GET /health e /ready', () => {
  it('liveness responde 200 sem depender de nada', async () => {
    const res = await request(app(false)).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('readiness 200 quando as dependencias respondem', async () => {
    const res = await request(app(true)).get('/ready');
    expect(res.status).toBe(200);
  });

  it('readiness 503 quando a dependencia esta fora (nunca 500)', async () => {
    const res = await request(app(false)).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'unavailable' });
  });

  it('readiness 503 quando a sonda lanca excecao', async () => {
    const a = createApp({
      logger: silent,
      readinessProbe: async () => {
        throw new Error('db down');
      },
    });
    expect((await request(a).get('/ready')).status).toBe(503);
  });
});

describe('contrato de erro e cabecalhos', () => {
  it('rota inexistente: 404 com codigo estavel e requestId', async () => {
    const res = await request(app()).get('/nao-existe');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('JSON malformado: 400 INVALID_JSON, sem stack trace', async () => {
    const a = app();
    const res = await request(a)
      .post('/health')
      .set('content-type', 'application/json')
      .send('{"quebrado":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.(ts|js)/);
  });

  it('corpo acima do limite: 413 PAYLOAD_TOO_LARGE', async () => {
    const res = await request(app())
      .post('/health')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ x: 'a'.repeat(20_000) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('request id externo seguro e propagado', async () => {
    const res = await request(app()).get('/health').set('x-request-id', 'abc-12345-xyz');
    expect(res.headers['x-request-id']).toBe('abc-12345-xyz');
  });

  it('request id externo malicioso e descartado e substituido', async () => {
    const res = await request(app()).get('/health').set('x-request-id', 'a b\tc;<script>');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('cabecalhos de seguranca presentes e sem x-powered-by', async () => {
    const res = await request(app()).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
  });
});

describe('loadConfig', () => {
  const base = { INTEGRITY_SECRET: 'x'.repeat(32) };

  it('aplica defaults sensatos', () => {
    const c = loadConfig({ ...base });
    expect(c.PORT).toBe(3000);
    expect(c.NODE_ENV).toBe('development');
    expect(c.SEED_ON_BOOT).toBe(false);
  });

  it('exige segredo de integridade', () => {
    expect(() => loadConfig({})).toThrowError(/INTEGRITY_SECRET/);
  });

  it('recusa segredo curto', () => {
    expect(() => loadConfig({ INTEGRITY_SECRET: 'curto' })).toThrowError(/32 caracteres/);
  });

  it('recusa porta invalida', () => {
    expect(() => loadConfig({ ...base, PORT: '70000' })).toThrowError(/PORT/);
    expect(() => loadConfig({ ...base, PORT: 'abc' })).toThrowError(/PORT/);
  });

  it('recusa DATABASE_URL que nao e URL', () => {
    expect(() => loadConfig({ ...base, DATABASE_URL: 'nao-e-url' })).toThrowError(/DATABASE_URL/);
  });

  it('nao vaza o valor do segredo na mensagem de erro', () => {
    try {
      loadConfig({ INTEGRITY_SECRET: 'segredo-curto-123' });
    } catch (e) {
      expect(String(e)).not.toContain('segredo-curto-123');
    }
  });
});

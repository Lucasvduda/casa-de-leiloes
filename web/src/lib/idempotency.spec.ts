import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntentKey, newIdempotencyKey } from './idempotency';

/** Formato que o servidor aceita (application/validation.ts). */
const SERVER_FORMAT = /^[A-Za-z0-9._:-]{8,100}$/;

describe('newIdempotencyKey', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('gera chave no formato aceito pelo servidor e diferente a cada chamada', () => {
    const keys = new Set(Array.from({ length: 50 }, () => newIdempotencyKey('bid')));
    expect(keys.size).toBe(50);
    for (const key of keys) expect(key).toMatch(SERVER_FORMAT);
  });

  it('funciona sem crypto.randomUUID (pagina em http fora de localhost)', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (array: Uint8Array) => {
        array.fill(171);
        return array;
      },
    });
    const key = newIdempotencyKey('dep');
    expect(key).toBe(`dep-${'ab'.repeat(16)}`);
    expect(key).toMatch(SERVER_FORMAT);
  });
});

describe('IntentKey', () => {
  it('repetir a mesma intencao reaproveita a chave (reenvio nao duplica o lance)', () => {
    const intent = new IntentKey('bid');
    const first = intent.keyFor('lote-1:15000');
    expect(intent.keyFor('lote-1:15000')).toBe(first);
    expect(intent.keyFor('lote-1:15000')).toBe(first);
  });

  it('intencao diferente (outro valor ou outro lote) ganha chave nova', () => {
    const intent = new IntentKey('bid');
    const first = intent.keyFor('lote-1:15000');
    expect(intent.keyFor('lote-1:16000')).not.toBe(first);
    expect(intent.keyFor('lote-2:15000')).not.toBe(first);
  });

  it('depois de uma resposta definitiva, o proximo clique e uma nova intencao', () => {
    const intent = new IntentKey('bid');
    const first = intent.keyFor('lote-1:15000');
    intent.release();
    expect(intent.keyFor('lote-1:15000')).not.toBe(first);
  });
});

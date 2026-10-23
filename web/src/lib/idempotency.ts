/**
 * Chave de idempotencia (formato aceito pelo servidor: 8 a 100 de [A-Za-z0-9._:-]).
 * `crypto.randomUUID` so existe em contexto seguro (HTTPS/localhost): sem ele, usa getRandomValues.
 */
export function newIdempotencyKey(prefix: string): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi.randomUUID === 'function') return `${prefix}-${cryptoApi.randomUUID()}`;
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}-${hex}`;
}

/**
 * Guarda UMA chave por "intencao" (ex.: lote + valor). Repetir o envio da mesma intencao (rede caiu,
 * timeout, duplo clique) reaproveita a chave e o servidor nao grava duas vezes. Quando a resposta
 * e definitiva (sucesso ou recusa), `release()` solta a chave: o proximo clique e uma nova intencao.
 */
export class IntentKey {
  private current: { intent: string; key: string } | null = null;

  constructor(private readonly prefix: string) {}

  keyFor(intent: string): string {
    if (this.current === null || this.current.intent !== intent) {
      this.current = { intent, key: newIdempotencyKey(this.prefix) };
    }
    return this.current.key;
  }

  release(): void {
    this.current = null;
  }
}

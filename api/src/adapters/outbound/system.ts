import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { AuctionEvent, Clock, EventPublisher, IdGenerator } from '../../application/ports.js';
import type { Mac } from '../../domain/hash-chain.js';

export const systemClock: Clock = { now: () => new Date() };

/** HMAC-SHA256 em hex com a chave do servidor (INTEGRITY_SECRET). */
export function createMac(secret: string): Mac {
  return (message) => createHmac('sha256', secret).update(message).digest('hex');
}

export const cryptoIds: IdGenerator = {
  uuid: () => randomUUID(),
  // 128 bits aleatorios: link de comprovante nao adivinhavel.
  receiptCode: () => randomBytes(16).toString('base64url'),
};

type Listener = (event: AuctionEvent) => void;

/**
 * Barramento em memoria (uma instancia). Para varias instancias, a troca natural e um adapter
 * com Postgres LISTEN/NOTIFY atras da mesma porta `EventPublisher`.
 */
export class InMemoryEventBus implements EventPublisher {
  private readonly listeners = new Set<Listener>();

  publish(event: AuctionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Um assinante com defeito nunca pode atrapalhar os outros nem o fluxo do lance.
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

import { Algorithm, hash, verify } from '@node-rs/argon2';
import type { PasswordHasher } from '../../application/ports.js';

/**
 * Parametros minimos recomendados pela OWASP para argon2id (19 MiB, 2 passadas, 1 lane).
 * Cabem no plano gratuito de hospedagem sem estourar memoria em login simultaneo.
 */
export const OWASP_ARGON2ID = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export interface Argon2Options {
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

export class Argon2Hasher implements PasswordHasher {
  constructor(private readonly options: Argon2Options = OWASP_ARGON2ID) {}

  hash(plain: string): Promise<string> {
    return hash(plain, { algorithm: Algorithm.Argon2id, ...this.options });
  }

  async verify(hashed: string, plain: string): Promise<boolean> {
    try {
      return await verify(hashed, plain);
    } catch {
      // Hash corrompido ou de formato desconhecido: tratar como senha errada, nunca como erro 500.
      return false;
    }
  }
}

import { createHash, randomBytes } from 'node:crypto';

/** 256 bits aleatorios em base64url: 43 caracteres. Impossivel de adivinhar. */
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function newCsrfToken(): string {
  return randomBytes(24).toString('base64url');
}

/** So o hash e persistido: um vazamento do banco nao entrega cookies utilizaveis. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Rejeita lixo antes de ir ao banco (cookie adulterado, curto, gigante, com caracteres estranhos). */
export function isWellFormedSessionToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_FORMAT.test(value);
}

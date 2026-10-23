import { z } from 'zod';
import { MAX_WALLET_BALANCE_CENTS } from '../domain/wallet.js';
import { cents } from '../domain/money.js';
import type { Cents } from '../domain/money.js';
import { NotFoundError, ValidationError } from './errors.js';
import type { ItemSnapshot } from './ports.js';

// Caracteres de controle em texto vindo de fora (inclusive da API publica) quebram log, UI e hash.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;
const cleanText = (max: number, min = 0) =>
  z
    .string()
    .transform((s) => s.replace(CONTROL_CHARS, ' ').trim())
    .pipe(z.string().min(min).max(max));

/** So http(s): bloqueia `javascript:`, `data:` e afins em imagem/link vindos da API externa. */
const httpUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === 'https:' || protocol === 'http:';
    } catch {
      return false;
    }
  }, 'deve ser uma URL http(s) valida');

export const itemSnapshotSchema = z.object({
  source: cleanText(40, 1),
  sourceId: cleanText(100, 1),
  sourceUrl: httpUrl.nullable().default(null),
  title: cleanText(300, 1),
  imageUrl: httpUrl.nullable().default(null),
  attributes: z
    .record(cleanText(60, 1), cleanText(500))
    .refine((r) => Object.keys(r).length <= 20, 'no maximo 20 atributos')
    .default({}),
});

const isoDate = z.iso.datetime({ offset: true }).transform((s) => new Date(s));

export const createLotSchema = z.object({
  item: itemSnapshotSchema,
  startingBid: z.number().int().positive().max(MAX_WALLET_BALANCE_CENTS),
  minIncrement: z.number().int().positive().max(MAX_WALLET_BALANCE_CENTS),
  startsAt: isoDate,
  endsAt: isoDate,
});

export type CreateLotInput = z.infer<typeof createLotSchema>;

/** E-mail normalizado: aparado e minusculo, para a unicidade nao depender de maiusculas. */
const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('e-mail invalido').max(254, 'e-mail muito longo'));

/** Senhas obviamente ruins, recusadas no cadastro (a politica principal e o tamanho minimo). */
const COMMON_PASSWORDS = new Set([
  '12345678',
  '123456789',
  '1234567890',
  '87654321',
  'password',
  'password1',
  'senha123',
  'senha1234',
  'qwertyui',
  'qwerty123',
  'iloveyou',
  'abc12345',
  'admin123',
  'leilao123',
  '00000000',
  '11111111',
]);

const newPassword = z
  .string()
  .min(8, 'use pelo menos 8 caracteres')
  .max(128, 'use no maximo 128 caracteres')
  .refine((p) => !COMMON_PASSWORDS.has(p.toLowerCase()), 'senha muito comum')
  .refine((p) => new Set(p).size > 2, 'senha muito repetitiva');

export const registerSchema = z.object({
  email,
  displayName: cleanText(60, 2),
  password: newPassword,
  role: z.enum(['seller', 'bidder']),
});

/** No login nao se revela a politica de senha: so formato minimo, para nao alimentar o argon2 com lixo. */
export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().max(254),
  password: z.string().min(1).max(128),
});

export type RegisterInput = z.infer<typeof registerSchema>;

export function toValidationError(
  error: z.ZodError,
  message = 'Dados invalidos.',
): ValidationError {
  const details: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_';
    details[key] ??= issue.message;
  }
  return new ValidationError(message, details);
}

export function parseWith<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw toValidationError(result.error);
  return result.data;
}

/** Valor em centavos vindo de fora: inteiro positivo e seguro, senao ValidationError. */
export function parseAmountCents(value: unknown, field = 'amount'): Cents {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError('Valor invalido.', {
      [field]: 'deve ser um inteiro positivo em centavos',
    });
  }
  if (value > MAX_WALLET_BALANCE_CENTS) {
    throw new ValidationError('Valor invalido.', { [field]: 'valor acima do maximo permitido' });
  }
  return cents(value);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Id de lote vindo de fora. Qualquer coisa que nao seja UUID e "nao encontrado" (404),
 * nunca um erro de sintaxe do banco (500) que revelaria detalhe interno.
 */
export function assertLotId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new NotFoundError('LOT_NOT_FOUND', 'Lote nao encontrado.');
  }
  return value;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,100}$/;

export function parseIdempotencyKey(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) {
    throw new ValidationError('Idempotency-Key invalida.', {
      idempotencyKey: 'use 8 a 100 caracteres: letras, numeros, . _ : -',
    });
  }
  return value;
}

export type { ItemSnapshot };

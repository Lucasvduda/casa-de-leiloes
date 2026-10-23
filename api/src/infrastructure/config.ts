import { z } from 'zod';

const booleanFromEnv = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().url().optional(),
  /**
   * Chave do HMAC que sela o historico de lances. Fica FORA do banco de proposito:
   * quem so tem acesso ao banco nao consegue recalcular hashes validos.
   */
  INTEGRITY_SECRET: z.string().min(32, 'INTEGRITY_SECRET precisa ter pelo menos 32 caracteres'),
  SEED_ON_BOOT: booleanFromEnv.default(false),
});

export type AppConfig = z.infer<typeof schema>;

/** Falha rapido e com mensagem clara: melhor nao subir do que subir mal configurado. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(raiz)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuracao invalida:\n${problems}\nVeja .env.example.`);
  }
  return parsed.data;
}

import { defineConfig } from 'vitest/config';

/**
 * Testes de integracao: Postgres REAL (lock de linha, trigger, CHECK e deadlock nao existem em mock).
 * Localmente sobe um Postgres embutido; no CI usa TEST_DATABASE_URL (service container).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.int.spec.ts'],
    globalSetup: ['test/support/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: 'forks',
  },
});

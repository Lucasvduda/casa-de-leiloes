import { defineConfig } from 'vitest/config';

/** Testes unitarios: rapidos, sem banco. Os de integracao usam vitest.int.config.ts. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    exclude: ['test/**/*.int.spec.ts', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      include: ['src/domain/**', 'src/application/**'],
      reporter: ['text', 'html'],
    },
  },
});

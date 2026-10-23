import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/domain/**', 'src/application/**'],
      reporter: ['text', 'html'],
    },
  },
});

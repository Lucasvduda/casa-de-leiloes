import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
    },
  },
  {
    // A camada de dominio nao conhece framework nem infraestrutura.
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'express',
                'pg',
                'drizzle-orm*',
                'pino',
                'zod',
                '../application/*',
                '../adapters/*',
                '../infrastructure/*',
              ],
              message:
                'Dominio nao pode depender de framework, adapters, infraestrutura ou aplicacao.',
            },
          ],
        },
      ],
    },
  },
);

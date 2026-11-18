import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'node_modules', '*.config.js', 'web'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'error',
    },
  },
  {
    // Ops scripts run under plain Node and report to the console.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', fetch: 'readonly', FormData: 'readonly', Blob: 'readonly', Buffer: 'readonly', setTimeout: 'readonly' },
    },
    rules: { 'no-console': 'off' },
  },
);

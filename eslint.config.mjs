import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default defineConfig([
  globalIgnores(['public/vendor/**', 'data/**', '.vercel/**', 'test-results/**']),
  {
    files: ['**/*.{js,mjs}'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    files: ['public/*.mjs', 'admin.mjs', 'test/browser-*.js', 'test/editor-reload.js'],
    languageOptions: { globals: globals.browser },
  },
  prettier,
]);

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
      // The editor builds this suite downloads and
      // drives. Not source of any repo.
      '.vscode-test/**',
      // The five nested checkouts are build
      // contexts, not sources of this repo; each
      // lints itself in its own CI.
      'mboss-web/**',
      'mboss-nodejs-api/**',
      'mboss-nodejs-dbos/**',
      'mboss-mcp-server/**',
      'mboss-vscode/**',
      'fixtures/oidc-mock/tls/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The scaffolder is plain Node rather than
    // TypeScript, so `no-undef` is live for it —
    // typescript-eslint turns that rule off
    // everywhere else because the compiler already
    // answers it. Naming the three globals it uses
    // beats adding a dependency for the whole set.
    files: ['scaffolder/**/*.mjs'],
    languageOptions: {
      globals: { URL: 'readonly', console: 'readonly', process: 'readonly' },
    },
  },
  prettier, // last — turns off rules that fight Prettier
);

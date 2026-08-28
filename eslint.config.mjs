import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
      // The three nested service checkouts are
      // build contexts, not sources of this repo;
      // each lints itself in its own CI.
      'mboss-web/**',
      'mboss-nodejs-api/**',
      'mboss-nodejs-dbos/**',
      'fixtures/oidc-mock/tls/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier, // last — turns off rules that fight Prettier
);

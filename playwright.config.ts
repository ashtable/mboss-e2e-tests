import { defineConfig } from '@playwright/test';
import { E2E_BASE_URL } from './helpers/stack.js';

/**
 * Three projects, one of which has tests.
 *
 * `cloud` drives the whole compose stack — web,
 * api, worker, Postgres and the two fixtures
 * together. There is no `webServer` block: a
 * runner that started a bare Next server would be
 * testing something the product never runs as.
 * Bring the stack up with `npm run stack:up`
 * first; global setup says so by name when it is
 * down.
 *
 * `mcp` drives the MCP server's shipped bundle as
 * child processes over stdio. It needs no browser
 * and no compose stack — its specs take no `page`
 * — only the bundle, which `npm run mcp:build`
 * makes.
 *
 * `extension` is declared and empty. It exists so
 * that surface has a home to land in rather than a
 * config change to remember, and `--list` is
 * content with an empty testDir. There is no CI
 * job for it yet, because `playwright test
 * --project=extension` against an empty project
 * exits 1 with "No tests found" — a job that would
 * be permanently red until the specs arrive.
 *
 * `retries: 0` and `workers: 1`, because a suite
 * that retries hides the flake it was written to
 * catch, and because these specs write rows a
 * later spec reads.
 */
export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  retries: 0,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: {
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'cloud',
      testDir: './tests/cloud',
      use: {
        baseURL: E2E_BASE_URL,
        // The oidc mock serves TLS with a
        // self-signed certificate, and a sign-in
        // sends the browser through it. Trusting
        // it properly would mean installing a root
        // into the browser profile for one
        // redirect that paints nothing.
        ignoreHTTPSErrors: true,
        launchOptions: {
          // `oidc-mock` is a compose hostname, and
          // the browser runs on the host. This
          // maps the name without touching
          // /etc/hosts — which is also why the
          // compose file publishes 8443 to 8443:
          // the rule rewrites the host and leaves
          // the port alone.
          args: ['--host-resolver-rules=MAP oidc-mock 127.0.0.1'],
        },
      },
    },
    { name: 'mcp', testDir: './tests/mcp' },
    { name: 'extension', testDir: './tests/extension' },
  ],
});

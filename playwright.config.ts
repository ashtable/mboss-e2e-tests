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
 * `extension` drives the packaged VS Code extension
 * inside a real editor. It takes no `page` either:
 * the window under test is an Electron one that
 * `helpers/vscode.ts` launches, so there is no
 * browser for the runner to start and no
 * `launchOptions` here for it to read — the flags,
 * the throwaway profile and the frame chain are all
 * that helper's. What the project does need is its
 * own clock: a run unzips a package, starts an
 * extension host, and waits on code generation.
 *
 * `extension-stack` is the same editor with a
 * Docker daemon behind it: one journey that has the
 * Runs panel bring a scaffolded project's own
 * compose stack up and run a workflow against it.
 * It is a project of its own rather than a file in
 * `extension` because it is opt-in — it wants
 * minutes, an image build and two free ports, and
 * `npm run e2e:ext` and CI are both entitled to run
 * on a machine with no Docker at all.
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
    {
      name: 'extension',
      testDir: './tests/extension',
      timeout: 300_000,
      expect: { timeout: 60_000 },
    },
    {
      name: 'extension-stack',
      testDir: './tests/extension-stack',
      timeout: 300_000,
      expect: { timeout: 60_000 },
    },
  ],
});

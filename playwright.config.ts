import { defineConfig } from '@playwright/test';

/**
 * One project, `cloud`, run against the stack the
 * superproject's `docker compose up` brings up.
 *
 * There is no `webServer` block: the suite drives a
 * composed web, api, worker and Postgres together,
 * and a runner that started a bare Next server would
 * be testing something the product never runs as.
 * Bring the stack up first; a spec against a stack
 * that is down fails as a connection refusal, which
 * is the honest failure.
 *
 * `retries: 0` and `workers: 1`, because a suite
 * that retries hides the flake it was written to
 * catch, and because these specs write rows a later
 * spec reads.
 */
export default defineConfig({
  testDir: './tests',
  retries: 0,
  workers: 1,
  reporter: 'list',
  projects: [
    {
      name: 'cloud',
      testDir: './tests/cloud',
      use: { baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000' },
    },
  ],
});

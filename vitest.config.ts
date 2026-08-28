import { defineConfig } from 'vitest/config';

/**
 * The hermetic half of the suite: pure helpers and
 * the two fixture servers, bound to loopback on
 * port 0. No containers, no browsers, no network.
 *
 * `include` is spelled out rather than left to the
 * default glob, and it is load-bearing twice over.
 * The default would collect `tests/cloud/*.spec.ts`
 * — Playwright specs, which fail at import under
 * vitest — and it would collect every `*.test.ts`
 * inside the three service checkouts this repo
 * nests as submodules. Anchored at `test/`, neither
 * can happen.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});

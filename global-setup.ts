import type { FullConfig } from '@playwright/test';

import { assertBundleBuilt } from './helpers/mcp.js';
import {
  E2E_BASE_URL,
  E2E_MAILSINK_URL,
  E2E_OIDC_CONTROL_URL,
} from './helpers/stack.js';

/**
 * One check per suite that is actually about to
 * run, and none of them starts anything.
 *
 * Playwright runs this once per invocation
 * whatever `--project` was given, and the suites
 * need different things: `cloud` needs the compose
 * stack, `mcp` needs the built MCP bundle and no
 * containers at all. Checking for all of it every
 * time is what made `npm run e2e:mcp` fail on a
 * mailsink no MCP spec talks to.
 *
 * Bringing any of it up is left to `stack:up` and
 * `mcp:build` deliberately: `up --wait` already
 * gates on the healthchecks, so a probe here would
 * be redundant, and building images or bundles
 * inside global setup would bury the build output
 * behind Playwright's reporter and make a one-spec
 * run take minutes.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const declared = config.projects.map((project) => project.name);
  const running = requestedProjects(process.argv) ?? new Set(declared);

  if (running.has('cloud')) await forCloud();
  if (running.has('mcp')) await assertBundleBuilt();
}

/**
 * The projects `--project` asked for, or
 * `undefined` when it asked for none — which means
 * every declared one.
 *
 * Read off the command line rather than off the
 * config, because `FullConfig.projects` is the
 * declared list and not the filtered one: global
 * setup is handed all three names even under
 * `--project=mcp`. The flag's two spellings are
 * Playwright's own — a value joined by `=`, or one
 * or more following words, since its CLI takes
 * `--project` variadically.
 */
export function requestedProjects(
  argv: readonly string[],
): Set<string> | undefined {
  const names = new Set<string>();

  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at] ?? '';

    if (arg.startsWith('--project=')) {
      names.add(arg.slice('--project='.length));
      continue;
    }

    if (arg !== '--project') continue;

    while (at + 1 < argv.length && !(argv[at + 1] ?? '').startsWith('-')) {
      at += 1;
      names.add(argv[at] ?? '');
    }
  }

  return names.size === 0 ? undefined : names;
}

/**
 * Two jobs.
 *
 * First: prove the three addresses the suite talks
 * to are answering, and say `npm run stack:up`
 * when one is not. A spec that hits a stack which
 * is down fails as a connection refusal deep
 * inside whichever assertion got there first;
 * this turns that into one sentence before any
 * test runs.
 *
 * Second: warm the two routes the specs open
 * first. The image serves a production build, so
 * there is no compile to pay — but a cold
 * container still loads a route's bundle and
 * opens its connections on the first request, and
 * on `/` or `/admin` that can outlast an ordinary
 * action timeout. Paying it here means no spec
 * pays it.
 */
async function forCloud(): Promise<void> {
  await probe(`${E2E_MAILSINK_URL}/health`, 'the mailsink fixture');
  await probe(`${E2E_OIDC_CONTROL_URL}/health`, 'the oidc-mock fixture');
  await probe(`${E2E_BASE_URL}/healthz`, 'the web service');

  await warm(`${E2E_BASE_URL}/`);
  await warm(`${E2E_BASE_URL}/admin`);
}

async function probe(url: string, what: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (cause) {
    throw new Error(
      `${what} is not answering at ${url} — run \`npm run stack:up\``,
      { cause },
    );
  }

  if (!response.ok) {
    throw new Error(
      `${what} answered ${response.status} at ${url} — ` +
        'the stack is up but unhealthy; try `npm run stack:logs`',
    );
  }
}

/**
 * A warm-up, not an assertion. The response is
 * dropped: `/admin` answers a sign-in card and
 * `/` a landing page, and which one arrives here
 * is a spec's business, not setup's.
 */
async function warm(url: string): Promise<void> {
  const response = await fetch(url);
  await response.arrayBuffer();
}

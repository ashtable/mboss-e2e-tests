import {
  E2E_BASE_URL,
  E2E_MAILSINK_URL,
  E2E_OIDC_CONTROL_URL,
} from './helpers/stack.js';

/**
 * Two jobs, and neither of them is starting the
 * stack.
 *
 * First: prove the four addresses the suite talks
 * to are answering, and say `npm run stack:up`
 * when one is not. A spec that hits a stack which
 * is down fails as a connection refusal deep
 * inside whichever assertion got there first;
 * this turns that into one sentence before any
 * test runs.
 *
 * Second: warm the two routes the specs open
 * first. `web` runs `next dev`, which compiles a
 * route on its first request, and the first
 * compile of `/` or `/admin` can outlast an
 * ordinary action timeout on a cold container.
 * Paying it here means no spec pays it.
 *
 * Bringing the stack up is left to `stack:up`
 * deliberately: `up --wait` already gates on the
 * healthchecks, so a probe here would be
 * redundant, and building three images inside
 * global setup would bury the build output behind
 * Playwright's reporter and make a one-spec run
 * take minutes.
 */
export default async function globalSetup(): Promise<void> {
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
 * A compile, not an assertion. The response is
 * dropped: `/admin` answers a sign-in card and
 * `/` a landing page, and which one arrives here
 * is a spec's business, not setup's.
 */
async function warm(url: string): Promise<void> {
  const response = await fetch(url);
  await response.arrayBuffer();
}

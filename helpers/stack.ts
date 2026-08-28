import { resetOidc, E2E_OIDC_CONTROL_URL } from './auth.js';
import { E2E_DATABASE_URL, truncatePublic } from './db.js';
import { clear, E2E_MAILSINK_URL } from './mail.js';

/**
 * Where the stack is, and how to put it back to
 * where a spec can start from.
 *
 * Each endpoint is defined beside the helper that
 * speaks to it and re-exported here, so a reader
 * sees all four addresses in one place without the
 * modules having to import each other in a circle.
 * Every one is env-overridable: the defaults are
 * the published ports of docker-compose.e2e.yml,
 * which differ from the dev stack's on purpose so
 * the two can run side by side.
 */

export const E2E_BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3100';

export { E2E_DATABASE_URL, E2E_MAILSINK_URL, E2E_OIDC_CONTROL_URL };

/**
 * The state a spec file inherits: no subscribers,
 * no broadcasts, an empty inbox at full speed, and
 * the mock back on its default identity.
 *
 * Called from each spec's `beforeAll` rather than
 * from global setup, so the reset a spec depends
 * on is visible in the spec.
 */
export async function resetStack(): Promise<void> {
  await truncatePublic();
  await clear();
  await resetOidc();
}

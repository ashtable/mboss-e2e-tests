import { expect, type Page } from '@playwright/test';

/**
 * Signing in as an admin, for real.
 *
 * There is no minted cookie here. A spec sets who
 * the oidc-mock will mint next, presses the one
 * button on the sign-in card, and rides the same
 * three redirects a person does — which means the
 * tenant check, the domain check and the session
 * cookie are all being tested rather than assumed.
 * A suite that mints its own session stops testing
 * the minting.
 *
 * The round trip is invisible: the mock has no
 * consent screen, so `authorize` answers with a
 * 302 and the browser is back on mboss.dev before
 * anything is painted.
 */

export const E2E_OIDC_CONTROL_URL =
  process.env.E2E_OIDC_CONTROL_URL ?? 'http://127.0.0.1:8081';

/**
 * Who signs in next. Every field falls back to the
 * mock's configured default, so a spec names only
 * what it is actually varying.
 */
export type Identity = {
  email?: string;
  tid?: string;
  name?: string;
};

export async function setIdentity(identity: Identity): Promise<void> {
  const response = await fetch(`${E2E_OIDC_CONTROL_URL}/_test/identity`, {
    method: 'POST',
    body: JSON.stringify(identity),
  });
  if (!response.ok)
    throw new Error(`the oidc mock refused an identity: ${response.status}`);
}

/** Restores the defaults and drops issued codes. */
export async function resetOidc(): Promise<void> {
  const response = await fetch(`${E2E_OIDC_CONTROL_URL}/_test/reset`, {
    method: 'POST',
  });
  if (!response.ok)
    throw new Error(`the oidc mock refused to reset: ${response.status}`);
}

/**
 * Signs in and lands in the console.
 *
 * `/admin` redirects a signed-in visitor to
 * `/admin/waitlist`, so arriving there is the
 * observable fact that the session took.
 */
export async function signInAs(
  page: Page,
  identity: Identity = {},
): Promise<void> {
  await attemptSignIn(page, identity);

  await expect(page).toHaveURL(/\/admin\/waitlist$/);
}

/**
 * The same round trip, without insisting it
 * worked — for the two identities that are meant
 * to be turned away.
 */
export async function attemptSignIn(
  page: Page,
  identity: Identity = {},
): Promise<void> {
  await setIdentity(identity);
  await page.goto('/admin');

  const origin = new URL(page.url()).origin;
  await page
    .getByRole('button', { name: 'Continue with Microsoft 365' })
    .click();

  // Either destination is somewhere other than the
  // sign-in card: the console for an accepted
  // account, /api/auth/error for a refused one.
  // The hop through the mock is a 302 and never
  // commits a document, so it cannot match here.
  await page.waitForURL(
    (url) => url.origin === origin && url.pathname !== '/admin',
  );
}

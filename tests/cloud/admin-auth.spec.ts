import { expect, test } from '@playwright/test';

import { attemptSignIn, signInAs } from '../../helpers/auth.js';
import { resetStack } from '../../helpers/stack.js';

/**
 * The one door on mboss.dev, and the gate behind it.
 *
 * Every case below rides the real Entra round trip
 * against the oidc-mock — authorize, PKCE token
 * exchange, the re-discovery Auth.js performs for
 * `microsoft-entra-id` after reading `tid` out of
 * the id_token, and whatever session mboss-web
 * decides to hand back. Nothing here knows the
 * stack's AUTH_SECRET and nothing mints a cookie: a
 * suite that mints its own session stops testing the
 * minting.
 *
 * That re-discovery is why the mock serves TLS.
 * `@auth/core` passes `allowInsecureRequests` on
 * every discovery call except that one, and
 * `oauth4webapi` has no localhost exemption — an
 * http issuer fails the exchange with
 * OAUTH_HTTP_REQUEST_FORBIDDEN, which surfaces here
 * as an opaque `?error=Configuration`. This spec is
 * where that stays proved.
 *
 * Watched failing first, by pointing web's
 * AUTH_MICROSOFT_ENTRA_ID_ISSUER at a tenant path
 * the mock does not serve. All four sign-in cases
 * went red on
 * `http://localhost:3100/api/auth/error?error=Configuration`
 * — including the two refusals, which is the point
 * of asserting the exact `AccessDenied` code rather
 * than "somewhere other than the console": a broken
 * discovery and a refused account both land on
 * /api/auth/error, and only the code tells them
 * apart.
 */

const ADMIN = 'e2e@autoretryai.com';

/** The tenant the stack's issuer names. */
const TENANT = '00000000-0000-4000-8000-0000000000e2';

/** Any other tenant. A free one costs nothing to run. */
const FOREIGN_TENANT = '11111111-1111-4111-8111-111111111111';

test.beforeAll(resetStack);

test('the sign-in card reads as written', async ({ page }) => {
  await page.goto('/admin');

  const card = page.locator('main > div');
  await expect(card.getByRole('heading')).toHaveText('Admin sign-in');
  await expect(card).toContainText(
    'autoretryai.com staff only — for the waitlist console.',
  );
  await expect(
    card.getByRole('button', { name: 'Continue with Microsoft 365' }),
  ).toBeVisible();
  await expect(card).toContainText(
    'e.g. ash@autoretryai.com · domain checked on callback',
  );
  await expect(card).toContainText(
    'There is no user sign-in anywhere on mboss.dev — the waitlist is ' +
      'email-only. Join it here.',
  );
  await expect(
    card.getByRole('link', { name: 'Join it here' }),
  ).toHaveAttribute('href', '/');
});

test('the sign-in card is blueprint-framed', async ({ page }) => {
  await page.goto('/admin');

  // A count of one holds on nothing in particular,
  // so the card is named first.
  await expect(
    page.getByRole('heading', { name: 'Admin sign-in' }),
  ).toBeVisible();

  // Whoever is looking at this page is still
  // anonymous — it is a public surface reached from
  // the public site, and it is framed like the
  // waitlist screens are. The console behind it is
  // not, and neither is the manage page: the
  // registration marks are how a reader tells the
  // front door from a private link or an operator's
  // screen, and that line is drawn at the sign-in,
  // not at the session.
  const card = page.locator('main > .blueprint');
  await expect(card).toHaveCount(1);
  await expect(card.locator('> .corner')).toHaveCount(4);
});

test('the sign-in page wears no site nav', async ({ page }) => {
  const response = await page.goto('/admin');
  expect(response?.status()).toBe(200);

  // A count of zero holds on a 404 too, so the card
  // is named first.
  await expect(
    page.getByRole('heading', { name: 'Admin sign-in' }),
  ).toBeVisible();

  // A door, not a destination. Site chrome here
  // would invite a visitor to wander a console they
  // cannot enter.
  await expect(page.locator('nav')).toHaveCount(0);
});

test('a signed-out console request lands on the sign-in page', async ({
  page,
}) => {
  await page.goto('/admin/waitlist');
  expect(new URL(page.url()).pathname).toBe('/admin');

  await page.goto('/admin/compose');
  expect(new URL(page.url()).pathname).toBe('/admin');
});

test('the sign-in page does not redirect to itself', async ({ page }) => {
  // /admin is matched by the same proxy rule as the
  // console it guards, so without its own case the
  // redirect loops until the browser gives up.
  const response = await page.goto('/admin');
  expect(response?.status()).toBe(200);
  expect(new URL(page.url()).pathname).toBe('/admin');
});

test('an admin from the tenant reaches the console', async ({ page }) => {
  await signInAs(page, { email: ADMIN, tid: TENANT });

  // The console naming you is what a successful
  // sign-in looks like from the outside: the address
  // in the nav came out of the id_token, through
  // canSignIn, into the JWT session.
  await expect(page.locator('nav')).toContainText(ADMIN);
});

/**
 * The tenant claim is the actual control, and it is
 * the half that cannot be argued with: Entra does
 * not verify the email claim for arbitrary tenants,
 * so anyone running a free tenant can set a user's
 * mail to any address they like. This is the nOAuth
 * shape, and the only thing standing in front of it
 * is `tid`.
 */
test('an account from another tenant is turned away', async ({ page }) => {
  await attemptSignIn(page, { email: ADMIN, tid: FOREIGN_TENANT });

  await expect(page).toHaveURL(/\/api\/auth\/error\?error=AccessDenied$/);

  // The durable half. A refusal that painted an
  // error page but left a session behind would look
  // identical on this screen.
  await page.goto('/admin/waitlist');
  expect(new URL(page.url()).pathname).toBe('/admin');
});

/**
 * `evil-autoretryai.com` is the address the domain
 * check exists to defeat — it contains
 * `autoretryai.com` and fails only an anchored test.
 * The tenant here is the right one, so the refusal
 * can only have come from the domain fence.
 */
test('a right-tenant account on a lookalike domain is turned away', async ({
  page,
}) => {
  await attemptSignIn(page, {
    email: 'intruder@evil-autoretryai.com',
    tid: TENANT,
  });

  await expect(page).toHaveURL(/\/api\/auth\/error\?error=AccessDenied$/);

  await page.goto('/admin/waitlist');
  expect(new URL(page.url()).pathname).toBe('/admin');
});

test('signing out closes the console behind you', async ({ page }) => {
  await signInAs(page, { email: ADMIN, tid: TENANT });

  // Sign-out returns to the public site rather than
  // the door: there is nothing at /admin/waitlist
  // for a signed-out admin to do.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.goto('/admin/waitlist');
  expect(new URL(page.url()).pathname).toBe('/admin');
});

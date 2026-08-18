import { expect, test } from '@playwright/test';

/**
 * The one door on mboss.dev, and the gate behind it.
 *
 * What is *not* proved here is the rejection of an
 * account from the wrong Entra tenant: that needs a
 * mock issuer able to mint a token with an arbitrary
 * `tid`, which this stack has no service for. The
 * policy that decides it is a pure function with its
 * own unit tests in mboss-web; the flow around it
 * waits for the e2e harness.
 */

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

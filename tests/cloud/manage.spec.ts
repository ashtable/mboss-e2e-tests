import { expect, test } from '@playwright/test';

/**
 * The manage page reached with a token that means
 * nothing.
 *
 * The valid-token paths — pause, resume, unsubscribe
 * — need a real signed link, which arrives by email,
 * which needs a mail sink this stack does not have.
 * They are proved at the unit layer in mboss-web and
 * get their browser-level proof once the e2e harness
 * grows one.
 */

test('an unusable link says so and names nobody', async ({ page }) => {
  const response = await page.goto('/u/not-a-real-token');
  expect(response?.status()).toBe(200);

  await expect(page.getByRole('heading')).toHaveText("That link doesn't work.");
  await expect(page.locator('main')).toContainText(
    'Manage links are signed, and they can expire or be replaced. Open the ' +
      'one in the most recent mBoss email you have — every email carries a ' +
      'fresh link.',
  );

  // The API answers forged, revoked, expired and
  // never-issued identically, and the page has to
  // keep that promise: an address on this page would
  // turn a guessed token into a membership oracle.
  expect(await page.locator('body').innerText()).not.toMatch(
    /[\w.+-]+@[\w-]+\.[\w.-]+/,
  );
});

test('the manage page is not blueprint-framed', async ({ page }) => {
  await page.goto('/u/not-a-real-token');

  // The registration marks are the public front
  // door's tell. A page reached through a private
  // link deliberately does not wear them, and this
  // is exactly the kind of difference someone
  // "fixes" into consistency.
  await expect(page.locator('.blueprint')).toHaveCount(0);
  await expect(page.locator('.corner')).toHaveCount(0);
});

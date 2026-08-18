import { expect, test } from '@playwright/test';

import { signInAs } from '../../helpers/session.js';

/**
 * The console, driven by a genuine Auth.js session
 * minted with the stack's own secret. Nothing in
 * mboss-web knows a test is holding the cookie —
 * there is no bypass path to go stale, and a wrong
 * secret shows up here as "not signed in" rather
 * than as a green run against a gate that stopped
 * working.
 */

const ADMIN = 'e2e@autoretryai.com';

test.beforeEach(async ({ context, baseURL }) => {
  await signInAs(context, ADMIN, baseURL ?? 'http://localhost:3000');
});

test('the console names the signed-in admin', async ({ page }) => {
  await page.goto('/admin/waitlist');

  await expect(page.locator('nav')).toContainText(ADMIN);
});

test('the status chips carry the API counts', async ({ page }) => {
  const response = await page.request.get('/api/admin/waitlist/stats');
  expect(response.status()).toBe(200);
  const counts = (await response.json()) as Record<string, number>;

  await page.goto('/admin/waitlist');

  for (const status of [
    'all',
    'subscribed',
    'paused',
    'unsubscribed',
    'bounced',
  ]) {
    const label = status === 'all' ? 'ALL' : status.toUpperCase();
    await expect(
      page.getByRole('link', { name: `${label} ${counts[status]}` }),
      status,
    ).toBeVisible();
  }
});

test('a fresh signup reaches the table with its derived note', async ({
  page,
}) => {
  const email = `wl-${Date.now()}@example.test`;

  await page.goto('/');
  await page.getByPlaceholder('you@company.com').fill(email);
  await page.getByRole('button', { name: 'Join waitlist' }).click();
  await expect(page.locator('main')).toContainText(email);

  await page.goto(`/admin/waitlist?q=${encodeURIComponent(email)}`);

  const row = page.locator('table tbody tr').filter({ hasText: email });
  await expect(row).toHaveCount(1);
  await expect(row.locator('td').nth(3)).toHaveText('subscribed');

  // The note is derived from the row's current
  // status alone. Nobody has been sent anything on
  // this stack, so the wording is the zero case
  // rather than "0 updates sent".
  await expect(row.locator('td').nth(4)).toHaveText('no updates yet');
});

test('a broadcast records the admin who sent it', async ({ page }) => {
  const subject = `e2e broadcast ${Date.now()}`;

  await page.goto('/admin/compose');
  await page.getByLabel('SUBJECT').fill(subject);
  await page.getByLabel('MESSAGE').fill('# The canvas is alive.');

  const send = page.getByRole('button', { name: /^Send to \d+ subscriber/ });
  await expect(send).toBeVisible();
  await send.click();
  await expect(page.getByRole('status')).toContainText('Sending to');

  const response = await page.request.get('/api/admin/broadcasts');
  expect(response.status()).toBe(200);
  const { rows } = (await response.json()) as {
    rows: { subject: string; createdBy: string }[];
  };

  // The console authenticates to the API with a
  // service token every admin shares, so the actor
  // header is the only thing that says which of them
  // pressed the button.
  const created = rows.find((row) => row.subject === subject);
  expect(created?.createdBy).toBe(ADMIN);
});

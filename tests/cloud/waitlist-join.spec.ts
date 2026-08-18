import { expect, test } from '@playwright/test';

/**
 * A real signup, all the way down: the browser posts
 * to the web app's route handler, which forwards to
 * the private API with its service bearer, which
 * writes a Subscriber row and enqueues the
 * confirmation workflow. Nothing here is stubbed, so
 * a green run is evidence the whole chain is wired.
 *
 * The confirmation email itself is not provable from
 * this stack: the compose has no mail sink, so the
 * worker's send step reaches the real SendGrid with
 * a placeholder key and fails. That failure is
 * checkpointed and terminal, and the workflow id
 * derives from a 24-hour send key — so a second
 * signup from the same address inside that window
 * would attach to the dead workflow instead of
 * starting a new one. Hence a fresh address per run,
 * every run.
 */

const CARD_BODY =
  "It's early days — the extension is still taking shape. We'll email " +
  'when the first pieces work, and again the day you can try it. ' +
  'Nothing else, ever.';

const utcDay = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: '2-digit',
});

test('a signup lands and comes back as the success card', async ({ page }) => {
  const email = `wl-${Date.now()}@example.test`;

  await page.goto('/');
  await page.getByPlaceholder('you@company.com').fill(email);
  await page.getByRole('button', { name: 'Join waitlist' }).click();

  const card = page.locator('main .blueprint').first();
  await expect(card.getByRole('heading')).toHaveText("You're on the list.");
  await expect(card).toContainText(
    `subscribed ${utcDay.format(new Date()).toLowerCase()} · ${email}`,
  );
  await expect(card).toContainText(CARD_BODY);

  // Joining is a state change on this page, not a
  // second page. The URL is part of the design.
  expect(new URL(page.url()).pathname).toBe('/');
});

test('the card offers no queue position', async ({ page }) => {
  const email = `wl-${Date.now()}@example.test`;

  await page.goto('/');
  await page.getByPlaceholder('you@company.com').fill(email);
  await page.getByRole('button', { name: 'Join waitlist' }).click();

  // There is no rank on the wire, and inventing one
  // in the UI would be a number nothing can honour.
  const card = page.locator('main .blueprint').first();
  await expect(card.getByRole('heading')).toHaveText("You're on the list.");
  const text = await card.innerText();
  expect(text).not.toMatch(/#\s*\d/);
  expect(text.toLowerCase()).not.toContain('position');
});

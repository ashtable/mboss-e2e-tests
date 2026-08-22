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
  // second page. The URL is part of the design —
  // and the empty query is the load-bearing half.
  // A form that fell through to the browser's own
  // GET would land on `/` too, so the pathname
  // alone reads the same whether the signup was
  // posted or dropped; only `?email=…` tells them
  // apart.
  const url = new URL(page.url());
  expect(url.pathname).toBe('/');
  expect(url.search).toBe('');
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

/**
 * The window before hydration, held open.
 *
 * The join box is a client island, and until React
 * has taken the markup over the form has no
 * `onSubmit`. Enter in the field then falls through
 * to the browser's own GET, which reloads
 * `/?email=…`: the signup is dropped in silence and
 * the address lands in the URL, the history and
 * every later `Referer`. It is a few milliseconds
 * wide, which is why nobody reading the page has hit
 * it and why a test hits it every time.
 *
 * A context with JavaScript off is that window with
 * the clock stopped — the same served HTML, hydration
 * that never arrives — so the guard can be asserted
 * outright instead of raced. The guard is the submit
 * button shipping `disabled`, which blocks implicit
 * submission as well as clicks.
 */
test.describe('before the form works', () => {
  test.use({ javaScriptEnabled: false });

  test('the served form refuses to submit itself', async ({ page }) => {
    await page.goto('/');

    // Named before it is measured: a disabled
    // button and no button at all agree on
    // everything asserted below.
    const button = page.getByRole('button', { name: 'Join waitlist' });
    await expect(button).toBeVisible();
    await expect(button).toBeDisabled();

    // Never submitted, so no row can come of it.
    await page
      .getByPlaceholder('you@company.com')
      .fill('wl-blocked@example.test');

    // Enter in the only text field of a one-field
    // form is how a browser is asked to submit it.
    // The wait is bounded rather than instant
    // because proving an absence needs a moment to
    // be absent in; with the guard stripped out of
    // the served HTML on the wire, the GET this
    // watches for arrived in 56ms.
    const query = page
      .waitForURL((url) => url.search !== '', { timeout: 2_000 })
      .then(() => new URL(page.url()).search)
      .catch(() => '');
    await page.keyboard.press('Enter');
    expect(await query).toBe('');
  });
});

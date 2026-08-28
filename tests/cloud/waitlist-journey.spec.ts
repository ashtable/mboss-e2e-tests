import { expect, test } from '@playwright/test';

import { closePool, subscriberByEmail } from '../../helpers/db.js';
import { manageUrlFrom } from '../../helpers/links.js';
import { messages, waitForMessage } from '../../helpers/mail.js';
import { E2E_BASE_URL, resetStack } from '../../helpers/stack.js';

/**
 * A real signup, all the way down and back again.
 *
 * The browser posts to the web app's route handler,
 * which forwards to the private API with its service
 * bearer, which writes a Subscriber row and enqueues
 * the confirmation workflow; the worker renders the
 * email, mints a manage link and hands it to the
 * mail provider. Nothing is stubbed and nothing is
 * short-circuited — the link this spec follows is
 * the one the worker wrote, read back out of the
 * captured message. The suite holds no LINK_KEYS
 * value and never imports `mintLink`: a harness that
 * mints its own links stops testing the minting.
 *
 * Watched failing first, with the worker's
 * TWILIO_EMAIL_BASE_URL pointed at a host that does
 * not exist: the journey stopped at
 * "no message matching {"to":"wl-…@e2e.test",
 * "subject":"You're on the mBoss waitlist"} after
 * 30000ms" rather than sailing past on a message
 * left behind by an earlier run — which is what the
 * per-run addresses and the beforeAll truncate are
 * for.
 */

const CARD_BODY =
  "It's early days — the extension is still taking shape. We'll email " +
  'when the first pieces work, and again the day you can try it. ' +
  'Nothing else, ever.';

const CONFIRMATION_SUBJECT = "You're on the mBoss waitlist";

const utcDay = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: '2-digit',
});

/**
 * One id for the whole file, so two runs against a
 * stack nobody truncated in between still cannot
 * collide, and so a failing address says which run
 * wrote it.
 */
const RUN = Date.now().toString(36);
const address = (n: number) => `wl-${RUN}-${n}@e2e.test`;

test.beforeAll(resetStack);
test.afterAll(closePool);

test('a signup is confirmed by email, and the link in it manages the subscription', async ({
  page,
}) => {
  const email = address(1);

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

  const confirmation = await waitForMessage({
    to: email,
    subject: CONFIRMATION_SUBJECT,
  });

  // Read out of the captured HTML, never re-minted.
  const manageUrl = manageUrlFrom(confirmation.html);
  expect(new URL(manageUrl).origin).toBe(E2E_BASE_URL);

  await page.goto(manageUrl);
  const manage = page.locator('main > div');
  await expect(manage).toContainText('status: subscribed');
  await expect(manage).toContainText(email);

  // Each action is asserted twice: once on the chip
  // the subscriber can see, and once on the row the
  // API wrote. A card that updated its own state
  // and dropped the request would pass the first
  // and fail the second.
  await page.getByRole('button', { name: 'Pause updates' }).click();
  await expect(manage).toContainText('status: paused');
  expect((await subscriberByEmail(email))?.status).toBe('paused');

  await page.getByRole('button', { name: 'Resume updates' }).click();
  await expect(manage).toContainText('status: subscribed');
  expect((await subscriberByEmail(email))?.status).toBe('subscribed');

  await page.getByRole('button', { name: 'Unsubscribe' }).click();
  await expect(manage).toContainText('status: unsubscribed');
  expect((await subscriberByEmail(email))?.status).toBe('unsubscribed');

  // Signing up again is a request to be on the list,
  // so it brings someone who left back — and it does
  // it through the ordinary success card, with no
  // "welcome back" branch to keep in step.
  await page.goto('/');
  await page.getByPlaceholder('you@company.com').fill(email);
  await page.getByRole('button', { name: 'Join waitlist' }).click();
  await expect(card.getByRole('heading')).toHaveText("You're on the list.");
  await expect(card).toContainText(email);
  expect((await subscriberByEmail(email))?.status).toBe('subscribed');

  // And it does not mail them again. The API decides
  // resend eligibility synchronously, before it
  // answers the signup — the success card above is
  // itself the anchor, so there is nothing to wait
  // for here.
  expect(await messages({ to: email })).toHaveLength(1);

  // A third submit, from a fresh load — the join box
  // gives way to the card once it has been used, so
  // there is no form left on the page to submit
  // twice. Repeat submits are the ordinary case here
  // and they keep answering the same way.
  await page.goto('/');
  await page.getByPlaceholder('you@company.com').fill(email);
  await page.getByRole('button', { name: 'Join waitlist' }).click();
  await expect(card.getByRole('heading')).toHaveText("You're on the list.");
  expect(await messages({ to: email })).toHaveLength(1);
});

test('the card offers no queue position', async ({ page }) => {
  const email = address(2);

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
  const response = await page.goto('/u/not-a-real-token');
  expect(response?.status()).toBe(200);

  // Two counts of zero hold on a 404 as readily as
  // here, so the page names itself first.
  await expect(
    page.getByRole('heading', { name: "That link doesn't work." }),
  ).toBeVisible();

  // The registration marks are the public front
  // door's tell. A page reached through a private
  // link deliberately does not wear them, and this
  // is exactly the kind of difference someone
  // "fixes" into consistency.
  await expect(page.locator('.blueprint')).toHaveCount(0);
  await expect(page.locator('.corner')).toHaveCount(0);
});

/**
 * `POST /api/unsubscribe/[token]` — the endpoint a
 * mail client fires by itself, from the broadcast's
 * `List-Unsubscribe-Post` header. Nobody is watching
 * when it runs, so the only visible failure is the
 * one that arrives weeks later as a spam complaint.
 *
 * The valid-token half of this endpoint belongs to
 * broadcast-journey, which is where a header with a
 * live token in it is produced.
 */

const UNSUBSCRIBE = '/api/unsubscribe/not-a-real-token';

test('the one-click endpoint exists, and takes only POST', async ({
  request,
}) => {
  // Both a bad token and a missing route answer 404,
  // so the route is named by something else first.
  // Without this, every assertion below would pass
  // just as well against a deleted handler.
  const response = await request.get(UNSUBSCRIBE);
  expect(response.status()).toBe(405);
});

for (const [shape, headers] of [
  ['as posted', {}],
  // What a mail client actually sends.
  ['as a form post', { 'content-type': 'application/x-www-form-urlencoded' }],
] as const) {
  test(`an unusable one-click token is refused, ${shape}`, async ({
    request,
  }) => {
    const response = await request.post(UNSUBSCRIBE, {
      headers,
      data: 'List-Unsubscribe=One-Click',
    });

    // It mirrors the API's own verdict on the token.
    // What matters is the half of the range it stays
    // out of: a 5xx has the mail client retry, and
    // some providers treat a one-click that failed as
    // a reason to offer the complaint button instead.
    expect(response.status()).toBe(404);

    // Nobody sees this response, so rendering a page
    // into it is wasted work at best. It is also how
    // a missing route answers, which is what the 405
    // above rules out. There is no content-type at
    // all on an empty body, which is why the header
    // is read defensively.
    expect(response.headers()['content-type'] ?? '').not.toContain('text/html');
    expect(await response.text()).toBe('');
  });
}

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
  //
  // Only the error state is reachable from this
  // stack; that the card itself is plain-divider
  // framed is proved in mboss-web's manage-card
  // component test, where a valid state can exist.
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
 * Only the unusable-token half is provable here, for
 * the same reason the rest of this file is: a valid
 * token arrives by email. That half waits for the
 * harness's mail sink, and it is not shortcut by
 * minting a token from the known signing keys — a
 * suite that mints its own links stops testing the
 * minting.
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

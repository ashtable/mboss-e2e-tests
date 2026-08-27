import { expect, test } from '@playwright/test';

import { signInAs } from '../../helpers/auth.js';
import {
  broadcastBySubject,
  closePool,
  deliveriesFor,
  seedSubscribers,
  waitForBroadcastComplete,
} from '../../helpers/db.js';
import {
  listUnsubscribeOf,
  manageUrlFrom,
  tokenOf,
} from '../../helpers/links.js';
import { messages, waitForMessage } from '../../helpers/mail.js';
import { E2E_BASE_URL, resetStack } from '../../helpers/stack.js';

/**
 * An admin writes an update and sends it, against an
 * audience with known numbers in it.
 *
 * The seeded twelve exist so every assertion below
 * is a specific number rather than "whatever the
 * stack happens to hold": seven subscribed, two
 * paused, two unsubscribed and one bounced, each
 * with `confirmationEmailSentAt` already set so that
 * seeding an audience does not also mail it. The
 * thirteenth arrives through the front door, which
 * is how the console's own view of a fresh signup
 * gets proved on the same run.
 *
 * The mail itself is where most of the value is. A
 * broadcast's headers are the part nobody looks at
 * and every mailbox provider does — and the
 * one-click URL and the manage link are minted from
 * the same claims, so the two carrying the same
 * token is a real cross-check rather than a regex
 * matching itself.
 *
 * `https://` on the unsubscribe URL is deliberately
 * not asserted: this harness's SITE_URL is
 * http://localhost:3100 by design, and
 * scheme-on-the-wire belongs to a run against a real
 * mailbox.
 *
 * Watched failing first, with the `dbos` container
 * killed a line before the send button was pressed:
 * "broadcast <id> was sending with 8/8 deliveries
 * pending after 60000ms". The API still took the
 * request and the console still said "Sending to 8
 * subscribers." — which is why nothing here is
 * allowed to stop at the confirmation on screen.
 */

const ADMIN = 'e2e@autoretryai.com';

const RUN = Date.now().toString(36);
const SUBJECT = `The canvas is alive (${RUN})`;
const BODY = '# The canvas is alive.\n\nFirst nodes land next week.';

/** Set, so seeding an audience does not mail it. */
const MAILED = new Date();

const subscribed = Array.from(
  { length: 7 },
  (_, n) => `bj-${RUN}-sub-${n}@e2e.test`,
);
const paused = [`bj-${RUN}-pause-0@e2e.test`, `bj-${RUN}-pause-1@e2e.test`];
const unsubscribed = [`bj-${RUN}-gone-0@e2e.test`, `bj-${RUN}-gone-1@e2e.test`];
const bounced = [`bj-${RUN}-bounced-0@e2e.test`];

/** The one who joins through the front door. */
const NEWCOMER = `bj-${RUN}-new@e2e.test`;

test.beforeAll(async () => {
  await resetStack();
  await seedSubscribers([
    ...subscribed.map((email) => ({
      email,
      status: 'subscribed' as const,
      confirmationEmailSentAt: MAILED,
    })),
    ...paused.map((email) => ({
      email,
      status: 'paused' as const,
      confirmationEmailSentAt: MAILED,
    })),
    ...unsubscribed.map((email) => ({
      email,
      status: 'unsubscribed' as const,
      confirmationEmailSentAt: MAILED,
    })),
    ...bounced.map((email) => ({
      email,
      status: 'bounced' as const,
      confirmationEmailSentAt: MAILED,
    })),
  ]);
});

test.afterAll(closePool);

test('an admin composes an update and the audience receives it', async ({
  page,
}) => {
  await signInAs(page, { email: ADMIN });

  // The chips are the console's whole account of who
  // is on the list, and they are read straight off
  // the API's counts.
  await page.goto('/admin/waitlist');
  for (const [label, count] of [
    ['ALL', 12],
    ['SUBSCRIBED', 7],
    ['PAUSED', 2],
    ['UNSUBSCRIBED', 2],
    ['BOUNCED', 1],
  ] as const)
    await expect(
      page.getByRole('link', { name: `${label} ${count}` }),
      label,
    ).toBeVisible();

  // A signup from the public page, seen from the
  // operator's side.
  await page.goto('/');
  await page.getByPlaceholder('you@company.com').fill(NEWCOMER);
  await page.getByRole('button', { name: 'Join waitlist' }).click();
  await expect(page.locator('main')).toContainText(NEWCOMER);

  await page.goto(`/admin/waitlist?q=${encodeURIComponent(NEWCOMER)}`);
  const row = page.locator('table tbody tr').filter({ hasText: NEWCOMER });
  await expect(row).toHaveCount(1);
  await expect(row.locator('td').nth(3)).toHaveText('subscribed');

  // The note is derived from the row's status and
  // its sent count, and nobody has been sent
  // anything yet — so the wording is the zero case
  // rather than "0 updates sent".
  await expect(row.locator('td').nth(4)).toHaveText('no updates yet');

  await page.goto('/admin/compose');
  await expect(page.locator('form')).toContainText('SUBSCRIBED 8');
  await page.getByLabel('SUBJECT').fill(SUBJECT);
  await page.getByLabel('MESSAGE').fill(BODY);

  const send = page.getByRole('button', { name: 'Send to 8 subscribers' });
  await expect(send).toBeVisible();

  // The test send first, because it is the one an
  // admin makes before committing — and because it
  // is the only message with this subject that is
  // not part of the broadcast, which is what makes
  // the header assertion below unambiguous.
  await page.getByRole('button', { name: 'Send test to me' }).click();
  await expect(page.getByRole('status')).toHaveText(`Test sent to ${ADMIN}.`);

  const test_ = await waitForMessage({ to: ADMIN, subject: SUBJECT });

  // No subscriber stands behind this address, so a
  // manage token minted against it could never
  // verify — and a permanently dead unsubscribe link
  // in a real inbox is worse than a footer that says
  // the word in plain text.
  expect(Object.keys(test_.headers)).toHaveLength(0);
  expect(() => manageUrlFrom(test_.html)).toThrow();

  await send.click();
  await expect(page.getByRole('status')).toHaveText(
    'Sending to 8 subscribers.',
  );

  const broadcast = await broadcastBySubject(SUBJECT);
  expect(broadcast).toBeDefined();
  const settled = await waitForBroadcastComplete(broadcast?.id ?? '');

  expect(settled.status).toBe('sent');
  expect(settled.recipientCount).toBe(8);

  // The console authenticates to the API with a
  // service token every admin shares, so the
  // x-admin-actor header is the only thing that says
  // which of them pressed the button.
  expect(settled.createdBy).toBe(ADMIN);

  const deliveries = await deliveriesFor(settled.id);
  expect(deliveries).toHaveLength(8);
  expect(deliveries.map((delivery) => delivery.status).sort()).toEqual(
    Array.from({ length: 8 }, () => 'sent'),
  );

  const audience = [...subscribed, NEWCOMER];
  const delivered = await messages({ subject: SUBJECT });

  // Nine, not eight: the admin's own test send
  // carries this subject too.
  expect(delivered).toHaveLength(9);
  expect(
    delivered
      .filter((message) => message.to !== ADMIN)
      .map((message) => message.to)
      .sort(),
  ).toEqual([...audience].sort());

  const tokens = new Set<string>();
  for (const message of delivered.filter(
    (candidate) => candidate.to !== ADMIN,
  )) {
    const manageUrl = manageUrlFrom(message.html);
    const token = tokenOf(manageUrl);
    tokens.add(token);

    expect(message.headers['List-Unsubscribe-Post'], message.to).toBe(
      'List-Unsubscribe=One-Click',
    );

    // The one-click URL and the manage link are
    // minted from the same claims. Reading the token
    // out of both and comparing them is the check —
    // a regex over the header alone would pass
    // against a link belonging to somebody else.
    const listUnsubscribe = listUnsubscribeOf(message.headers);
    expect(listUnsubscribe.url).toBe(
      `${E2E_BASE_URL}/api/unsubscribe/${token}`,
    );
    expect(listUnsubscribe.mailto).toBe('unsubscribe@mboss.dev');
  }

  // One link per person, never one link reused.
  expect(tokens.size).toBe(8);

  // Everyone the audience left out. The paused two
  // were excluded by the checkbox nobody ticked; the
  // rest are not a broadcast's business at all.
  for (const email of [...paused, ...unsubscribed, ...bounced])
    expect(await messages({ to: email }), email).toHaveLength(0);

  // And the derived note has moved — which is the
  // half a zero-case assertion on its own cannot
  // reach.
  await page.goto(`/admin/waitlist?q=${encodeURIComponent(NEWCOMER)}`);
  await expect(
    page
      .locator('table tbody tr')
      .filter({ hasText: NEWCOMER })
      .locator('td')
      .nth(4),
  ).toHaveText('1 update sent');
});

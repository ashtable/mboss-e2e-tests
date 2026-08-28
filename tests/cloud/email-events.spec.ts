import { expect, test } from '@playwright/test';

import { signInAs } from '../../helpers/auth.js';
import {
  broadcastBySubject,
  closePool,
  deliveriesFor,
  expectTerminalWorkflow,
  seedSubscribers,
  subscriberByEmail,
  waitForBroadcastComplete,
} from '../../helpers/db.js';
import { manageUrlFrom } from '../../helpers/links.js';
import { messages, waitForMessage } from '../../helpers/mail.js';
import { resetStack } from '../../helpers/stack.js';

/**
 * A bounce, all the way from the provider to the
 * console — and back out again when the person
 * signs up a second time.
 *
 * There is no webhook. Twilio Email has none, so the
 * only way a bounce is ever heard about is the
 * `bounce-scan:<sender>` workflow polling the
 * provider's operation records, and this spec is the
 * only place that path runs end to end. The stack
 * sets `BOUNCE_SCAN_DELAYS_S=2,5`, so a scan that
 * sleeps an hour and then two days in production
 * finishes here in about two seconds, using the
 * shipped code and the shipped schema.
 *
 * The `bounce-` prefix is the mailsink's own rule
 * for which recipients it reports UNDELIVERED. That
 * is a fixture decision, not a product one — nothing
 * in mBoss knows about the prefix — and it is what
 * lets a bounce be asked for rather than waited on.
 *
 * Every negative assertion is anchored on the scan
 * workflow having stopped moving. "No second
 * message" means nothing while the workflow that
 * would send it is still asleep between passes.
 *
 * Watched failing first, twice. With
 * BOUNCE_SCAN_DELAYS_S back at its production
 * 3600,7200: "workflow bounce-scan:broadcast:<id>
 * was PENDING after 30000ms" — so what marks this
 * address bounced really is the scan and nothing
 * else. And with the mailsink's bounce prefix set to
 * something no address here matches, the spec goes
 * red one assertion earlier, on the provider's own
 * verdict — `expected "UNDELIVERED", received
 * "DELIVERED"` — which is where a fixture that
 * stopped refusing anything should be caught.
 */

const ADMIN = 'e2e@autoretryai.com';

const RUN = Date.now().toString(36);
const FIRST = `First light (${RUN})`;
const SECOND = `Second light (${RUN})`;

/** The mailsink reports this recipient UNDELIVERED. */
const BOUNCER = `bounce-${RUN}@e2e.test`;

const reachable = Array.from(
  { length: 4 },
  (_, n) => `ee-${RUN}-${n}@e2e.test`,
);
const audience = [...reachable, BOUNCER];

test.beforeAll(async () => {
  await resetStack();

  // `confirmationEmailSentAt` left null on purpose:
  // the last act of this spec is a signup by the
  // bounced address, and it has to be eligible for a
  // confirmation when it gets there.
  await seedSubscribers(
    audience.map((email) => ({ email, status: 'subscribed' as const })),
  );
});

test.afterAll(closePool);

test('a bounce suppresses an address, and a fresh signup lifts it', async ({
  page,
}) => {
  await signInAs(page, { email: ADMIN });

  const first = await send(page, FIRST);
  expect(await waitForBroadcastComplete(first)).toMatchObject({
    status: 'sent',
    recipientCount: 5,
  });

  const delivered = await messages({ subject: FIRST });
  expect(delivered.map((message) => message.to).sort()).toEqual(
    [...audience].sort(),
  );

  // The provider's own verdict on the send, which is
  // what the scan is about to go and read.
  const refused = delivered.find((message) => message.to === BOUNCER);
  expect(refused?.status).toBe('UNDELIVERED');

  // The scan's id is derived from the sender's, so a
  // send that is replayed asks for the same scan
  // rather than a second one.
  expect(await expectTerminalWorkflow(`bounce-scan:broadcast:${first}`)).toBe(
    'SUCCESS',
  );

  const bounced = await subscriberByEmail(BOUNCER);
  expect(bounced?.status).toBe('bounced');
  expect(bounced?.bouncedAt).not.toBeNull();

  // Bouncing revokes every outstanding manage link
  // for this subscriber at once.
  const revokedAt = bounced?.tokenVersion ?? 0;
  expect(revokedAt).toBeGreaterThan(1);

  await page.goto(`/admin/waitlist?q=${encodeURIComponent(BOUNCER)}`);
  const row = page.locator('table tbody tr').filter({ hasText: BOUNCER });
  await expect(row.locator('td').nth(3)).toHaveText('bounced');
  await expect(row.locator('td').nth(4)).toHaveText('delivery bounced');

  // The audience is snapshotted from the live list
  // when a broadcast is created, and `bounced` is
  // not in it — so there is no delivery row for this
  // address to skip, and nothing to send.
  const second = await send(page, SECOND);
  expect(await waitForBroadcastComplete(second)).toMatchObject({
    status: 'sent',
    recipientCount: 4,
  });

  const secondDeliveries = await deliveriesFor(second);
  expect(secondDeliveries).toHaveLength(4);
  expect(
    secondDeliveries.map((delivery) => delivery.subscriberId),
  ).not.toContain(bounced?.id);
  expect(await messages({ to: BOUNCER, subject: SECOND })).toHaveLength(0);

  // Signing up again is fresh evidence against the
  // provider's verdict on one send, so it puts them
  // back on the list — through the ordinary success
  // card, with no "welcome back" branch to keep in
  // step.
  await page.goto('/');
  await page.getByPlaceholder('you@company.com').fill(BOUNCER);
  await page.getByRole('button', { name: 'Join waitlist' }).click();
  await expect(
    page.locator('main .blueprint').first().getByRole('heading'),
  ).toHaveText("You're on the list.");

  const back = await subscriberByEmail(BOUNCER);
  expect(back?.status).toBe('subscribed');

  // Unchanged. The bounce already retired the older
  // links, and re-subscribing is not a second reason
  // to retire them — bumping again would invalidate
  // the confirmation link that is about to be minted
  // if the two ever raced.
  expect(back?.tokenVersion).toBe(revokedAt);

  // And they are mailed again. This address has
  // never had a confirmation recorded, so the
  // resend window does not stand in the way.
  const confirmation = await waitForMessage({
    to: BOUNCER,
    subject: "You're on the mBoss waitlist",
  });

  // The link in it is minted against the bumped
  // token version, so following it is what proves
  // the revocation did not outlive the bounce.
  await page.goto(manageUrlFrom(confirmation.html));
  const manage = page.locator('main > div');
  await expect(manage).toContainText('status: subscribed');
  await expect(manage).toContainText(BOUNCER);
});

/**
 * Composes and sends a broadcast to everyone still
 * on the list, and answers with its id.
 */
async function send(
  page: import('@playwright/test').Page,
  subject: string,
): Promise<string> {
  await page.goto('/admin/compose');
  await page.getByLabel('SUBJECT').fill(subject);
  await page.getByLabel('MESSAGE').fill(`# ${subject}`);
  await page
    .getByRole('button', { name: /^Send to \d+ subscribers?$/ })
    .click();
  await expect(page.getByRole('status')).toContainText('Sending to');

  const broadcast = await broadcastBySubject(subject);
  expect(broadcast, subject).toBeDefined();

  return broadcast?.id ?? '';
}

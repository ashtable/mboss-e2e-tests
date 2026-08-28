import { expect, test } from '@playwright/test';

import { signInAs } from '../../helpers/auth.js';
import { kill, start } from '../../helpers/compose.js';
import {
  broadcastBySubject,
  closePool,
  deliveriesFor,
  seedSubscribers,
  waitForBroadcastComplete,
} from '../../helpers/db.js';
import { messages, setSendDelay } from '../../helpers/mail.js';
import { resetStack } from '../../helpers/stack.js';

/**
 * The worker is killed in the middle of a fan-out
 * and started again, and the broadcast finishes
 * anyway.
 *
 * This is the one claim the whole durable-execution
 * design exists to make, so it is proved with a real
 * SIGKILL to a real container rather than with a
 * thrown error. `docker compose kill` keeps the
 * container, so `start` re-runs the entrypoint under
 * the same executor id and DBOS recovers the
 * workflow it left PENDING.
 *
 * The mailsink's 100ms send delay is what makes the
 * kill land mid-flight deterministically rather than
 * hopefully. It is an explicit, bounded knob on the
 * fixture; every wait in the test itself is still a
 * poll on observable state. The assertion that the
 * broadcast is still `sending` when the kill goes in
 * is the guard on it: a run that finished first
 * fails here, naming the knob, instead of passing
 * vacuously.
 *
 * Watched failing first by killing `dbos` and never
 * starting it again: "broadcast <id> was sending
 * with 33/40 deliveries pending after 180000ms".
 * Seven had gone out, thirty-three stayed pending
 * forever — so what finishes this broadcast really
 * is the recovered workflow and not the API.
 */

const ADMIN = 'e2e@autoretryai.com';

const RUN = Date.now().toString(36);
const SUBJECT = `Durable enough to be killed (${RUN})`;
const AUDIENCE = 40;

/** Set, so seeding an audience does not mail it. */
const MAILED = new Date();

const audience = Array.from(
  { length: AUDIENCE },
  (_, n) => `cr-${RUN}-${String(n).padStart(2, '0')}@e2e.test`,
);

test.beforeAll(async () => {
  await resetStack();
  await seedSubscribers(
    audience.map((email) => ({
      email,
      status: 'subscribed' as const,
      confirmationEmailSentAt: MAILED,
    })),
  );
  await setSendDelay(100);
});

test.afterAll(async () => {
  await setSendDelay(0);
  await closePool();
});

test('a broadcast survives the worker being killed mid-send', async ({
  page,
}) => {
  // A container boot, a DBOS recovery pass and two
  // slowed fan-outs do not fit in the default
  // minute, and none of it is a wait on nothing:
  // every step below polls observable state.
  test.setTimeout(240_000);

  await signInAs(page, { email: ADMIN });

  await page.goto('/admin/compose');
  await page.getByLabel('SUBJECT').fill(SUBJECT);
  await page.getByLabel('MESSAGE').fill('# Half of this arrives twice-over.');
  await page
    .getByRole('button', { name: `Send to ${AUDIENCE} subscribers` })
    .click();
  await expect(page.getByRole('status')).toHaveText(
    `Sending to ${AUDIENCE} subscribers.`,
  );

  const broadcast = await broadcastBySubject(SUBJECT);
  expect(broadcast).toBeDefined();
  const id = broadcast?.id ?? '';

  // Under way, and not finished. Five is enough to
  // say the worker is really in the loop.
  const inFlight = await waitForSinkCount(5);
  expect(inFlight).toBeLessThan(AUDIENCE);

  const midway = await broadcastBySubject(SUBJECT);
  expect(
    midway?.status,
    'the broadcast was already sent before the kill landed — ' +
      'raise the send delay or the audience size',
  ).toBe('sending');

  // SIGKILL. Nothing gets a chance to shut down
  // cleanly, which is the point — a graceful stop
  // would let the worker finish what it was doing.
  await kill('dbos');
  await start('dbos');

  const settled = await waitForBroadcastComplete(id, 180_000);
  expect(settled.status).toBe('sent');

  const deliveries = await deliveriesFor(id);
  expect(deliveries).toHaveLength(AUDIENCE);
  expect(
    deliveries.filter((delivery) => delivery.status === 'pending'),
  ).toHaveLength(0);
  expect(
    deliveries.filter((delivery) => delivery.status === 'sent'),
  ).toHaveLength(AUDIENCE);

  const delivered = await messages({ subject: SUBJECT });
  const perAddress = new Map<string, number>();
  for (const message of delivered)
    perAddress.set(message.to, (perAddress.get(message.to) ?? 0) + 1);

  for (const email of audience)
    expect(perAddress.get(email) ?? 0, email).toBeGreaterThanOrEqual(1);

  // The accepted duplicate window, stated as a
  // number. The per-recipient send step is
  // deliberately not retried, so a crash between the
  // provider taking a message and the step's outcome
  // being checkpointed mails exactly one person
  // twice — the one in flight when the process died.
  // Closing that window entirely would need a
  // provider-side idempotency key Twilio Email does
  // not offer, and one duplicated progress note is a
  // far smaller harm than a broadcast that stalls.
  expect(delivered.length).toBeGreaterThanOrEqual(AUDIENCE);
  expect(delivered.length).toBeLessThanOrEqual(AUDIENCE + 1);
});

/**
 * Waits until the sink holds at least `atLeast`
 * messages for this broadcast, and answers with how
 * many there were when it stopped looking.
 */
async function waitForSinkCount(
  atLeast: number,
  timeoutMs = 60_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const captured = await messages({ subject: SUBJECT });
    if (captured.length >= atLeast) return captured.length;

    if (Date.now() >= deadline)
      throw new Error(
        `only ${captured.length} of ${AUDIENCE} messages after ${timeoutMs}ms ` +
          '— the worker never started the fan-out',
      );

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

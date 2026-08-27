import { expect, test, type Page } from '@playwright/test';

import {
  backdateConfirmationSentAt,
  closePool,
  confirmationSendKey,
  expectTerminalWorkflow,
  subscriberByEmail,
  workflowStatuses,
} from '../../helpers/db.js';
import { manageUrlFrom, tokenOf } from '../../helpers/links.js';
import { messages } from '../../helpers/mail.js';
import { resetStack } from '../../helpers/stack.js';

/**
 * The 24-hour resend window, from both sides.
 *
 * Repeat submits inside the window collapse onto one
 * confirmation; a signup after it gets a fresh one.
 * The rule lives in the API — it decides eligibility
 * synchronously, before it answers the signup — and
 * the worker never learns why it was asked to send.
 * So the far side is reached by rewriting a
 * timestamp: `confirmationEmailSentAt` moved 25
 * hours into the past. No clock is mocked anywhere,
 * because a suite that mocks the clock of the
 * service it is observing from outside has stopped
 * observing from outside.
 *
 * Every negative assertion here is anchored on a
 * workflow that has stopped moving rather than on a
 * sleep. "Exactly one email" means nothing while the
 * workflow that would send the second is still
 * enqueued, and `dbos.workflow_status` is where that
 * is legible. The count assertion needs no wait at
 * all: a workflow the API never enqueued has no row.
 *
 * Watched failing first with the `dbos` container
 * stopped: the anchor went red on "workflow
 * confirm:<id>:0 was ENQUEUED after 30000ms" — the
 * honest failure, rather than a green run over an
 * email nobody ever sent.
 */

const RUN = Date.now().toString(36);
const EMAIL = `wl-${RUN}-resend@e2e.test`;

test.beforeAll(resetStack);
test.afterAll(closePool);

test('a confirmation is resent only once the window has passed', async ({
  page,
}) => {
  await signUp(page, EMAIL);

  const subscriber = await subscriberByEmail(EMAIL);
  expect(subscriber).toBeDefined();
  const id = subscriber?.id ?? '';

  // The workflow id is derived, not discovered: the
  // API names it `confirm:<subscriberId>:<sendKey>`,
  // and a first send has never been recorded, so its
  // sendKey is 0.
  expect(await expectTerminalWorkflow(`confirm:${id}:0`)).toBe('SUCCESS');
  expect(await messages({ to: EMAIL })).toHaveLength(1);

  // Inside the window. The 200 the signup answered
  // with is itself the anchor — eligibility was
  // decided before the response — so what follows
  // needs no waiting.
  await signUp(page, EMAIL);
  expect(await messages({ to: EMAIL })).toHaveLength(1);
  expect(await workflowStatuses(`confirm:${id}:%`)).toHaveLength(1);

  // Time as data. Twenty-five hours, not
  // twenty-four: the rule is strictly more than the
  // window, so a signup at exactly the boundary is a
  // repeat rather than a resend.
  await backdateConfirmationSentAt(EMAIL, '25 hours');
  const sendKey = await confirmationSendKey(EMAIL);
  expect(sendKey).toBeGreaterThan(0);

  await signUp(page, EMAIL);

  // A second workflow, under its own id. A fixed id
  // per subscriber would have made this dead code:
  // workflow-id idempotency is permanent, so the
  // resend would have attached to the finished first
  // workflow and sent nothing.
  expect(await expectTerminalWorkflow(`confirm:${id}:${sendKey}`)).toBe(
    'SUCCESS',
  );
  expect(await workflowStatuses(`confirm:${id}:%`)).toHaveLength(2);

  const sent = await messages({ to: EMAIL });
  expect(sent).toHaveLength(2);

  // Two mints, not one email delivered twice. The
  // manage token carries the moment it was minted,
  // so a second workflow that had somehow replayed
  // the first one's step would hand back the same
  // token here.
  const tokens = sent.map((message) => tokenOf(manageUrlFrom(message.html)));
  expect(new Set(tokens).size).toBe(2);
});

/**
 * The join box gives way to the success card once it
 * has been used, so every submit starts from a fresh
 * load.
 */
async function signUp(page: Page, email: string): Promise<void> {
  await page.goto('/');
  await page.getByPlaceholder('you@company.com').fill(email);
  await page.getByRole('button', { name: 'Join waitlist' }).click();
  await expect(
    page.locator('main .blueprint').first().getByRole('heading'),
  ).toHaveText("You're on the list.");
}

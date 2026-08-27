import type { CapturedMessage } from '../fixtures/mailsink/server.js';

/**
 * The suite's inbox.
 *
 * Everything here reads the mailsink's inspection
 * surface, which needs no credentials — the Basic
 * auth belongs to `/v1/*`, the provider's half,
 * and only the worker speaks to that.
 *
 * The message type comes from the fixture itself,
 * so a field that changes shape there fails at
 * lint here rather than at an assertion on
 * undefined.
 */

export const E2E_MAILSINK_URL =
  process.env.E2E_MAILSINK_URL ?? 'http://127.0.0.1:8025';

export type MessageFilter = {
  to?: string;
  subject?: string;
};

/**
 * The query string for a filter, `''` when there
 * is nothing to filter on. A filter that quietly
 * went missing would turn "the message to this
 * address" into "any message at all", so it is
 * built in one place and pinned by a test.
 */
export function messagesQuery(filter: MessageFilter): string {
  const query = new URLSearchParams();
  if (filter.to !== undefined) query.set('to', filter.to);
  if (filter.subject !== undefined) query.set('subject', filter.subject);

  const rendered = query.toString();

  return rendered === '' ? '' : `?${rendered}`;
}

/** Everything captured so far, oldest first. */
export async function messages(
  filter: MessageFilter = {},
): Promise<CapturedMessage[]> {
  const response = await fetch(
    `${E2E_MAILSINK_URL}/messages${messagesQuery(filter)}`,
  );
  if (!response.ok) throw new Error(`the mailsink answered ${response.status}`);

  const { messages: captured } = (await response.json()) as {
    messages: CapturedMessage[];
  };

  return captured;
}

/**
 * The first message matching `filter`, waiting for
 * it to arrive.
 *
 * A bounded poll on observable state rather than a
 * sleep: mail arrives when a durable workflow gets
 * to it, and the honest thing to wait on is the
 * mail. A timeout names the filter, because "no
 * message arrived" without saying which one is a
 * failure nobody can act on.
 */
export async function waitForMessage(
  filter: MessageFilter,
  timeoutMs = 30_000,
): Promise<CapturedMessage> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const [first] = await messages(filter);
    if (first !== undefined) return first;

    if (Date.now() >= deadline)
      throw new Error(
        `no message matching ${JSON.stringify(filter)} after ${timeoutMs}ms`,
      );

    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Empties the inbox and clears any send delay. */
export async function clear(): Promise<void> {
  const response = await fetch(`${E2E_MAILSINK_URL}/messages`, {
    method: 'DELETE',
  });
  if (!response.ok)
    throw new Error(`the mailsink refused to clear: ${response.status}`);
}

/**
 * Makes every later send take `ms` to be accepted.
 *
 * One spec kills the worker mid-fan-out, and a
 * 40-recipient loop over loopback can finish
 * before a `docker compose kill` lands. Slowing
 * the fixture is an explicit, bounded knob; the
 * alternative is a test that hopes.
 */
export async function setSendDelay(ms: number): Promise<void> {
  const response = await fetch(`${E2E_MAILSINK_URL}/_test/delay`, {
    method: 'POST',
    body: JSON.stringify({ ms }),
  });
  if (!response.ok)
    throw new Error(`the mailsink refused a ${ms}ms delay: ${response.status}`);
}

import { fileURLToPath } from 'node:url';

import type { CapturedMessage } from '../fixtures/mailsink/server.js';

import { startHostProcess, waitForAnswer, type HostProcess } from './host.js';

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
 *
 * There are two sinks, not one. The cloud stack
 * runs the fixture as a compose service at the
 * address below; the durability spec runs the same
 * file as a host process beside the generated app
 * it is watching, because both of those are host
 * processes reaching each other on loopback. So
 * every read takes the sink to read, defaulting to
 * the compose one.
 */

export const E2E_MAILSINK_URL =
  process.env.E2E_MAILSINK_URL ?? 'http://127.0.0.1:8025';

/** The fixture, run as it is — no build step. */
const MAILSINK_SERVER = fileURLToPath(
  new URL('../fixtures/mailsink/server.ts', import.meta.url),
);

export type Mailsink = {
  /** Where it answers, and what an app's
   *  `TWILIO_EMAIL_BASE_URL` is set to. */
  url: string;
  process: HostProcess;
};

/**
 * Starts the mail fixture on this machine.
 *
 * The credentials are the app's own, read out of
 * the `.env` its scaffold wrote rather than chosen
 * here: the sink rejects a send whose Basic auth
 * does not match, so passing them through is what
 * makes the pair a real check on the scaffolded
 * values instead of a value the test picked twice.
 */
export async function startMailsink(options: {
  port: number;
  apiKey: string;
  apiSecret: string;
}): Promise<Mailsink> {
  const url = `http://127.0.0.1:${options.port}`;

  const running = startHostProcess({
    command: process.execPath,
    args: [MAILSINK_SERVER],
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      PORT: String(options.port),
      MAILSINK_API_KEY: options.apiKey,
      MAILSINK_API_SECRET: options.apiSecret,
      PUBLIC_BASE_URL: url,
    },
  });

  await waitForAnswer(running, `${url}/health`, 'the mailsink fixture', {
    timeoutMs: 15_000,
  });

  return { url, process: running };
}

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
  at = E2E_MAILSINK_URL,
): Promise<CapturedMessage[]> {
  const response = await fetch(`${at}/messages${messagesQuery(filter)}`);
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
  at = E2E_MAILSINK_URL,
): Promise<CapturedMessage> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const [first] = await messages(filter, at);
    if (first !== undefined) return first;

    if (Date.now() >= deadline)
      throw new Error(
        `no message matching ${JSON.stringify(filter)} after ${timeoutMs}ms`,
      );

    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Empties the inbox and clears any send delay. */
export async function clear(at = E2E_MAILSINK_URL): Promise<void> {
  const response = await fetch(`${at}/messages`, {
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

import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createMailsink } from '../fixtures/mailsink/server.js';

/**
 * The fake Twilio Email API, exercised over a real
 * socket on loopback. The handler is the same
 * function the container runs, so a contract that
 * drifts from the worker's mailer fails here
 * rather than as an unexplained empty inbox inside
 * a compose run.
 */

const API_KEY = 'SKe2e0000';
const API_SECRET = 'e2e-twilio-secret';
const AUTH = `Basic ${Buffer.from(`${API_KEY}:${API_SECRET}`).toString('base64')}`;

let server: Server;
let base: string;

beforeEach(async () => {
  server = createServer(
    createMailsink({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      publicBaseUrl: 'http://mailsink:8025',
      bouncePrefix: 'bounce-',
    }),
  );

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('the sink did not bind a TCP port');
  base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

type SendBody = {
  from: { address: string; name: string };
  to: { address: string }[];
  content: {
    subject: string;
    html: string;
    headers?: Record<string, string>;
  };
};

/** The body `createTwilioEmailMailer` posts, verbatim. */
function sendBody(overrides: Partial<SendBody> = {}): unknown {
  return {
    from: { address: 'hello@mboss.dev', name: 'mBoss' },
    to: [{ address: 'reader@e2e.test' }],
    content: { subject: "You're on the mBoss waitlist", html: '<p>hi</p>' },
    ...overrides,
  };
}

/** `null` sends no Authorization header at all. */
function send(body: unknown, auth: string | null = AUTH): Promise<Response> {
  return fetch(`${base}/v1/Emails`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(auth === null ? {} : { authorization: auth }),
    },
    body: JSON.stringify(body),
  });
}

async function sendAccepted(body: unknown = sendBody()): Promise<string> {
  const response = await send(body);
  expect(response.status).toBe(202);
  const payload = (await response.json()) as { operationId: string };
  return payload.operationId;
}

describe('POST /v1/Emails', () => {
  test('refuses an unauthenticated send', async () => {
    const response = await send(sendBody(), null);

    expect(response.status).toBe(401);
    // `message` is the key the mailer's
    // refusalMessage() reads; anything else shows
    // up in a failed delivery row as "HTTP 401".
    expect(await response.json()).toEqual({ message: 'unauthorized' });
  });

  test('refuses the wrong credentials', async () => {
    const response = await send(sendBody(), `Basic ${btoa('SKe2e0000:wrong')}`);

    expect(response.status).toBe(401);
  });

  test('accepts an authenticated send with an operation id', async () => {
    const response = await send(sendBody());

    expect(response.status).toBe(202);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(typeof payload.operationId).toBe('string');
    expect(payload.operationId).not.toBe('');
  });

  test('names the operation in an absolute operationLocation', async () => {
    const response = await send(sendBody());
    const payload = (await response.json()) as {
      operationId: string;
      operationLocation: string;
    };

    const location = new URL(payload.operationLocation);
    expect(location.origin).toBe('http://mailsink:8025');
    expect(location.searchParams.get('operationId')).toBe(payload.operationId);
  });

  test('records the message where a spec can read it', async () => {
    const operationId = await sendAccepted();

    const response = await fetch(`${base}/messages?to=reader@e2e.test`);
    const { messages } = (await response.json()) as {
      messages: Record<string, unknown>[];
    };

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      operationId,
      to: 'reader@e2e.test',
      from: 'hello@mboss.dev',
      subject: "You're on the mBoss waitlist",
      html: '<p>hi</p>',
      status: 'DELIVERED',
    });
  });

  test('round-trips content.headers onto the record', async () => {
    const headers = {
      'List-Unsubscribe':
        '<http://localhost:3100/api/unsubscribe/t>, <mailto:unsubscribe@mboss.dev>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    };
    await sendAccepted(
      sendBody({
        content: { subject: 'Update', html: '<p>hi</p>', headers },
      }),
    );

    const response = await fetch(`${base}/messages`);
    const { messages } = (await response.json()) as {
      messages: { headers: Record<string, string> }[];
    };

    expect(messages[0]?.headers).toEqual(headers);
  });

  test('refuses a body with no recipient address', async () => {
    const response = await send(sendBody({ to: [] }));

    // A wire regression in the mailer has to go
    // red here. A sink that captured it silently
    // would leave the suite green while nothing
    // was addressed.
    expect(response.status).toBe(400);
    expect((await response.json()) as { message: string }).toHaveProperty(
      'message',
    );
  });

  test('refuses a body with no subject', async () => {
    const response = await send(
      sendBody({ content: { subject: '', html: '<p>hi</p>' } }),
    );

    expect(response.status).toBe(400);
  });
});

describe('GET /v1/Emails', () => {
  async function statusOf(operationId: string): Promise<Response> {
    return fetch(
      `${base}/v1/Emails?operationId=${encodeURIComponent(operationId)}&pageSize=1`,
      { headers: { authorization: AUTH } },
    );
  }

  test('reports an ordinary recipient as delivered', async () => {
    const operationId = await sendAccepted();

    const response = await statusOf(operationId);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      emails: [{ status: 'DELIVERED', to: 'reader@e2e.test', operationId }],
    });
  });

  test('reports a bounce-prefixed recipient as undelivered', async () => {
    const operationId = await sendAccepted(
      sendBody({ to: [{ address: 'bounce-42@e2e.test' }] }),
    );

    const { emails } = (await (await statusOf(operationId)).json()) as {
      emails: { status: string }[];
    };

    expect(emails[0]?.status).toBe('UNDELIVERED');
  });

  test('answers an unknown operation with an empty list', async () => {
    // The status reader's "not there yet" branch:
    // an empty list is pending, not a failure.
    const response = await statusOf('never-sent');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ emails: [] });
  });

  test('refuses an unauthenticated read', async () => {
    const response = await fetch(`${base}/v1/Emails?operationId=x&pageSize=1`);

    expect(response.status).toBe(401);
  });
});

describe('the inspection surface', () => {
  test('filters messages by subject', async () => {
    await sendAccepted();
    await sendAccepted(
      sendBody({ content: { subject: 'A broadcast', html: '<p>hi</p>' } }),
    );

    const response = await fetch(`${base}/messages?subject=A broadcast`);
    const { messages } = (await response.json()) as { messages: unknown[] };

    expect(messages).toHaveLength(1);
  });

  test('returns messages oldest first', async () => {
    await sendAccepted(sendBody({ to: [{ address: 'first@e2e.test' }] }));
    await sendAccepted(sendBody({ to: [{ address: 'second@e2e.test' }] }));

    const { messages } = (await (await fetch(`${base}/messages`)).json()) as {
      messages: { to: string }[];
    };

    expect(messages.map((message) => message.to)).toEqual([
      'first@e2e.test',
      'second@e2e.test',
    ]);
  });

  test('DELETE /messages empties the store and clears the delay', async () => {
    await sendAccepted();
    await fetch(`${base}/_test/delay`, {
      method: 'POST',
      body: JSON.stringify({ ms: 400 }),
    });

    const cleared = await fetch(`${base}/messages`, { method: 'DELETE' });
    expect(cleared.status).toBe(204);

    const { messages } = (await (await fetch(`${base}/messages`)).json()) as {
      messages: unknown[];
    };
    expect(messages).toEqual([]);

    // The delay went with it: a spec that set one
    // must not slow the spec that follows it.
    const started = Date.now();
    await sendAccepted();
    expect(Date.now() - started).toBeLessThan(400);
  });

  test('POST /_test/delay slows every later send', async () => {
    const response = await fetch(`${base}/_test/delay`, {
      method: 'POST',
      body: JSON.stringify({ ms: 50 }),
    });
    expect(response.status).toBe(204);

    const started = Date.now();
    await sendAccepted();

    // The crash-resume spec kills the worker
    // mid-fan-out, and a 40-recipient loop over
    // loopback can finish before the kill lands.
    // This knob is what makes that window real.
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });

  test('GET /health answers for the container healthcheck', async () => {
    const response = await fetch(`${base}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test('the inspection surface needs no credentials', async () => {
    // Only /v1/* is the provider's surface. The
    // rest is the harness talking to its own
    // fixture, and a token there would be
    // ceremony.
    expect((await fetch(`${base}/messages`)).status).toBe(200);
  });
});

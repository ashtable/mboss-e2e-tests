import { createServer } from 'node:http';
import { describe, expect, test } from 'vitest';

import {
  clear,
  messages,
  messagesQuery,
  startMailsink,
} from '../helpers/mail.js';

/**
 * The query building, and the sink the durability
 * spec starts for itself.
 *
 * A filter that quietly went missing is the failure
 * worth catching in the first — a poll for "the
 * message to this address" that actually asks for
 * every message would pass on somebody else's mail.
 *
 * The second is here because there are two sinks
 * now: the compose one every cloud spec reads, and
 * a host process the generated app talks to. A read
 * that ignored the address it was given would keep
 * passing against the wrong inbox, or an empty one.
 */

/** A port nothing is listening on, borrowed and
 *  handed back. A constant would make `npm test`
 *  collide with whatever happened to hold it. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('no TCP port was bound');

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

  return address.port;
}

describe('messagesQuery', () => {
  test('asks for nothing when there is nothing to filter on', () => {
    expect(messagesQuery({})).toBe('');
  });

  test('carries both filters when both are given', () => {
    expect(
      messagesQuery({ to: 'reader@e2e.test', subject: 'A broadcast' }),
    ).toBe('?to=reader%40e2e.test&subject=A+broadcast');
  });

  test('omits the filter that was not given', () => {
    expect(messagesQuery({ to: 'reader@e2e.test' })).toBe(
      '?to=reader%40e2e.test',
    );
    expect(messagesQuery({ subject: 'A broadcast' })).toBe(
      '?subject=A+broadcast',
    );
  });

  test('encodes a subject with punctuation in it', () => {
    // The confirmation subject carries an
    // apostrophe, so this is the real one.
    expect(messagesQuery({ subject: "You're on the mBoss waitlist" })).toBe(
      '?subject=You%27re+on+the+mBoss+waitlist',
    );
  });
});

describe('startMailsink', () => {
  test('accepts a send under the credentials it was given', async () => {
    const port = await freePort();
    const sink = await startMailsink({
      port,
      apiKey: 'SK-dev-twilio-api-key',
      apiSecret: 'dev-twilio-api-secret',
    });

    try {
      // The body a generated app's mailer posts,
      // under the Basic auth its `.env` carries.
      const accepted = await fetch(`${sink.url}/v1/Emails`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(
            'SK-dev-twilio-api-key:dev-twilio-api-secret',
          ).toString('base64')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: { address: 'hello@example.com' },
          to: [{ address: 'claimant@crash.test' }],
          content: { subject: 'One more thing', html: '<p>hi</p>' },
        }),
      });
      expect(accepted.status).toBe(202);

      const captured = await messages({ to: 'claimant@crash.test' }, sink.url);
      expect(captured.map((message) => message.subject)).toEqual([
        'One more thing',
      ]);

      await clear(sink.url);
      expect(await messages({}, sink.url)).toEqual([]);
    } finally {
      await sink.process.kill();
    }
  });
});

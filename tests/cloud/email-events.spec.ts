import { expect, test } from '@playwright/test';

/**
 * SendGrid's event webhook, at the public edge.
 *
 * **This is a pinning test, not a red-green cycle.**
 * It passed the first time it ran and it was always
 * going to: the behaviour it describes is already
 * correct, and the only way to write a failing
 * version first would be to hold a genuinely signed
 * request, which this stack cannot produce. Said
 * plainly here so nobody reads the green as evidence
 * that something was fixed.
 *
 * What it does buy, and no unit test can: the route
 * exists on the built artifact, it is reachable from
 * outside the container, and it fails *closed*. The
 * failures it is here to catch are the route being
 * deleted or renamed (404), losing its POST handler
 * (405), throwing instead of refusing (500 — which
 * makes SendGrid retry the same garbage forever), or
 * starting to accept unsigned events, which would
 * hand anyone on the internet the ability to mark any
 * address bounced.
 *
 * ## The signed happy path, deliberately deferred
 *
 * The whole bounce chain — webhook to `bounced` row
 * in the admin table — is reachable, and this is the
 * recipe:
 *
 * 1. Generate a P-256 keypair.
 * 2. Export the public key as base64 DER SPKI and set
 *    `SENDGRID_WEBHOOK_PUBLIC_KEY` to it *before*
 *    `docker compose up` — web reads it at boot.
 * 3. Sign `timestamp + rawBody` (concatenated, no
 *    separator) with the private key, ECDSA over
 *    SHA-256, and send the two `x-twilio-…` headers.
 *
 * It is not built here because it needs an
 * environment variable the ordinary `docker compose
 * up` does not set, and a spec that quietly skips
 * itself when a variable is missing is worse than one
 * that does not exist — this repo says exactly that
 * about `npm test`. It belongs to the full harness,
 * which owns the whole environment.
 */

const SIGNATURE_HEADER = 'x-twilio-email-event-webhook-signature';
const TIMESTAMP_HEADER = 'x-twilio-email-event-webhook-timestamp';

/**
 * An address that has never signed up. If the route
 * ever did start accepting unsigned events, the spec
 * that caught it should not also have marked a real
 * subscriber bounced.
 */
const stranger = () => `wh-${Date.now()}@example.test`;

const batch = (email: string) =>
  JSON.stringify([
    { email, event: 'bounce', timestamp: Math.floor(Date.now() / 1000) },
  ]);

test('the route is there, and it is POST-only', async ({ request }) => {
  // A 404 here would mean the handler is gone, which
  // is the thing every assertion below would then
  // pass vacuously against.
  const response = await request.get('/api/email/events');
  expect(response.status()).toBe(405);
});

test('an unsigned batch is refused', async ({ request }) => {
  const response = await request.post('/api/email/events', {
    headers: { 'content-type': 'application/json' },
    data: batch(stranger()),
  });

  // 401 and not 500: the provider retries a 5xx, so
  // answering an unsignable request that way asks it
  // to send the same garbage back forever.
  expect(response.status()).toBe(401);
});

test('a bogus signature is refused', async ({ request }) => {
  const response = await request.post('/api/email/events', {
    headers: {
      'content-type': 'application/json',
      [SIGNATURE_HEADER]: Buffer.from('not-a-signature').toString('base64'),
      [TIMESTAMP_HEADER]: String(Math.floor(Date.now() / 1000)),
    },
    data: batch(stranger()),
  });

  // Verification returns false rather than throwing,
  // and this is where that shows: headers shaped like
  // the real thing get the same 401 as no headers at
  // all.
  expect(response.status()).toBe(401);
});

test('the refusal says nothing back', async ({ request }) => {
  const email = stranger();
  const response = await request.post('/api/email/events', {
    headers: { 'content-type': 'application/json' },
    data: batch(email),
  });
  expect(response.status()).toBe(401);

  // A refusal that quotes the request back is a
  // reflector, and one that names the key it checked
  // against tells the caller what to forge. It is an
  // empty body today; what is asserted is the weaker
  // claim that will still be true if a reason is ever
  // added to it.
  const body = await response.text();
  expect(body).not.toContain(email);
  expect(body).not.toMatch(/sendgrid|public key|<html|\.ts:\d/i);
});

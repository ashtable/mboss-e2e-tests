import {
  createHash,
  createPublicKey,
  createVerify,
  randomBytes,
  type JsonWebKey,
} from 'node:crypto';
import { createServer, type RequestListener, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createOidcMock } from '../fixtures/oidc-mock/server.js';

/**
 * The tenant-pinned Entra mock.
 *
 * Both handlers are mounted over plain HTTP here.
 * In the stack the protocol surface serves TLS —
 * Auth.js re-runs discovery after the token
 * exchange without allowing insecure requests, so
 * an http issuer is refused outright — but TLS is
 * two lines in the server's main(), exercised by
 * the compose run, and a unit test of it would
 * only be testing Node.
 *
 * What is worth pinning here is everything
 * oauth4webapi checks and everything it refuses.
 * The sharpest of those is the absence of a
 * `nonce` claim: mboss-web's provider runs
 * `checks: ['pkce']` only, so the expected nonce
 * reaches the id_token validator as undefined and
 * a claim that is merely *present* throws.
 */

const TENANT = '00000000-0000-4000-8000-0000000000e2';
const ISSUER = `https://oidc-mock:8443/${TENANT}/v2.0`;
const ORIGIN = 'https://oidc-mock:8443';
const CLIENT_ID = 'e2e-client-id';
const CLIENT_SECRET = 'e2e-client-secret';
const REDIRECT_URI =
  'http://localhost:3100/api/auth/callback/microsoft-entra-id';
const DEFAULT_EMAIL = 'e2e@autoretryai.com';
const DEFAULT_NAME = 'E2E Admin';

let protocolServer: Server;
let controlServer: Server;
let base: string;
let control: string;

async function listen(handler: RequestListener): Promise<[Server, string]> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('the mock did not bind a TCP port');

  return [server, `http://127.0.0.1:${address.port}`];
}

beforeEach(async () => {
  const mock = createOidcMock({
    issuer: ISSUER,
    tenantId: TENANT,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    defaultEmail: DEFAULT_EMAIL,
    defaultName: DEFAULT_NAME,
  });

  [protocolServer, base] = await listen(mock.protocol);
  [controlServer, control] = await listen(mock.control);
});

afterEach(async () => {
  for (const server of [protocolServer, controlServer])
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
});

/** PKCE, as Auth.js sends it: S256 and nothing else. */
function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
  };
}

function authorizeUrl(params: Record<string, string>): string {
  return `${base}/${TENANT}/oauth2/v2.0/authorize?${new URLSearchParams(params)}`;
}

async function authorize(
  params: Record<string, string>,
): Promise<{ status: number; location: URL | null }> {
  const response = await fetch(authorizeUrl(params), { redirect: 'manual' });
  const location = response.headers.get('location');
  await response.body?.cancel();

  return {
    status: response.status,
    location: location === null ? null : new URL(location),
  };
}

/** An authorize round trip, returning the code. */
async function codeFor(
  challenge: string,
  extra: Record<string, string> = {},
): Promise<string> {
  const { location } = await authorize({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'openid profile email',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...extra,
  });

  const code = location?.searchParams.get('code');
  if (code === null || code === undefined)
    throw new Error(`authorize returned no code: ${String(location)}`);

  return code;
}

function tokenRequest(
  body: Record<string, string>,
  secret = CLIENT_SECRET,
): Promise<Response> {
  return fetch(`${base}/${TENANT}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${secret}`).toString('base64')}`,
    },
    body: new URLSearchParams(body).toString(),
  });
}

/** A whole sign-in, ending at the id_token. */
async function signIn(extra: Record<string, string> = {}): Promise<{
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  raw: string;
  accessToken: string;
}> {
  const { verifier, challenge } = pkce();
  const code = await codeFor(challenge, extra);
  const response = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });

  expect(response.status).toBe(200);
  const payload = (await response.json()) as {
    id_token: string;
    access_token: string;
  };

  const [header, claims] = payload.id_token.split('.');
  return {
    header: JSON.parse(
      Buffer.from(header ?? '', 'base64url').toString('utf8'),
    ) as Record<string, unknown>,
    claims: JSON.parse(
      Buffer.from(claims ?? '', 'base64url').toString('utf8'),
    ) as Record<string, unknown>,
    raw: payload.id_token,
    accessToken: payload.access_token,
  };
}

describe('discovery', () => {
  async function discovery(tenant = TENANT): Promise<Response> {
    return fetch(`${base}/${tenant}/v2.0/.well-known/openid-configuration`);
  }

  test('names the configured issuer byte for byte', async () => {
    const document = (await (await discovery()).json()) as { issuer: string };

    // processDiscoveryResponse compares this to
    // the issuer the client was configured with;
    // a trailing slash apart and sign-in fails.
    expect(document.issuer).toBe(ISSUER);
  });

  test('carries every field the callback dereferences', async () => {
    const document = (await (await discovery()).json()) as Record<
      string,
      unknown
    >;

    // handleOAuth throws unless discovery returns
    // both a token and a userinfo endpoint, even
    // though userinfo is never called when the
    // provider reads its profile from the
    // id_token.
    expect(document).toMatchObject({
      authorization_endpoint: `${ORIGIN}/${TENANT}/oauth2/v2.0/authorize`,
      token_endpoint: `${ORIGIN}/${TENANT}/oauth2/v2.0/token`,
      userinfo_endpoint: `${ORIGIN}/${TENANT}/openid/userinfo`,
      jwks_uri: `${ORIGIN}/${TENANT}/discovery/v2.0/keys`,
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
    });
  });

  test('knows only its own tenant', async () => {
    const response = await discovery('11111111-1111-4111-8111-111111111111');

    expect(response.status).toBe(404);
  });
});

async function publishedKeys(): Promise<JsonWebKey[]> {
  const response = await fetch(`${base}/${TENANT}/discovery/v2.0/keys`);
  const { keys } = (await response.json()) as { keys: JsonWebKey[] };

  return keys;
}

describe('JWKS', () => {
  test('publishes one RSA signing key with a kid', async () => {
    const keys = await publishedKeys();

    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kty: 'RSA', use: 'sig', alg: 'RS256' });
    expect(typeof keys[0]?.kid).toBe('string');
    expect(typeof keys[0]?.n).toBe('string');
    expect(typeof keys[0]?.e).toBe('string');
  });
});

describe('authorize', () => {
  test('redirects back to the client with a code', async () => {
    const { challenge } = pkce();
    const { status, location } = await authorize({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'openid profile email',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    expect(status).toBe(302);
    expect(`${location?.origin ?? ''}${location?.pathname ?? ''}`).toBe(
      REDIRECT_URI,
    );
    expect(location?.searchParams.get('code')).toBeTruthy();
  });

  test('echoes state when the client sent one', async () => {
    const { challenge } = pkce();
    const { location } = await authorize({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'openid',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'opaque-state',
    });

    expect(location?.searchParams.get('state')).toBe('opaque-state');
  });

  test('sends no state when the client sent none', async () => {
    // mboss-web sets no redirectProxyUrl, so
    // Auth.js runs pkce-only and never sends
    // state. A mock that invented one would put a
    // parameter on the wire the client is not
    // expecting.
    const { challenge } = pkce();
    const { location } = await authorize({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'openid',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    expect(location?.searchParams.has('state')).toBe(false);
  });

  test('refuses an unknown client', async () => {
    const { challenge } = pkce();
    const { status } = await authorize({
      client_id: 'someone-elses-app',
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'openid',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    // Refusing outright rather than redirecting
    // its own error: a misconfigured harness
    // should read as a 400 here, not as a
    // callback failure three hops away.
    expect(status).toBe(400);
  });

  test('refuses a request with no PKCE challenge', async () => {
    const { status } = await authorize({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'openid',
    });

    expect(status).toBe(400);
  });
});

describe('token', () => {
  test('exchanges a code for a bearer token and an id_token', async () => {
    const { verifier, challenge } = pkce();
    const code = await codeFor(challenge);

    const response = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload.token_type).toBe('Bearer');
    expect(typeof payload.access_token).toBe('string');
    expect(typeof payload.id_token).toBe('string');
  });

  test('refuses the wrong client secret', async () => {
    const { verifier, challenge } = pkce();
    const code = await codeFor(challenge);

    const response = await tokenRequest(
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      },
      'not-the-secret',
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'invalid_client' });
  });

  test('refuses a code a second time', async () => {
    const { verifier, challenge } = pkce();
    const code = await codeFor(challenge);
    const body = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    };

    expect((await tokenRequest(body)).status).toBe(200);

    const replay = await tokenRequest(body);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: 'invalid_grant' });
  });

  test('refuses a code_verifier that does not match the challenge', async () => {
    const { challenge } = pkce();
    const code = await codeFor(challenge);

    const response = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: pkce().verifier,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_grant' });
  });

  test('refuses a redirect_uri that differs from the authorize one', async () => {
    const { verifier, challenge } = pkce();
    const code = await codeFor(challenge);

    const response = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'http://localhost:3100/api/auth/callback/somewhere-else',
      code_verifier: verifier,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_grant' });
  });
});

describe('the id_token', () => {
  test('carries the claims oauth4webapi requires', async () => {
    const { header, claims } = await signIn();
    const now = Math.floor(Date.now() / 1000);

    expect(header).toMatchObject({ alg: 'RS256', typ: 'JWT' });
    expect(typeof header.kid).toBe('string');
    expect(claims.iss).toBe(ISSUER);
    expect(claims.aud).toBe(CLIENT_ID);
    expect(typeof claims.sub).toBe('string');
    expect(claims.iat).toBeLessThanOrEqual(now + 1);
    expect(claims.exp).toBeGreaterThan(now);
  });

  test('carries the identity mboss-web reads', async () => {
    const { claims } = await signIn();

    // tid is what canSignIn checks the tenant
    // against; without it the policy cannot run at
    // all, which is what forces this mock to be
    // HTTPS in the first place.
    expect(claims.tid).toBe(TENANT);
    expect(claims.email).toBe(DEFAULT_EMAIL);
    expect(claims.preferred_username).toBe(DEFAULT_EMAIL);
    expect(claims.name).toBe(DEFAULT_NAME);
  });

  test('carries no nonce claim even when authorize was sent one', async () => {
    // checks: ['pkce'] means no expected nonce
    // reaches the validator, and a nonce claim
    // that is merely present makes it throw. A
    // mock that helpfully echoed one would break
    // sign-in with an opaque Auth.js error hours
    // from here.
    const { claims } = await signIn({ nonce: 'a-nonce-the-client-invented' });

    expect(claims).not.toHaveProperty('nonce');
  });

  test('is signed by the published key', async () => {
    const { raw } = await signIn();
    const [published] = await publishedKeys();
    if (published === undefined) throw new Error('the mock published no key');

    const [header, claims, signature] = raw.split('.');
    const key = createPublicKey({ key: published, format: 'jwk' });

    const verified = createVerify('RSA-SHA256')
      .update(`${header}.${claims}`)
      .verify(key, Buffer.from(signature ?? '', 'base64url'));

    // Nothing in the authorization-code flow
    // verifies this signature today. Emitting one
    // that does not verify would be a trap the day
    // that tightens.
    expect(verified).toBe(true);
  });
});

describe('userinfo', () => {
  test('answers a bearer token with the same claims', async () => {
    const { accessToken, claims } = await signIn();

    const response = await fetch(`${base}/${TENANT}/openid/userinfo`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      sub: claims.sub,
      email: DEFAULT_EMAIL,
      tid: TENANT,
    });
  });

  test('refuses a request with no bearer token', async () => {
    const response = await fetch(`${base}/${TENANT}/openid/userinfo`);

    expect(response.status).toBe(401);
  });
});

describe('the control surface', () => {
  test('sets the identity the next sign-in mints', async () => {
    const identity = {
      email: 'intruder@evil-autoretryai.com',
      tid: '11111111-1111-4111-8111-111111111111',
      name: 'Not An Admin',
    };

    const response = await fetch(`${control}/_test/identity`, {
      method: 'POST',
      body: JSON.stringify(identity),
    });
    expect(response.status).toBe(204);

    const { claims } = await signIn();
    expect(claims).toMatchObject(identity);
  });

  test('falls back to the configured defaults field by field', async () => {
    await fetch(`${control}/_test/identity`, {
      method: 'POST',
      body: JSON.stringify({ email: 'someone@autoretryai.com' }),
    });

    const { claims } = await signIn();
    expect(claims.email).toBe('someone@autoretryai.com');
    expect(claims.tid).toBe(TENANT);
    expect(claims.name).toBe(DEFAULT_NAME);
  });

  test('reports the current identity', async () => {
    const response = await fetch(`${control}/_test/identity`);

    expect(await response.json()).toEqual({
      email: DEFAULT_EMAIL,
      tid: TENANT,
      name: DEFAULT_NAME,
    });
  });

  test('reset restores the defaults', async () => {
    await fetch(`${control}/_test/identity`, {
      method: 'POST',
      body: JSON.stringify({ email: 'someone@autoretryai.com' }),
    });

    const response = await fetch(`${control}/_test/reset`, { method: 'POST' });
    expect(response.status).toBe(204);

    const { claims } = await signIn();
    expect(claims.email).toBe(DEFAULT_EMAIL);
  });

  test('reset invalidates codes issued before it', async () => {
    const { verifier, challenge } = pkce();
    const code = await codeFor(challenge);

    await fetch(`${control}/_test/reset`, { method: 'POST' });

    const response = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
    expect(response.status).toBe(400);
  });

  test('GET /health answers for the container healthcheck', async () => {
    // Plain HTTP on purpose: the healthcheck and
    // the Playwright process reach the mock's
    // control surface without any cert handling.
    const response = await fetch(`${control}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});

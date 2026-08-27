import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomUUID,
  type JsonWebKey,
} from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * A tenant-pinned Microsoft Entra mock: enough of
 * the v2.0 endpoints for Auth.js to complete an
 * authorization-code sign-in, and a control
 * surface for choosing who signs in next.
 *
 * Two servers, deliberately.
 *
 * The protocol surface serves **HTTPS**. That is
 * not caution: @auth/core re-runs discovery after
 * the token exchange for the Entra provider, and
 * that one call is the only one in the library
 * that does not allow insecure requests. An http
 * issuer is refused before any of mBoss's own code
 * runs, localhost included.
 *
 * The control surface serves plain HTTP on its own
 * port, so the container healthcheck and the
 * Playwright process can drive the mock without
 * handling a certificate at all.
 *
 * No dependencies and no build step: `node
 * server.ts` runs this file as it stands.
 */

export type OidcMockConfig = {
  /** Byte-identical to the client's configured issuer. */
  issuer: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  defaultEmail: string;
  defaultName: string;
};

/** Who the next sign-in is. */
export type Identity = {
  email: string;
  tid: string;
  name: string;
};

export type OidcMock = {
  /** The OIDC endpoints. HTTPS in the stack. */
  protocol: RequestListener;
  /** `/_test/*` and `/health`. Plain HTTP. */
  control: RequestListener;
};

type IssuedCode = {
  redirectUri: string;
  codeChallenge: string;
  identity: Identity;
};

export function createOidcMock(config: OidcMockConfig): OidcMock {
  const origin = new URL(config.issuer).origin;
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const publicJwk = publicKey.export({ format: 'jwk' });
  const kid = createHash('sha256')
    .update(String(publicJwk.n))
    .digest('base64url')
    .slice(0, 16);
  const jwk: JsonWebKey = { ...publicJwk, kid, use: 'sig', alg: 'RS256' };

  const defaults: Identity = {
    email: config.defaultEmail,
    tid: config.tenantId,
    name: config.defaultName,
  };

  /**
   * One current identity rather than a directory
   * of users. The suite runs `workers: 1`, so
   * exactly one test is signing in at a time, and
   * a test that sets this explicitly is stating
   * who it means rather than hoping.
   */
  let identity: Identity = { ...defaults };
  const codes = new Map<string, IssuedCode>();
  const accessTokens = new Map<string, Record<string, unknown>>();

  const discovery = {
    issuer: config.issuer,
    authorization_endpoint: `${origin}/${config.tenantId}/oauth2/v2.0/authorize`,
    token_endpoint: `${origin}/${config.tenantId}/oauth2/v2.0/token`,
    userinfo_endpoint: `${origin}/${config.tenantId}/openid/userinfo`,
    jwks_uri: `${origin}/${config.tenantId}/discovery/v2.0/keys`,
    response_types_supported: ['code', 'id_token', 'code id_token'],
    response_modes_supported: ['query', 'fragment', 'form_post'],
    subject_types_supported: ['pairwise'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: ['openid', 'profile', 'email'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: [
      'client_secret_basic',
      'client_secret_post',
    ],
    code_challenge_methods_supported: ['S256'],
  };

  function authorize(url: URL, response: ServerResponse): void {
    const query = url.searchParams;
    const redirectUri = query.get('redirect_uri');
    const codeChallenge = query.get('code_challenge');

    // These refusals answer where they happen. A
    // mock that redirected its own errors would
    // surface a misconfigured harness as a
    // callback failure three hops away.
    if (query.get('client_id') !== config.clientId)
      return json(response, 400, {
        error: 'unauthorized_client',
        error_description: `unknown client_id ${query.get('client_id')}`,
      });
    if (redirectUri === null || redirectUri === '')
      return json(response, 400, {
        error: 'invalid_request',
        error_description: 'redirect_uri is required',
      });
    if (codeChallenge === null || query.get('code_challenge_method') !== 'S256')
      return json(response, 400, {
        error: 'invalid_request',
        error_description: 'an S256 code_challenge is required',
      });

    const code = randomUUID();
    codes.set(code, { redirectUri, codeChallenge, identity: { ...identity } });

    const location = new URL(redirectUri);
    location.searchParams.set('code', code);
    // `nonce` is read and dropped on the floor —
    // see mintIdToken. `state` is echoed only when
    // the client sent one, which Auth.js, running
    // pkce-only checks, does not.
    const state = query.get('state');
    if (state !== null) location.searchParams.set('state', state);

    response.writeHead(302, { location: location.toString() });
    response.end();
  }

  async function token(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const form = new URLSearchParams(await readText(request));
    const credentials = clientCredentials(request, form);
    if (
      credentials.id !== config.clientId ||
      credentials.secret !== config.clientSecret
    )
      return json(response, 401, { error: 'invalid_client' });

    if (form.get('grant_type') !== 'authorization_code')
      return json(response, 400, { error: 'unsupported_grant_type' });

    const code = form.get('code') ?? '';
    const issued = codes.get(code);
    // Single use: the entry is dropped whether or
    // not the rest of the exchange checks out, so
    // a replay is invalid_grant either way.
    codes.delete(code);

    if (issued === undefined)
      return invalidGrant(response, 'unknown or already redeemed code');
    if (issued.redirectUri !== form.get('redirect_uri'))
      return invalidGrant(
        response,
        'redirect_uri does not match the authorize request',
      );
    if (challengeOf(form.get('code_verifier') ?? '') !== issued.codeChallenge)
      return invalidGrant(
        response,
        'code_verifier does not match the challenge',
      );

    const claims = claimsFor(issued.identity);
    const accessToken = randomUUID();
    accessTokens.set(accessToken, claims);

    json(response, 200, {
      token_type: 'Bearer',
      access_token: accessToken,
      expires_in: 3600,
      scope: 'openid profile email',
      id_token: sign(claims),
    });
  }

  function userinfo(request: IncomingMessage, response: ServerResponse): void {
    const header = request.headers.authorization ?? '';
    const claims = header.startsWith('Bearer ')
      ? accessTokens.get(header.slice('Bearer '.length))
      : undefined;

    if (claims === undefined)
      return json(response, 401, { error: 'invalid_token' });

    json(response, 200, claims);
  }

  /**
   * The id_token's claims.
   *
   * Nothing verifies the signature in the
   * authorization-code flow, but the required
   * claims are checked, `iss` must equal the
   * discovered issuer and `aud` the client id.
   *
   * There is deliberately **no `nonce`**. mboss-web
   * runs pkce-only checks, so no expected nonce
   * reaches the validator and a nonce claim that
   * is merely present makes it throw.
   */
  function claimsFor(who: Identity): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);

    return {
      iss: config.issuer,
      aud: config.clientId,
      sub: stableId(`sub:${who.email}`),
      oid: uuidFor(who.email),
      tid: who.tid,
      email: who.email,
      preferred_username: who.email,
      name: who.name,
      ver: '2.0',
      iat: now,
      exp: now + 3600,
    };
  }

  function sign(claims: Record<string, unknown>): string {
    const signingInput =
      `${base64url({ alg: 'RS256', typ: 'JWT', kid })}.` +
      `${base64url(claims)}`;
    const signature = createSign('RSA-SHA256')
      .update(signingInput)
      .sign(privateKey)
      .toString('base64url');

    return `${signingInput}.${signature}`;
  }

  async function protocolRoute(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? '/', origin);
    const method = request.method ?? 'GET';
    const path = url.pathname;

    if (
      method === 'GET' &&
      path === tenantPath('/v2.0/.well-known/openid-configuration')
    )
      return json(response, 200, discovery);
    if (method === 'GET' && path === tenantPath('/discovery/v2.0/keys'))
      return json(response, 200, { keys: [jwk] });
    if (method === 'GET' && path === tenantPath('/oauth2/v2.0/authorize'))
      return authorize(url, response);
    if (method === 'POST' && path === tenantPath('/oauth2/v2.0/token'))
      return await token(request, response);
    if (method === 'GET' && path === tenantPath('/openid/userinfo'))
      return userinfo(request, response);

    // A path under another tenant is a 404, not a
    // stub: this mock stands for one tenant, and a
    // harness pointed at the wrong one should say
    // so rather than sign somebody in.
    json(response, 404, {
      error: 'not_found',
      error_description: `no ${method} ${path} in tenant ${config.tenantId}`,
    });
  }

  async function controlRoute(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://oidc-mock');
    const method = request.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/health')
      return json(response, 200, { ok: true });
    if (method === 'GET' && url.pathname === '/_test/identity')
      return json(response, 200, identity);
    if (method === 'POST' && url.pathname === '/_test/identity') {
      const body = (await readJson(request)) as Partial<Identity> | undefined;
      identity = {
        email: body?.email ?? defaults.email,
        tid: body?.tid ?? defaults.tid,
        name: body?.name ?? defaults.name,
      };
      return noContent(response);
    }
    if (method === 'POST' && url.pathname === '/_test/reset') {
      identity = { ...defaults };
      codes.clear();
      accessTokens.clear();
      return noContent(response);
    }

    json(response, 404, {
      error: 'not_found',
      error_description: `no ${method} ${url.pathname} on the control surface`,
    });
  }

  function tenantPath(suffix: string): string {
    return `/${config.tenantId}${suffix}`;
  }

  return {
    protocol: (request, response) => {
      protocolRoute(request, response).catch((error: unknown) => {
        json(response, 500, {
          error: 'server_error',
          error_description: String(error),
        });
      });
    },
    control: (request, response) => {
      controlRoute(request, response).catch((error: unknown) => {
        json(response, 500, {
          error: 'server_error',
          error_description: String(error),
        });
      });
    },
  };
}

function invalidGrant(response: ServerResponse, description: string): void {
  json(response, 400, {
    error: 'invalid_grant',
    error_description: description,
  });
}

/** Client auth by Basic header or by form fields. */
function clientCredentials(
  request: IncomingMessage,
  form: URLSearchParams,
): { id: string | null; secret: string | null } {
  const header = request.headers.authorization ?? '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(
      header.slice('Basic '.length),
      'base64',
    ).toString('utf8');
    const separator = decoded.indexOf(':');

    return separator === -1
      ? { id: decoded, secret: null }
      : {
          id: decodeURIComponent(decoded.slice(0, separator)),
          secret: decodeURIComponent(decoded.slice(separator + 1)),
        };
  }

  return { id: form.get('client_id'), secret: form.get('client_secret') };
}

function challengeOf(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** The same address always gets the same subject. */
function stableId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

/** A GUID-shaped `oid`, stable per address. */
function uuidFor(email: string): string {
  const hex = stableId(`oid:${email}`);

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

async function readText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);

  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  try {
    return JSON.parse(await readText(request)) as unknown;
  } catch {
    return undefined;
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function noContent(response: ServerResponse): void {
  response.writeHead(204);
  response.end();
}

function main(): void {
  const tenantId = process.env.OIDC_TENANT_ID ?? '';
  const port = Number(process.env.PORT ?? 8443);
  const controlPort = Number(process.env.CONTROL_PORT ?? 8081);
  const mock = createOidcMock({
    issuer:
      process.env.OIDC_ISSUER ?? `https://oidc-mock:${port}/${tenantId}/v2.0`,
    tenantId,
    clientId: process.env.OIDC_CLIENT_ID ?? 'e2e-client-id',
    clientSecret: process.env.OIDC_CLIENT_SECRET ?? 'e2e-client-secret',
    defaultEmail: process.env.OIDC_DEFAULT_EMAIL ?? 'e2e@autoretryai.com',
    defaultName: process.env.OIDC_DEFAULT_NAME ?? 'E2E Admin',
  });

  createHttpsServer(
    {
      cert: readFileSync(process.env.TLS_CERT ?? '/app/tls/cert.pem'),
      key: readFileSync(process.env.TLS_KEY ?? '/app/tls/key.pem'),
    },
    mock.protocol,
  ).listen(port, () => {
    console.log(`oidc-mock serving https on ${port}`);
  });

  createHttpServer(mock.control).listen(controlPort, () => {
    console.log(`oidc-mock control surface on ${controlPort}`);
  });
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  import.meta.url === pathToFileURL(entryPoint).href
)
  main();

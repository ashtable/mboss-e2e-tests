import { encode } from 'next-auth/jwt';

import type { BrowserContext } from '@playwright/test';

/**
 * A signed-in admin, without an Entra round trip.
 *
 * This is the app's own crypto used by a test, not a
 * bypass: nothing is added to mboss-web to make it
 * work, and a wrong secret produces a cookie the app
 * reads as "not signed in" rather than a special
 * case that silently succeeds.
 *
 * Auth.js encrypts its session JWT and salts the key
 * derivation with the cookie's own name, so the two
 * constants below have to match what the app uses
 * over plain http. On https the cookie gains the
 * `__Secure-` prefix and the salt changes with it.
 */
const COOKIE_NAME = 'authjs.session-token';

/**
 * The compose stack's AUTH_SECRET. The default lives
 * in mboss-web/.env.local, which the superproject's
 * docker-compose.yml reads directly; set the
 * variable here too when running against a stack
 * that overrides it.
 */
const SECRET = process.env.AUTH_SECRET ?? 'dev-auth-secret';

const THIRTY_DAYS_IN_SECONDS = 30 * 24 * 60 * 60;

/**
 * Gives `context` a session for `email`. The address
 * is what the console shows in its nav and what the
 * API records as the actor on a broadcast, so a spec
 * that asserts on either passes the same string it
 * signed in with.
 */
export async function signInAs(
  context: BrowserContext,
  email: string,
  baseURL: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const token = await encode({
    salt: COOKIE_NAME,
    secret: SECRET,
    maxAge: THIRTY_DAYS_IN_SECONDS,
    token: {
      email,
      name: email,
      sub: email,
      iat: now,
      exp: now + THIRTY_DAYS_IN_SECONDS,
    },
  });

  await context.addCookies([
    {
      name: COOKIE_NAME,
      value: token,
      url: baseURL,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
}

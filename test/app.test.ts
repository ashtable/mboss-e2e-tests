import { describe, expect, test } from 'vitest';

import {
  APP_PORT,
  COMPOSE_OVERRIDE,
  POSTGRES_PORT,
  parseEnv,
  withEnv,
} from '../helpers/app.js';

/**
 * The parts of running a generated app that are
 * decisions rather than plumbing.
 *
 * A scaffolded `.env` is the app's own file, and
 * the spec has to move three of its values without
 * disturbing the rest — the ports, because two
 * other stacks are already on this machine, and the
 * mail root, because the sink is a host process
 * this run started. Rewriting it by hand is the
 * kind of thing that silently half-works: a name
 * the scaffold renamed would be appended instead of
 * replaced, and the app would boot on the value it
 * shipped with and collide.
 */

/** A `.env` shaped like the one the scaffold
 *  writes, comments and quoting included. */
const ENV = `# Written by mBoss when this project was created.

DATABASE_URL="postgres://app:app@localhost:5432/app"
DBOS_SYSTEM_DATABASE_URL="postgres://app:app@localhost:5432/app"

# Where this app answers.
APP_BASE_URL="http://localhost:3000"
PORT="3000"
EVENTS_SECRET="8f1c00ab"
TWILIO_EMAIL_BASE_URL="https://comms.twilio.com"
`;

describe('parseEnv', () => {
  test('reads the values the scaffold minted', () => {
    expect(parseEnv(ENV)['EVENTS_SECRET']).toBe('8f1c00ab');
  });

  test('drops the quotes and keeps the comments out', () => {
    expect(parseEnv(ENV)['APP_BASE_URL']).toBe('http://localhost:3000');
    expect(
      parseEnv(ENV)['# Written by mBoss when this project was created.'],
    ).toBeUndefined();
  });
});

describe('withEnv', () => {
  test('replaces a value in place', () => {
    const rewritten = withEnv(ENV, { PORT: '3200' });

    expect(parseEnv(rewritten)['PORT']).toBe('3200');
    expect(rewritten).toContain('# Where this app answers.');
    expect(parseEnv(rewritten)['EVENTS_SECRET']).toBe('8f1c00ab');
  });

  test('replaces several at once', () => {
    const rewritten = parseEnv(
      withEnv(ENV, {
        PORT: '3200',
        APP_BASE_URL: 'http://127.0.0.1:3200',
        TWILIO_EMAIL_BASE_URL: 'http://127.0.0.1:8125',
      }),
    );

    expect(rewritten['PORT']).toBe('3200');
    expect(rewritten['APP_BASE_URL']).toBe('http://127.0.0.1:3200');
    expect(rewritten['TWILIO_EMAIL_BASE_URL']).toBe('http://127.0.0.1:8125');
  });

  /**
   * The failure worth being loud about. A variable
   * the scaffold renamed would otherwise be added
   * as a new line while the old one went on
   * winning, and the app would come up on a port
   * something else already holds — reported as a
   * bind error with no hint of why.
   */
  test('refuses a name the file does not set', () => {
    expect(() => withEnv(ENV, { PORT_NUMBER: '3200' })).toThrow(/PORT_NUMBER/);
  });
});

describe('COMPOSE_OVERRIDE', () => {
  /**
   * Compose concatenates `ports` when it merges, so
   * an override that only added the new mapping
   * would leave the emitted `5432` published as
   * well — straight into the dev stack's Postgres.
   * The tag is what replaces the list.
   */
  test('replaces the published port rather than adding to it', () => {
    expect(COMPOSE_OVERRIDE).toContain('ports: !override');
    expect(COMPOSE_OVERRIDE).toContain(`127.0.0.1:${POSTGRES_PORT}:5432`);
  });

  test('moves off both of the other stacks', () => {
    // The dev stack is 5432/3000 and this repo's
    // own is 5433/3100.
    expect([5432, 5433]).not.toContain(POSTGRES_PORT);
    expect([3000, 3100]).not.toContain(APP_PORT);
  });
});

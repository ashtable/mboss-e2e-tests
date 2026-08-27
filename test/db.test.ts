import { describe, expect, test } from 'vitest';

import { TRUNCATE_PUBLIC_SQL, subscriberSeed } from '../helpers/db.js';

/**
 * The pure half of the database helper: what a
 * seeded row looks like, and what the reset
 * touches.
 *
 * The query functions are proved by the specs that
 * run them against the real Postgres. What is
 * worth pinning without a database is the shape of
 * a row the app could actually have produced — a
 * seed that skipped a column Prisma fills would
 * either fail to insert or leave the console
 * showing something the product never writes.
 */

describe('subscriberSeed', () => {
  test('supplies the two columns the database has no default for', () => {
    const row = subscriberSeed({ email: 'reader@e2e.test' });

    // @default(cuid()) and @updatedAt are
    // Prisma-client-side. The migration gives
    // "createdAt" a CURRENT_TIMESTAMP default and
    // gives these two nothing, so a raw insert
    // that omits them is rejected.
    expect(row.id).toBeTruthy();
    expect(row.updatedAt).toBeInstanceOf(Date);
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  test('gives every row its own id', () => {
    const first = subscriberSeed({ email: 'one@e2e.test' });
    const second = subscriberSeed({ email: 'two@e2e.test' });

    expect(first.id).not.toBe(second.id);
  });

  test('defaults to a plain self-serve subscriber', () => {
    const row = subscriberSeed({ email: 'reader@e2e.test' });

    expect(row).toMatchObject({
      email: 'reader@e2e.test',
      status: 'subscribed',
      source: 'email',
      tokenVersion: 1,
      confirmationEmailSentAt: null,
      pausedAt: null,
      unsubscribedAt: null,
      bouncedAt: null,
    });
  });

  test('stamps the timestamp that names the status', () => {
    // The nullable timestamps mirror the status
    // one for one. A paused row with no pausedAt
    // is a state the app never writes, and seeding
    // one would test the console against fiction.
    expect(
      subscriberSeed({ email: 'a@e2e.test', status: 'paused' }),
    ).toMatchObject({
      pausedAt: expect.any(Date),
      unsubscribedAt: null,
      bouncedAt: null,
    });
    expect(
      subscriberSeed({ email: 'b@e2e.test', status: 'unsubscribed' }),
    ).toMatchObject({
      pausedAt: null,
      unsubscribedAt: expect.any(Date),
      bouncedAt: null,
    });
    expect(
      subscriberSeed({ email: 'c@e2e.test', status: 'bounced' }),
    ).toMatchObject({
      pausedAt: null,
      unsubscribedAt: null,
      bouncedAt: expect.any(Date),
    });
  });

  test('takes a confirmation timestamp when the caller supplies one', () => {
    // Seeding with this set is how a spec adds an
    // audience without every row enqueueing a
    // confirmation workflow.
    const sentAt = new Date('2026-08-01T00:00:00.000Z');

    expect(
      subscriberSeed({ email: 'd@e2e.test', confirmationEmailSentAt: sentAt })
        .confirmationEmailSentAt,
    ).toBe(sentAt);
  });
});

describe('TRUNCATE_PUBLIC_SQL', () => {
  test('names the three application tables', () => {
    for (const table of ['BroadcastDelivery', 'Broadcast', 'Subscriber'])
      expect(TRUNCATE_PUBLIC_SQL).toContain(`"${table}"`);
  });

  test('leaves the dbos schema alone', () => {
    // Terminal workflow rows are inert, and
    // deleting them would break DBOS's own
    // bookkeeping — including the idempotency the
    // confirmation workflow ids depend on.
    expect(TRUNCATE_PUBLIC_SQL).not.toContain('dbos');
  });
});

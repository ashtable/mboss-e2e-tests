import { describe, expect, test } from 'vitest';

import { messagesQuery } from '../helpers/mail.js';

/**
 * Only the query building is tested here: the rest
 * of helpers/mail.ts is fetch against a sink that
 * has its own tests one file over, and the specs
 * exercise both together.
 *
 * A filter that quietly went missing is the failure
 * worth catching — a poll for "the message to this
 * address" that actually asks for every message
 * would pass on somebody else's mail.
 */

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

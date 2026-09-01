import { describe, expect, test } from 'vitest';

import {
  LinkExtractionError,
  formUrlFrom,
  listUnsubscribeOf,
  manageUrlFrom,
  tokenOf,
} from '../helpers/links.js';

/**
 * The suite reads signed links out of the mail it
 * captured; it never mints one. That is the whole
 * point of these four functions, so the shapes
 * they parse are the shapes mBoss actually emits —
 * the address line `renderShell` writes, the form
 * button a generated app's template writes, and the
 * RFC 8058 header pair `listUnsubscribeHeaders`
 * writes — pasted here rather than paraphrased.
 */

/** `mintLink`'s shape: two base64url parts, dotted. */
const TOKEN =
  'eyJraWQiOiJrMSIsInNpZCI6ImMxIiwidHYiOjEsInNjb3BlIjoibWFuYWdlIn0.' +
  'Zm9vYmFyc2lnbmF0dXJlLWJhc2U2NHVybA';

function addressLine(href: string): string {
  return (
    '<div style="text-align:center;font:400 9.5px ui-monospace;' +
    'color:#6b7280;margin-top:10px">' +
    `mBoss · Seattle, WA · <a href="${href}" style="color:#6b7280">` +
    'unsubscribe</a></div>'
  );
}

describe('manageUrlFrom', () => {
  test('pulls the manage URL out of the address line', () => {
    const href = `http://localhost:3100/u/${TOKEN}`;

    expect(manageUrlFrom(addressLine(href))).toBe(href);
  });

  test('throws a named error when the mail carries no manage link', () => {
    // A template regression that drops the link
    // has to fail here, loudly, rather than leave
    // a later assertion comparing undefined.
    expect(() => manageUrlFrom(addressLine(''))).toThrow(LinkExtractionError);
  });

  test('ignores links that are not manage links', () => {
    const href = `http://localhost:3100/u/${TOKEN}`;
    const html =
      '<a href="https://mboss.dev/docs">docs</a>\n' + addressLine(href);

    expect(manageUrlFrom(html)).toBe(href);
  });
});

describe('formUrlFrom', () => {
  /** The button a generated app's form email
   *  carries, verbatim from the template's own
   *  snapshot. */
  function formButton(href: string): string {
    return (
      '<div style="text-align:center;margin-top:16px">' +
      `<a href="${href}" style="display:inline-block;background:#5980a6;` +
      "color:#fff;font:600 12.5px 'Barlow Condensed', system-ui, sans-serif;" +
      'letter-spacing:.05em;padding:9px 18px;text-decoration:none">' +
      'Open your secure form</a></div>'
    );
  }

  test('pulls the form URL out of the button', () => {
    const href = `http://127.0.0.1:3200/f/${TOKEN}`;

    expect(formUrlFrom(formButton(href))).toBe(href);
  });

  /**
   * A form email carries the app's own header and
   * footer as well, and the link is found by its
   * path rather than by being the only one.
   */
  test('ignores links that are not form links', () => {
    const href = `http://127.0.0.1:3200/f/${TOKEN}`;
    const html =
      '<a href="http://127.0.0.1:3200/a/other">an artifact</a>\n' +
      formButton(href);

    expect(formUrlFrom(html)).toBe(href);
  });

  test('throws a named error when the mail carries no form link', () => {
    expect(() => formUrlFrom(formButton(''))).toThrow(LinkExtractionError);
  });
});

describe('tokenOf', () => {
  test('returns the last path segment', () => {
    expect(tokenOf(`http://localhost:3100/u/${TOKEN}`)).toBe(TOKEN);
  });

  test('reads the same token out of a one-click URL', () => {
    // The manage link and the List-Unsubscribe URL
    // carry one token between them, which is what
    // makes comparing them a real cross-check.
    expect(tokenOf(`http://localhost:3100/api/unsubscribe/${TOKEN}`)).toBe(
      TOKEN,
    );
  });
});

describe('listUnsubscribeOf', () => {
  const header = `<http://localhost:3100/api/unsubscribe/${TOKEN}>, <mailto:unsubscribe@mboss.dev>`;

  test('splits the two URIs', () => {
    expect(listUnsubscribeOf({ 'List-Unsubscribe': header })).toEqual({
      url: `http://localhost:3100/api/unsubscribe/${TOKEN}`,
      mailto: 'unsubscribe@mboss.dev',
    });
  });

  test('finds the header whatever case it arrived in', () => {
    expect(listUnsubscribeOf({ 'list-unsubscribe': header }).mailto).toBe(
      'unsubscribe@mboss.dev',
    );
  });

  test('rejects a value carrying only one URI', () => {
    expect(() =>
      listUnsubscribeOf({
        'List-Unsubscribe': '<http://localhost:3100/api/unsubscribe/t>',
      }),
    ).toThrow(LinkExtractionError);
  });

  test('rejects an unbracketed value', () => {
    expect(() =>
      listUnsubscribeOf({
        'List-Unsubscribe':
          'http://localhost:3100/api/unsubscribe/t, mailto:unsubscribe@mboss.dev',
      }),
    ).toThrow(LinkExtractionError);
  });

  test('rejects a message with no List-Unsubscribe header at all', () => {
    expect(() => listUnsubscribeOf({})).toThrow(LinkExtractionError);
  });
});

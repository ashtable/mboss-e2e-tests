/**
 * Reading signed links back out of captured mail.
 *
 * The suite holds no `LINK_KEYS` value and never
 * imports `mintLink`: a harness that mints its own
 * links stops testing the minting. Everything a
 * spec follows was written by the worker into an
 * email the mailsink kept.
 */

/** A shape the mail was expected to carry and did not. */
export class LinkExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinkExtractionError';
  }
}

/**
 * Every `href` in the document, in source order.
 * The mail is generated markup with double-quoted
 * attributes, so a regex reads it exactly; a
 * parser would be a dependency to buy the same
 * answer.
 */
const HREF = /<a\s[^>]*href="([^"]*)"/g;

/** `…/u/<token>`, with nothing after the token. */
const MANAGE_PATH = /\/u\/[^/?#]+$/;

/**
 * The manage URL out of a rendered email — the one
 * the address line's "unsubscribe" points at.
 * Links elsewhere in the body are skipped by their
 * path, not by their position.
 */
export function manageUrlFrom(html: string): string {
  for (const match of html.matchAll(HREF)) {
    const href = match[1];
    if (href !== undefined && MANAGE_PATH.test(href)) return href;
  }

  throw new LinkExtractionError(
    'no /u/<token> link in the email — the template stopped emitting one',
  );
}

/** `…/f/<token>`, with nothing after the token. */
const FORM_PATH = /\/f\/[^/?#]+$/;

/**
 * The form URL out of a generated app's email —
 * the one its button points at. Approvals mint an
 * ordinary form token too, so this finds both.
 *
 * Read out of the captured HTML and never minted,
 * for the same reason as the manage link: a link
 * the suite made itself would verify whatever the
 * app had done.
 */
export function formUrlFrom(html: string): string {
  for (const match of html.matchAll(HREF)) {
    const href = match[1];
    if (href !== undefined && FORM_PATH.test(href)) return href;
  }

  throw new LinkExtractionError(
    'no /f/<token> link in the email — the form was never attached',
  );
}

/**
 * The token a signed link carries. The manage link
 * and the one-click unsubscribe URL are minted
 * from the same claims, so comparing what this
 * returns for both is a real cross-check.
 */
export function tokenOf(url: string): string {
  const token = new URL(url).pathname.split('/').pop();
  if (token === undefined || token === '')
    throw new LinkExtractionError(`no token at the end of ${url}`);

  return token;
}

export type ListUnsubscribe = {
  /** The one-click POST endpoint. */
  url: string;
  /** The address, without the `mailto:` scheme. */
  mailto: string;
};

/** Both bracketed URIs, in `<uri>` order. */
const URI = /<([^>]+)>/g;

/**
 * The two URIs an RFC 8058 `List-Unsubscribe`
 * carries. A value with one URI, or with the
 * brackets missing, is refused rather than
 * half-parsed: both are wire regressions a mail
 * client would act on differently, and neither
 * should read as "no unsubscribe support".
 */
export function listUnsubscribeOf(
  headers: Record<string, string>,
): ListUnsubscribe {
  const raw = headerValue(headers, 'list-unsubscribe');
  if (raw === undefined)
    throw new LinkExtractionError('the message carries no List-Unsubscribe');

  const uris = [...raw.matchAll(URI)].map((match) => match[1] ?? '');
  const [url, mailto] = uris;
  if (uris.length !== 2 || url === undefined || mailto === undefined)
    throw new LinkExtractionError(
      `List-Unsubscribe is not two bracketed URIs: ${raw}`,
    );

  if (!/^https?:\/\//.test(url))
    throw new LinkExtractionError(
      `List-Unsubscribe's first URI is not http: ${raw}`,
    );

  if (!mailto.startsWith('mailto:'))
    throw new LinkExtractionError(
      `List-Unsubscribe's second URI is not a mailto: ${raw}`,
    );

  return { url, mailto: mailto.slice('mailto:'.length) };
}

/**
 * Header names are case-insensitive on the wire,
 * and what the sink recorded is whatever casing
 * the sender used.
 */
function headerValue(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  for (const [key, value] of Object.entries(headers))
    if (key.toLowerCase() === name) return value;

  return undefined;
}

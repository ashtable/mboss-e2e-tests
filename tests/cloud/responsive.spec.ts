import { expect, test } from '@playwright/test';

import type { Locator, Page } from '@playwright/test';

/**
 * The quality floor: a phone can read the page, a
 * keyboard can use it, and a reader who has asked for
 * less motion gets it.
 *
 * The mockups are desktop artboards and the design
 * document says nothing about small screens, so
 * nothing here is a copy or layout claim — every
 * assertion is about the page still working. That
 * makes it the floor rather than a design test, and
 * it deliberately stops there: this is not an
 * accessibility audit, and growing it into one would
 * bury the four things it does prove.
 *
 * The overflow cases are here because two real bugs
 * were: a nav that would not wrap around its ~210px
 * unbreakable repo URL, and cards given a definite
 * `width`, which is also their min-content
 * contribution and so grew the centring track they
 * were meant to be clamped by. Both fixes landed in
 * mboss-web just before this file was written, so the
 * assertions were never watched failing on a built
 * artifact. They were checked against the two layouts
 * put back at runtime, which is where these numbers
 * come from: the landing page ran 28px past the edge
 * at 390px and 98px at 320px, and the manage page —
 * the one nearly everyone opens from an email on a
 * phone — ran 134px past it at 320px.
 */

const PHONE = { width: 390, height: 844 };
const POCKET_PHONE = { width: 320, height: 568 };

/**
 * Every route a stranger can reach without a session,
 * with the heading that says the page arrived. A
 * zero-overflow assertion holds just as well on a
 * blank document, so each case names its page first.
 */
const ROUTES = [
  ['/', 'Design durable apps.'],
  ['/admin', 'Admin sign-in'],
  ['/u/not-a-real-token', "That link doesn't work."],
] as const;

for (const viewport of [PHONE, POCKET_PHONE]) {
  for (const [path, heading] of ROUTES) {
    test(`${path} does not scroll sideways at ${viewport.width}px`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.goto(path);

      await expect(page.getByRole('heading', { name: heading })).toBeVisible();

      const overflow = await page.evaluate(() => {
        const element = document.documentElement;
        return element.scrollWidth - element.clientWidth;
      });
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
}

test('the narrow nav wraps rather than dropping a word', async ({ page }) => {
  await page.setViewportSize(POCKET_PHONE);
  await page.goto('/');

  // The cheap way to stop a nav overflowing is to
  // hide the widest thing in it below a breakpoint.
  // The repo URL is copy the design names, and a
  // visitor on a phone is exactly who has not seen
  // the repo yet.
  const repo = page.locator('nav a[href^="https://github.com/ashtable/mboss"]');
  await expect(repo).toBeVisible();
  await expect(repo).toHaveText('github.com/ashtable/mboss');

  // Wrapped, so it is on a line of its own, below
  // the brand rather than beside it.
  const brandBox = await page.locator('nav .nav-brand').boundingBox();
  const repoBox = await repo.boundingBox();
  if (brandBox === null || repoBox === null) {
    throw new Error('the nav did not lay out');
  }
  expect(repoBox.y).toBeGreaterThan(brandBox.y);
});

test('the join box takes a signup from the keyboard alone', async ({
  page,
}) => {
  const email = `wl-${Date.now()}@example.test`;

  await page.goto('/');

  // The join box is the page's one client island, and
  // for about a dozen milliseconds after the document
  // loads it is not listening yet. The button ships
  // `disabled` for exactly that span, so waiting for
  // it to clear is waiting for hydration — through
  // the page's own public signal rather than by
  // reading React's private fields off the form, which
  // is what this waited on before the button carried
  // the state itself.
  await expect(
    page.getByRole('button', { name: 'Join waitlist' }),
  ).toBeEnabled();

  const field = page.getByPlaceholder('you@company.com');
  await tabTo(page, field);
  await expect(field).toBeFocused();

  await page.keyboard.type(email);

  // Enter in the only text field of a form with a
  // submit button, which is how a keyboard sends a
  // one-field form. Reaching for the button by Tab
  // works too and is not the path worth guarding.
  await page.keyboard.press('Enter');

  const card = page.locator('main .blueprint').first();
  const heading = card.getByRole('heading');
  await expect(heading).toHaveText("You're on the list.");
  await expect(card).toContainText(email);

  // The card replaces the form the reader was
  // standing in, so focus has nowhere to go but the
  // body unless it is sent somewhere: a screen
  // reader would announce nothing back, and the next
  // Tab would restart at the top of the page. The
  // heading takes it instead, which answers both at
  // once — the card is read out, and Tab carries on
  // from where the reader actually is.
  await expect(heading).toBeFocused();
});

test('the join button paints a focus ring for the keyboard', async ({
  page,
}) => {
  await page.goto('/');

  const button = page.getByRole('button', { name: 'Join waitlist' });
  await tabTo(page, button);
  await expect(button).toBeFocused();

  // The base rule sets `outline: none` on :focus and
  // paints only on :focus-visible, so a ring that
  // stopped resolving would read as 0px here rather
  // than as some other colour. The Tab is used
  // because it is the interaction the rule is
  // written for — not as a control, since Chromium
  // also matches :focus-visible for a programmatic
  // focus once the document has seen a key press.
  const ring = await button.evaluate((node) => {
    const computed = getComputedStyle(node);
    return {
      width: computed.outlineWidth,
      style: computed.outlineStyle,
      color: computed.outlineColor,
      offset: computed.outlineOffset,
    };
  });
  expect(ring).toEqual({
    width: '2px',
    style: 'solid',
    // --color-accent, #5980a6.
    color: 'rgb(89, 128, 166)',
    offset: '2px',
  });
});

test('a request for less motion is already honoured', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');

  await expect(
    page.getByRole('heading', { name: 'Design durable apps.' }),
  ).toBeVisible();

  // There is no motion on this page to reduce, and
  // that is the correct answer for a design built out
  // of hairlines and registration marks rather than a
  // sign that a media query is missing. The assertion
  // is a tripwire: the first transition or keyframe
  // that arrives has to arrive with an escape hatch,
  // and this fails until it does.
  const moving = await page.evaluate(() => {
    const animated = [...document.querySelectorAll('*')].filter((node) => {
      const computed = getComputedStyle(node);
      return (
        computed.animationName !== 'none' ||
        parseFloat(computed.transitionDuration) > 0
      );
    });
    return {
      declared: animated.length,
      running: document.getAnimations().length,
    };
  });
  expect(moving).toEqual({ declared: 0, running: 0 });
});

/**
 * Presses Tab until `target` holds focus. Counting
 * presses rather than calling `.focus()` is the whole
 * point of the two tests that use it: `:focus-visible`
 * is defined in terms of how focus arrived, and the
 * reachability itself is worth proving — an element
 * no number of Tabs reaches is one a keyboard cannot
 * use at all.
 */
async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let press = 0; press < 10; press += 1) {
    await page.keyboard.press('Tab');
    const focused = await target.evaluate(
      (node) => node === document.activeElement,
    );
    if (focused) return;
  }
  throw new Error(`${target} is not reachable by Tab`);
}

import { expect, test } from '@playwright/test';

/**
 * The landing page's copy, verbatim.
 *
 * The design writes this page in specific words —
 * lowercase machine text, an em dash where a colon
 * would be ordinary, a promise about email that is
 * three sentences long. Copy drifts under editing
 * the way it never drifts under review, so the
 * strings are pinned here as strings.
 */

const HERO_BODY =
  'Describe it in plain language or draw it on the canvas — your coding ' +
  'agent proposes the workflow, mBoss validates and previews it, and the ' +
  'approved graph compiles to durable DBOS code.';

/** The nav is a sibling of `main`, not a child. */
const NAV_COPY = ['Docs', 'Changelog', 'github.com/ashtable/mboss'];

const COPY = [
  'AGENT-NATIVE · VS CODE + DBOS',
  'Design durable apps.',
  HERO_BODY,
  'BRING YOUR AGENT',
  'codex cli',
  'claude code · acp ▾',
  'gloo code',
  'any acp agent',
  'JOIN THE WAITLIST — EARLY DAYS',
  'Join waitlist',
  'progress emails as features land · unsubscribe anytime',

  // The decorative mini-canvas. It is marketing art
  // and it is aria-hidden, which is why it is easy to
  // edit without anyone noticing — the words are as
  // load-bearing here as anywhere else on the page,
  // because they are what a reader believes mBoss
  // does.
  'Request created',
  'on: helper.request.created',
  '↓ Request',
  'Wait for the form',
  'durable wait — sleeps in Postgres',
  '↓ Submission',
  'Embed into Weaviate',
  'auto-embed · durable step',

  'SNEAK PEEKS — FROM THE DEVELOPMENT BUILD',
  'PROMPT IT — OR DRAW IT',
  'the canvas',
  '"book grooming with christa" → 7 nodes · validated ✓ · approved',
  'WATCH IT SURVIVE A CRASH',
  'the runs view',
  'SHIP REAL DBOS CODE',
  'generated · read-only',
  'exactly-once ✓',
  'early development screens — details will change · follow along at ' +
    'github.com/ashtable/mboss',
];

/**
 * The runs-view caption, which the design breaks
 * across two lines with a `<br>`. `textContent` runs
 * the halves together, so this one is read the way
 * the page renders it.
 */
const RUNS_VIEW_CAPTION =
  'process killed mid-run — DBOS picked up from Postgres · 0 steps ' +
  're-executed';

test('the landing page carries its copy verbatim', async ({ page }) => {
  await page.goto('/');

  // The header nav is a direct child of body; the
  // footer's own nav (its Docs/Changelog/Admin links)
  // sits nested inside <footer>, so this stays unique
  // now that the page has two <nav> elements.
  const nav = page.locator('body > nav');
  for (const line of NAV_COPY) {
    await expect(nav, line).toContainText(line);
  }

  const main = page.locator('main');
  for (const line of COPY) {
    await expect(main, line).toContainText(line);
  }
  await expect(main, RUNS_VIEW_CAPTION).toContainText(RUNS_VIEW_CAPTION, {
    useInnerText: true,
  });

  const field = page.getByPlaceholder('you@company.com');
  await expect(field).toHaveAttribute('type', 'email');
  await expect(field).toHaveAttribute('required', '');
});

test('every blueprint box carries four registration marks', async ({
  page,
}) => {
  await page.goto('/');

  // The join box and the three sneak-peek panels.
  // The count is asserted per box rather than in
  // total, because three marks on one box and five
  // on another sums to the same number and looks
  // like a misprint on the page.
  const boxes = page.locator('.blueprint');
  await expect(boxes).toHaveCount(4);

  for (let index = 0; index < 4; index += 1) {
    await expect(boxes.nth(index).locator('> .corner')).toHaveCount(4);
  }
});

test('the page sells nothing it does not have', async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);

  const body = (await page.locator('body').innerText()).toLowerCase();

  // Absences alone would hold on any page at all —
  // /admin, a 404, an empty document — so the
  // headline is asserted first to tie the rest of
  // this test to the page it is about.
  expect(body).toContain('design durable apps.');

  // There is no product to price, nobody has used it
  // and there is nothing to compare it against. Each
  // of these sections is the kind of thing that
  // arrives with a template.
  for (const absent of ['pricing', 'per month', 'testimonial', 'compare']) {
    expect(body, absent).not.toContain(absent);
  }
});

test('the nav goes somewhere true', async ({ page }) => {
  for (const path of ['/docs', '/changelog']) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(200);
    await expect(page.locator('main p').first()).not.toBeEmpty();
    await expect(
      page.locator('main a[href^="https://github.com/ashtable/mboss"]'),
    ).toHaveCount(1);
  }
});

test('the footer closes the page and its Admin link goes somewhere true', async ({
  page,
}) => {
  await page.goto('/');

  const footer = page.locator('footer');
  await expect(footer).toHaveCount(1);
  await expect(footer).toContainText('mBoss');
  await expect(footer).toContainText('Design durable apps with DBOS.');
  await expect(footer).toContainText('© 2026 mBoss · hello@mboss.dev');

  for (const label of ['Docs', 'Changelog', 'Admin']) {
    await expect(
      footer.getByRole('link', { name: label, exact: true }),
    ).toHaveCount(1);
  }

  await footer.getByRole('link', { name: 'Admin', exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(
    page.getByRole('heading', { name: 'Admin sign-in' }),
  ).toBeVisible();
});

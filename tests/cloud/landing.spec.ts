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
  'SNEAK PEEKS — FROM THE DEVELOPMENT BUILD',
  'PROMPT IT — OR DRAW IT',
  'the canvas',
  'WATCH IT SURVIVE A CRASH',
  'the runs view',
  'SHIP REAL DBOS CODE',
  'generated · read-only',
  'early development screens — details will change · follow along at ' +
    'github.com/ashtable/mboss',
];

test('the landing page carries its copy verbatim', async ({ page }) => {
  await page.goto('/');

  const main = page.locator('main');
  for (const line of COPY) {
    await expect(main, line).toContainText(line);
  }

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
  await expect(page.locator('footer')).toHaveCount(0);
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

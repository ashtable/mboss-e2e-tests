import { expect, test } from '@playwright/test';

import type { Page } from '@playwright/test';

/**
 * The design system, as the browser actually
 * resolves it.
 *
 * mboss-web has a unit test that reads globals.css
 * as text; it can prove the stylesheet declares a
 * value and, by comparing source positions, guess at
 * cascade order. It cannot prove what a real engine
 * computes, and that is the whole of what is
 * interesting here: whether the wireframe override
 * actually wins, whether a dark-mode preference
 * changes anything, and whether a registration mark
 * survives its container's overflow.
 */

/**
 * Every plain-valued token in the theme block, with
 * the design's own values.
 *
 * Tailwind emits only the theme variables its
 * generated CSS actually references, so a token
 * nothing on the site uses yet never reaches the
 * browser at all. That is Tailwind working as
 * intended and not something to assert against — the
 * claim here is the one that survives it: whatever
 * does reach the browser carries the design's value.
 * That the whole table is *declared* is mboss-web's
 * unit test to make, since it reads the stylesheet.
 */
const TOKENS: ReadonlyArray<readonly [string, string]> = [
  ['--color-bg', '#f2f2f3'],
  ['--color-surface', '#e9e9ea'],
  ['--color-text', '#1d1f20'],
  ['--color-accent', '#5980a6'],
  ['--color-accent-2', '#728fab'],
  ['--color-divider', 'color-mix(in srgb, #1d1f20 16%, transparent)'],

  ['--color-neutral-100', '#f5f5f8'],
  ['--color-neutral-200', '#e7e7ea'],
  ['--color-neutral-300', '#d4d4d7'],
  ['--color-neutral-400', '#b7b7ba'],
  ['--color-neutral-500', '#98989b'],
  ['--color-neutral-600', '#7a7a7d'],
  ['--color-neutral-700', '#5d5d60'],
  ['--color-neutral-800', '#424244'],
  ['--color-neutral-900', '#2b2b2d'],

  ['--color-accent-100', '#eef6ff'],
  ['--color-accent-200', '#d6ebff'],
  ['--color-accent-300', '#b5d9fd'],
  ['--color-accent-400', '#94bce3'],
  ['--color-accent-500', '#749dc4'],
  ['--color-accent-600', '#597ea3'],
  ['--color-accent-700', '#416180'],
  ['--color-accent-800', '#2c455d'],
  ['--color-accent-900', '#1d2d3d'],

  ['--color-accent-2-100', '#eef6ff'],
  ['--color-accent-2-200', '#d6ebff'],
  ['--color-accent-2-300', '#bdd8f2'],
  ['--color-accent-2-400', '#9ebbd8'],
  ['--color-accent-2-500', '#7e9cb8'],
  ['--color-accent-2-600', '#627d98'],
  ['--color-accent-2-700', '#486077'],
  ['--color-accent-2-800', '#314457'],
  ['--color-accent-2-900', '#1f2d3a'],

  ['--space-1', '3.4px'],
  ['--space-2', '6.8px'],
  ['--space-3', '10.2px'],
  ['--space-4', '13.6px'],
  ['--space-6', '20.4px'],
  ['--space-8', '27.2px'],

  ['--radius-sm', '2px'],
  ['--radius-md', '4px'],
  ['--radius-lg', '7px'],
];

/**
 * The tokens the site cannot render without, so the
 * table above cannot pass by resolving to nothing at
 * all. The faces are here too: next/font rewrites the
 * family name, and whether the design's own faces
 * actually arrive is a question only a browser
 * answers.
 */
const ALWAYS_PRESENT: ReadonlyArray<readonly [string, string]> = [
  ['--color-bg', '#f2f2f3'],
  ['--color-text', '#1d1f20'],
  ['--color-accent', '#5980a6'],
  ['--color-divider', 'color-mix(in srgb, #1d1f20 16%, transparent)'],
];

test('the tokens the page paints with carry the design values', async ({
  page,
}) => {
  await page.goto('/');
  const resolved = await resolve(
    page,
    TOKENS.map(([name]) => name),
  );

  for (const [index, [name, value]] of TOKENS.entries()) {
    const actual = resolved[index];
    if (actual === '') continue;
    expect(actual, name).toBe(value);
  }
});

test('the load-bearing tokens reach the browser', async ({ page }) => {
  await page.goto('/');

  const names = ALWAYS_PRESENT.map(([name]) => name);
  expect(await resolve(page, names)).toEqual(
    ALWAYS_PRESENT.map(([, value]) => value),
  );

  const [heading, body, mono] = await resolve(page, [
    '--font-heading',
    '--font-body',
    '--font-mono',
  ]);
  expect(heading).toContain('Barlow Condensed');
  expect(body).toContain('Barlow');
  expect(mono).toBe('ui-monospace, Menlo, monospace');
});

test('a dark colour-scheme preference changes nothing', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  const light = await backgroundOfBody(page);

  await page.emulateMedia({ colorScheme: 'dark' });
  const dark = await backgroundOfBody(page);

  // The ground is always paper. A pasted starter
  // template is how that gets lost, and it gets lost
  // silently — nothing else on the page would break.
  expect(dark).toBe(light);
  expect(light).toBe('rgb(242, 242, 243)');
});

test('the wireframe override squares every component', async ({ page }) => {
  await page.goto('/');

  // .btn and .input each set a radius of their own
  // further up the stylesheet; this rule is last on
  // purpose, and a rule moved below it would stop
  // applying with nothing to show for it.
  for (const selector of ['.card', '.btn', '.input']) {
    const radius = await page
      .locator(selector)
      .first()
      .evaluate((node) => getComputedStyle(node).borderRadius);
    expect(radius, selector).toBe('0px');
  }
});

test('a registration mark hangs outside its box, unclipped', async ({
  page,
}) => {
  await page.goto('/');

  const box = page.locator('.blueprint').first();
  const mark = box.locator('> .corner.tl');

  const frame = await box.boundingBox();
  const corner = await mark.boundingBox();
  expect(frame).not.toBeNull();
  expect(corner).not.toBeNull();

  // Set outside the frame on both axes, which is the
  // whole of what makes it read as a registration
  // mark rather than a decoration inside a box.
  expect(corner?.x).toBeLessThan(frame?.x ?? 0);
  expect(corner?.y).toBeLessThan(frame?.y ?? 0);

  // A box that clipped its overflow would keep the
  // mark in the layout and cut it out of the
  // picture, which no bounding box would show.
  const overflow = await box.evaluate(
    (node) => getComputedStyle(node).overflow,
  );
  expect(overflow).toBe('visible');
});

function resolve(page: Page, names: string[]): Promise<string[]> {
  return page.evaluate((wanted: string[]) => {
    const style = getComputedStyle(document.documentElement);
    return wanted.map((name) => style.getPropertyValue(name).trim());
  }, names);
}

function backgroundOfBody(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

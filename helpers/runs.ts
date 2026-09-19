import { expect, type FrameLocator, type Locator } from '@playwright/test';

/**
 * The Runs view's list, as the stack journeys use
 * it.
 *
 * The view is one list of the project's runs, and
 * a run this window started has no card of its
 * own: it is the top row of that list, marked and
 * opened out, which is the same row somebody would
 * have picked themselves. So everything a journey
 * does to a run — reads how it went, stops it,
 * opens its tab, hands it to an agent — goes
 * through its row, and a row is found by the id it
 * carries rather than by where it sits.
 *
 * Each of these reads only the frame it is handed.
 * The view sits in the side bar, and every command
 * `runCommand()` runs takes the side bar off screen
 * and brings the view back as a new page, so the
 * caller finds the frame again after such a command
 * rather than handing in one it kept.
 */

/** A run's row on the list. */
export function runRow(runs: FrameLocator, id: string): Locator {
  return runs.locator(`li[data-run="${id}"]`);
}

/** The ids the list shows now, top first. An
 *  empty list, or none drawn at all, is none. */
export function listedRuns(runs: FrameLocator): Promise<string[]> {
  return runs
    .locator('li[data-run]')
    .evaluateAll((rows) =>
      rows.map((row) => row.getAttribute('data-run') ?? ''),
    );
}

/**
 * The run a start just put on the list: the one
 * row whose head is marked and whose id was not
 * listed before the start.
 *
 * Both halves, because either alone answers wrong.
 * A mark alone finds whatever row was picked
 * before the start, until the list is read again;
 * a new id alone finds any run somebody else
 * started meanwhile. The panel marks its own run
 * when the first read of it lands, which is after
 * the app has written the row.
 */
export async function startedRun(
  runs: FrameLocator,
  before: readonly string[],
): Promise<string> {
  const marked = runs.locator(
    'li[data-run]:has(> button.run-head[aria-current="true"])',
  );
  let found = '';

  await expect
    .poll(
      async () => {
        const ids = await marked.evaluateAll((rows) =>
          rows.map((row) => row.getAttribute('data-run') ?? ''),
        );

        found = ids.find((id) => id !== '' && !before.includes(id)) ?? '';

        return found;
      },
      { message: 'no run the list had not shown before came up marked' },
    )
    .not.toBe('');

  return found;
}

/**
 * Picks a row, unless it is picked already, which
 * opens it out and puts what can be done to the run
 * on screen.
 *
 * Asked first rather than clicked regardless,
 * because the mark is the extension's to keep: a
 * row picked a second time is a request about the
 * row somebody already has open.
 */
export async function pickRun(runs: FrameLocator, id: string): Promise<void> {
  const head = runRow(runs, id).locator(':scope > button.run-head');

  if ((await head.getAttribute('aria-current')) !== 'true') {
    await head.click();
  }

  await expect(head).toHaveAttribute('aria-current', 'true');
}

/** Opens a run's tab from its row. */
export async function openRunTab(
  runs: FrameLocator,
  id: string,
): Promise<void> {
  await pickRun(runs, id);
  await runRow(runs, id).locator('[data-open-run]').click();
}

/**
 * Starts the project's stack from the list, and
 * waits until every named service says it is
 * running.
 *
 * The Button is the one way out the view offers
 * while the app is down, and it is gone once the
 * app is up. The services are then read off the
 * line beside Run, which the view draws only while
 * the app is running — so this wait is also the
 * wait for there being something to start.
 */
export async function startStack(
  runs: FrameLocator,
  services: readonly string[],
  options: { timeout: number },
): Promise<void> {
  await runs.locator('[data-stack-up]').click();

  for (const service of services) {
    await expect(
      runs.locator(`[data-zone="stack"] [data-service="${service}"]`),
      `${service} should be running`,
    ).toHaveAttribute('data-state', 'running', { timeout: options.timeout });
  }
}

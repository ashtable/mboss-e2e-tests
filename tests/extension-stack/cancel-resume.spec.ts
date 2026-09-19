import { access } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type FrameLocator } from '@playwright/test';

import { composeDown, installDependencies } from '../../helpers/app.js';
import {
  listedRuns,
  openRunTab,
  runRow,
  startStack,
  startedRun,
} from '../../helpers/runs.js';
import {
  discardExtensionProject,
  driveVsCode,
  extensionProject,
  type DrivenVsCode,
} from '../../helpers/vscode.js';

/**
 * A run stopped in the middle and picked back up.
 *
 * The only way to catch a run mid-flight is to have
 * one that stays there, which is what the minute-long
 * wait in this fixture is for. A shorter one would
 * shrink the very window the two controls have to be
 * offered and pressed in, and turn a proof into a
 * race against a panel's own polling.
 *
 * Outcomes only. Whether the sleep inside the app
 * wakes the moment a cancel lands or sits out its
 * deadline is the SDK's business and is deliberately
 * not asserted here — what a person needs is that
 * the run stops, that it can be picked back up, and
 * that picking it back up finishes it.
 *
 * The two controls are never both on offer, and that
 * is asserted as hard as their outcomes: a rail
 * showing Cancel and Resume together is a panel
 * asking for two contradictory things at once.
 *
 * The word beside the run is left alone on purpose.
 * A run sitting out a durable wait reads as waiting
 * and a run between operations reads as running,
 * both are stoppable, and which of the two a spec
 * catches is a matter of milliseconds.
 */
test.describe('a run cancelled and resumed', () => {
  const NAME = 'cancel-resume';
  const WORKFLOW = 'timer_then_answer';
  const QUESTION = 'what survives a cancel';

  /** The panel lets go of a run that is parked, so
   *  reaching the far side of the wait is a matter
   *  of asking again rather than of waiting longer.
   *  Generous, because the wait itself is a minute. */
  const AFTER_THE_TIMER = 90_000;

  let project: string;
  let vscode: DrivenVsCode;
  let runs: FrameLocator;
  let see: FrameLocator;

  let runId = '';

  test.beforeAll(async () => {
    test.setTimeout(900_000);

    project = await extensionProject({
      name: NAME,
      overlay: 'timer-then-answer',
    });

    await installDependencies(project);
    await composeDown(project);

    vscode = await driveVsCode({ project });
    await vscode.trustFolder();

    await vscode.runCommand('mBoss: Generate Code');

    await expect(async () => {
      await access(
        join(project, 'src', 'workflows', `${WORKFLOW}.workflow.ts`),
      );
    }).toPass({ timeout: 60_000 });

    await vscode.runCommand('mBoss: Open Runs');
    runs = await vscode.webview('runs');
  });

  test.afterAll(async () => {
    await vscode?.close();

    if (project !== undefined) {
      await composeDown(project).catch(() => undefined);
      await discardExtensionProject(project);
    }
  });

  test('Start app brings the project up', async () => {
    test.setTimeout(900_000);

    await startStack(runs, ['postgres', 'app'], { timeout: 900_000 });
  });

  /**
   * A run caught while it is still going.
   *
   * Cancel being on offer is the assertion, not the
   * word beside the run: both of the words a run in
   * flight can carry mean the same thing to somebody
   * with their hand on this button. The run's row
   * is the one the panel marked and opened out when
   * it started it, so its controls are already on
   * screen.
   */
  test(`runs ${WORKFLOW} and catches it in flight`, async () => {
    test.setTimeout(600_000);

    const start = runs.locator('[data-run-workflow]');

    // One saved workflow, so nothing to pick.
    await expect(start).toBeVisible();
    await expect(runs.locator('[data-workflow-picker]')).toHaveCount(0);

    await runs
      .locator('[data-input]')
      .fill(`{ "question": ${JSON.stringify(QUESTION)} }`);

    const before = await listedRuns(runs);

    await start.click();

    runId = await startedRun(runs, before);

    const row = runRow(runs, runId);

    await expect(row.locator('[data-cancel-run]')).toBeVisible();
    await expect(row.locator('[data-resume-run]')).toHaveCount(0);
    await expect(row).toHaveAttribute('data-outcome', /^(running|waiting)$/);
  });

  /**
   * Stopped, and said to be stopped by the ledger
   * rather than by the button.
   *
   * Cancelling is not an interrupt — it writes a
   * status the run reads at its next durable point —
   * so the row settling is the only witness that
   * anything happened. It settles idle rather than
   * failed: a cancelled run is one somebody asked
   * for, and is not the news a run that threw is.
   */
  test('Cancel run stops it', async () => {
    const row = runRow(runs, runId);

    await row.locator('[data-cancel-run]').click();

    await expect(row).toHaveAttribute('data-outcome', 'idle', {
      timeout: 120_000,
    });

    await expect(row.locator('[data-resume-run]')).toBeVisible();
    await expect(row.locator('[data-cancel-run]')).toHaveCount(0);
  });

  /**
   * Picked back up, and stoppable again.
   *
   * `running` alone is not asserted. The wake time
   * was written down before the wait began, so a
   * resumed run goes straight back to sitting out
   * the remainder of the same minute and reads as
   * waiting again — which is the point of a durable
   * wait, not a failure to resume. Nor is the word
   * the row first says: a resumed run sits on the
   * queue until a worker claims it, and the row
   * says so until the next read. What says it is
   * back in flight is that it can be stopped again
   * and no longer offers to be resumed.
   */
  test('Resume puts it back in flight', async () => {
    const row = runRow(runs, runId);

    await row.locator('[data-resume-run]').click();

    await expect(row.locator('[data-cancel-run]')).toBeVisible({
      timeout: 120_000,
    });
    await expect(row.locator('[data-resume-run]')).toHaveCount(0);

    await expect(row).toHaveAttribute('data-outcome', /^(running|waiting)$/, {
      timeout: 120_000,
    });
  });

  /**
   * The far side of the wait.
   *
   * Read on the run's own tab rather than in the
   * list, and that is the honest place for it. A
   * watch lets go of a parked run rather than
   * reading somebody's database every half second
   * for a day, so the row keeps saying what was
   * last read — a memory of the last thing anybody
   * read, not a live column. The tab's refresh is
   * what asking again is, so it is what is asked.
   *
   * Both words are taken: the ledger's own status
   * for the run, as the Inspector shows the row
   * DBOS keeps about a run in front with nothing of
   * it picked; and the colour the blocks either
   * side of the wait are drawn in, the wait itself
   * toned by the row its sleep wrote.
   */
  test('the wait runs out and the run finishes', async () => {
    test.setTimeout(600_000);

    await openRunTab(runs, runId);
    see = await vscode.webview('see');

    await expect(see.locator(`.see[data-run="${runId}"]`)).toBeVisible();

    await expect(async () => {
      await see.locator('[data-see-refresh]').click();

      const inspector = await vscode.inspector();

      await expect(
        inspector.locator('[data-ledger] [data-rail="status"] .value'),
      ).toHaveText('SUCCESS', { timeout: 5_000 });
    }).toPass({ timeout: AFTER_THE_TIMER });

    await see.locator('[data-see-tab="graph"]').click();

    for (const block of ['let_it_wait', 'answer_it']) {
      await expect(
        see.locator(`[data-run-node="${block}"]`),
        `${block} should be drawn finished`,
      ).toHaveAttribute('data-state', 'done');
    }
  });
});

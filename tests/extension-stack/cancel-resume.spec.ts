import { access } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type FrameLocator } from '@playwright/test';

import { composeDown, installDependencies } from '../../helpers/app.js';
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

  test('Start Local Stack brings the project up', async () => {
    test.setTimeout(900_000);

    await runs.locator('[data-stack-toggle]').click();

    for (const service of ['postgres', 'app']) {
      await expect(
        runs.locator(`[data-zone="stack"] [data-service="${service}"]`),
        `${service} should be running`,
      ).toHaveAttribute('data-state', 'running', { timeout: 900_000 });
    }
  });

  /**
   * A run caught while it is still going.
   *
   * Cancel being on offer is the assertion, not the
   * word beside the run: both of the words a run in
   * flight can carry mean the same thing to somebody
   * with their hand on this button.
   */
  test(`runs ${WORKFLOW} and catches it in flight`, async () => {
    test.setTimeout(600_000);

    const picker = runs.locator('[data-workflow-picker]');

    await expect(picker.locator(`option[value="${WORKFLOW}"]`)).toHaveCount(1);
    await picker.selectOption(WORKFLOW);

    await runs
      .locator('[data-input]')
      .fill(`{ "question": ${JSON.stringify(QUESTION)} }`);
    await runs.locator('[data-run-workflow]').click();

    const live = runs.locator('[data-zone="running-now"]');

    await expect(live.locator('[data-cancel-run]')).toBeVisible();
    await expect(live.locator('[data-resume-run]')).toHaveCount(0);

    expect(
      await live.locator('.run-line').getAttribute('data-outcome'),
    ).toMatch(/^(running|waiting)$/);

    runId = (await live.locator('.run-id').innerText()).trim();
    expect(runId, 'the panel drew a run with no id').not.toBe('');
  });

  /**
   * Stopped, and said to be stopped by the ledger
   * rather than by the button.
   *
   * Cancelling is not an interrupt — it writes a
   * status the run reads at its next durable point —
   * so the row settling to `cancelled` is the only
   * witness that anything happened.
   */
  test('Cancel run stops it', async () => {
    const live = runs.locator('[data-zone="running-now"]');

    await live.locator('[data-cancel-run]').click();

    await expect(live.locator('.run-line')).toHaveAttribute(
      'data-outcome',
      'cancelled',
      { timeout: 120_000 },
    );

    await expect(live.locator('[data-resume-run]')).toBeVisible();
    await expect(live.locator('[data-cancel-run]')).toHaveCount(0);
  });

  /**
   * Picked back up, and stoppable again.
   *
   * `running` is not asserted. The wake time was
   * written down before the wait began, so a resumed
   * run goes straight back to sitting out the
   * remainder of the same minute and reads as
   * waiting again — which is the point of a durable
   * wait, not a failure to resume. What says it is
   * back in flight is that it can be stopped again
   * and no longer offers to be resumed.
   */
  test('Resume puts it back in flight', async () => {
    const live = runs.locator('[data-zone="running-now"]');

    await live.locator('[data-resume-run]').click();

    await expect(live.locator('[data-cancel-run]')).toBeVisible({
      timeout: 120_000,
    });
    await expect(live.locator('[data-resume-run]')).toHaveCount(0);

    expect(
      await live.locator('.run-line').getAttribute('data-outcome'),
    ).toMatch(/^(running|waiting)$/);
  });

  /**
   * The far side of the wait.
   *
   * Read on the run's own page rather than in the
   * panel, and that is the honest place for it. A
   * watch lets go of a parked run rather than
   * reading somebody's database every half second
   * for a day, so the zone the run was in keeps
   * saying `waiting · refresh to check` — it is a
   * memory of the last thing anybody read, not a
   * live column. The page about the run is what
   * asking again reads, so it is what is asked.
   *
   * Both words are taken: the ledger's own status
   * for the run, and the colour the block that ran
   * after the wait is drawn in.
   */
  test('the wait runs out and the run finishes', async () => {
    test.setTimeout(600_000);

    await runs.locator(`[data-session-row="${runId}"] [data-open-run]`).click();
    see = await vscode.webview('see');

    await expect(see.locator(`.see[data-run="${runId}"]`)).toBeVisible();

    await expect(async () => {
      await see.locator('[data-see-refresh]').click();

      await expect(see.locator('[data-rail="status"] dd')).toHaveText(
        'SUCCESS',
        { timeout: 5_000 },
      );
    }).toPass({ timeout: AFTER_THE_TIMER });

    await see.locator('[data-see-tab="graph"]').click();

    await expect(see.locator('[data-run-node="answer_it"]')).toHaveAttribute(
      'data-state',
      'done',
    );
  });
});

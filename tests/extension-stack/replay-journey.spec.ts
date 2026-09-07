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
 * A finished run, forked from a point inside it.
 *
 * The journey beside this one proves a run can be
 * started and followed to its end. This one is about
 * the thing a durable ledger is for afterwards: a
 * run that already happened is a record somebody can
 * start again from a chosen point, and the two runs
 * both remain.
 *
 * Everything here goes through the surfaces a person
 * uses — the block on the run's own picture, the
 * button under it, and the modal the editor draws to
 * confirm. The modal is workbench chrome rather than
 * anything a webview owns, which is why the helper
 * that answers it reads the box's words rather than
 * looking for a mark this suite chose.
 *
 * What the fork inherits is deliberately not
 * asserted here. `two-blocks` records exactly one
 * operation, so a replay from its only step has
 * nothing before it to carry over — the row that
 * runs new is the whole of the fork's trace. The
 * claim this file can honestly make is that the
 * fork ran the step again, finished, and knows which
 * run it came out of.
 */
test.describe('a replay, from a run that finished', () => {
  const NAME = 'replay-journey';
  const WORKFLOW = 'two_blocks';
  const BLOCK = 'answer_it';
  const QUESTION = 'what does a fork keep';

  let project: string;
  let vscode: DrivenVsCode;
  let runs: FrameLocator;
  let see: FrameLocator;

  /** The run the fork came out of, and the fork. */
  let parentId = '';
  let forkId = '';

  test.beforeAll(async () => {
    test.setTimeout(900_000);

    project = await extensionProject({ name: NAME, overlay: 'two-blocks' });

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

  test(`runs ${WORKFLOW} and the run reaches done`, async () => {
    test.setTimeout(600_000);

    const picker = runs.locator('[data-workflow-picker]');

    await expect(picker.locator(`option[value="${WORKFLOW}"]`)).toHaveCount(1);
    await picker.selectOption(WORKFLOW);

    await runs
      .locator('[data-input]')
      .fill(`{ "question": ${JSON.stringify(QUESTION)} }`);
    await runs.locator('[data-run-workflow]').click();

    const live = runs.locator('[data-zone="running-now"]');

    await expect(live.locator('.run-line')).toHaveAttribute(
      'data-outcome',
      'done',
      { timeout: 300_000 },
    );

    parentId = (await live.locator('.run-id').innerText()).trim();
    expect(parentId, 'the panel drew a run with no id').not.toBe('');
  });

  /**
   * Picking the block, on the run's own picture.
   *
   * The button under it is refused until something
   * is picked, and picking a block picks the first
   * row that block wrote — which is what makes "from
   * here" mean a point in the run rather than a
   * whole run over again.
   */
  test('the run page offers a replay from the block that ran', async () => {
    await runs
      .locator(`[data-session-row="${parentId}"] [data-open-run]`)
      .click();

    see = await vscode.webview('see');

    await expect(see.locator(`.see[data-run="${parentId}"]`)).toBeVisible();

    await see.locator('[data-see-tab="graph"]').click();
    await see.locator(`[data-run-node="${BLOCK}"]`).click();

    await expect(see.locator('[data-replay]')).toBeEnabled();
  });

  /**
   * The confirmation, and what comes out of it.
   *
   * The fork is found by elimination rather than by
   * reading an id off the panel: the session zone is
   * this window's own memory of what it started, so
   * a second row in it after one click is the run
   * that click made, whatever it is called.
   */
  test('replaying forks a second run that finishes', async () => {
    test.setTimeout(600_000);

    const rows = runs.locator('[data-zone="session"] [data-session-row]');

    await expect(rows).toHaveCount(1);

    await see.locator('[data-replay]').click();

    const said = await vscode.answerDialog('Replay');

    // The box names the point rather than the run,
    // and says in as many words that a first durable
    // operation has nothing behind it to carry over.
    expect(said).toContain('Replay from Answer it?');
    expect(said).toContain(
      "nothing — this is the run's first durable operation",
    );

    await expect(rows).toHaveCount(2);

    const ids = await rows.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-session-row') ?? ''),
    );

    forkId = ids.find((id) => id !== parentId) ?? '';
    expect(forkId, 'the panel logged no second run').not.toBe('');

    await expect(
      runs.locator(`[data-session-row="${forkId}"]`),
    ).toHaveAttribute('data-outcome', 'done', { timeout: 300_000 });
  });

  /**
   * Which run this one came out of, said on the page
   * about it.
   *
   * The lineage is drawn from the column the fork
   * itself carries, so the parent's line being there
   * is the proof that the fork was recorded as a
   * replay of it and not as an unrelated second run
   * that happens to have finished.
   *
   * The step is asserted to have run rather than to
   * have been carried over. A run of one step forked
   * from that step has nothing before it to copy, so
   * every row in the fork is a row the fork ran.
   */
  test('the fork names the run it came out of', async () => {
    await runs
      .locator(`[data-session-row="${forkId}"] [data-open-run]`)
      .click();

    await expect(see.locator(`.see[data-run="${forkId}"]`)).toBeVisible();

    const lineage = see.locator('[data-lineage]');

    await expect(
      lineage.locator(`[data-lineage-run="${parentId}"]`),
    ).toBeVisible();
    await expect(
      lineage.locator(`[data-lineage-run="${forkId}"]`),
    ).toHaveAttribute('aria-current', 'true');

    await see.locator('[data-see-tab="trace"]').click();

    await expect(
      see.locator(`[data-trace-group="${BLOCK}"] [data-trace-op]`).first(),
    ).toHaveAttribute('data-reuse', 'own');
  });
});

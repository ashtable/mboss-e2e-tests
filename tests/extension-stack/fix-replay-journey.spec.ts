import { access, readFile, writeFile } from 'node:fs/promises';
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
 * A run that failed, a fix, and the same run again
 * over the code that fixes it.
 *
 * This is the loop the whole product is shaped
 * around, and the only place all of it is visible at
 * once: a step throws, somebody changes the line
 * that threw, and the replay they ask for runs the
 * new code against an input already recorded — with
 * no terminal, no rebuild by hand, and no second run
 * typed out from the start.
 *
 * The middle of it is the part worth being careful
 * about. The app runs out of an image, not out of
 * the folder being edited, so a replay asked for
 * straight after a fix would run the old code and
 * answer exactly as the failure did. What stops that
 * is a walk over the files the image was built from,
 * done at the moment the replay is asked for — and
 * the confirmation it puts up naming the file that
 * moved is what this spec holds it to.
 *
 * The fix is written straight to disk rather than
 * typed into an editor, deliberately. Somebody
 * fixing a handler in another editor, or an agent
 * writing it from a session, is the case the walk
 * exists for, and it is the case a spec that saved
 * through this window would not be testing.
 */
test.describe('a failure, a fix, and a replay over it', () => {
  const NAME = 'fix-replay';
  const WORKFLOW = 'failing_step';
  const BLOCK = 'settle_it';
  const HANDLER = join('lib', 'settleIt.ts');

  /** The one line in the handler that refuses, and
   *  what it becomes. */
  const REFUSES =
    "if (claim.fail) throw new Error('the ledger refused this claim');";
  const SETTLES =
    "if (claim.fail) return { note: 'settled the claim anyway' };";

  let project: string;
  let vscode: DrivenVsCode;
  let runs: FrameLocator;
  let see: FrameLocator;

  let runId = '';
  let forkId = '';

  test.beforeAll(async () => {
    test.setTimeout(900_000);

    project = await extensionProject({ name: NAME, overlay: 'failing-step' });

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
   * The bug, run.
   *
   * A claim marked to fail is the input the fixture
   * exists to be given. The step is allowed three
   * tries a second apart, so the run spends a few
   * seconds failing rather than failing at once.
   */
  test(`runs ${WORKFLOW} and the run fails`, async () => {
    test.setTimeout(600_000);

    const picker = runs.locator('[data-workflow-picker]');

    await expect(picker.locator(`option[value="${WORKFLOW}"]`)).toHaveCount(1);
    await picker.selectOption(WORKFLOW);

    await runs.locator('[data-input]').fill('{ "fail": true }');
    await runs.locator('[data-run-workflow]').click();

    const live = runs.locator('[data-zone="running-now"]');

    await expect(live.locator('.run-line')).toHaveAttribute(
      'data-outcome',
      'failed',
      { timeout: 300_000 },
    );

    runId = (await live.locator('.run-id').innerText()).trim();
    expect(runId, 'the panel drew a run with no id').not.toBe('');
  });

  /**
   * The fix, and the sentence that catches it.
   *
   * The file is rewritten while the failed run is
   * still on screen and the editor is told nothing
   * about it. What the replay then offers is
   * `Rebuild and replay` rather than a plain replay,
   * and the box says a file moved — the two halves
   * of the same claim, so both are read off the one
   * box.
   *
   * Which file it names is left to the walk. The box
   * names the newest thing the image was built from,
   * and that is not the file somebody typed in:
   * changing a handler makes the editor regenerate
   * the code that calls it, and the generated file
   * lands milliseconds after the handler does. So
   * the shape of the sentence is asserted and the
   * name inside it is not — a spec that named the
   * handler here would be asserting that codegen had
   * not run, which is the opposite of what should
   * happen.
   */
  test('the replay refuses to run an image older than the fix', async () => {
    // A rebuild is a docker build, and the fork is
    // not started until it has come back up.
    test.setTimeout(1_200_000);

    const handler = join(project, HANDLER);
    const before = await readFile(handler, 'utf8');

    expect(before, 'the fixture no longer refuses on one line').toContain(
      REFUSES,
    );
    await writeFile(handler, before.replace(REFUSES, SETTLES));

    await runs.locator(`[data-session-row="${runId}"] [data-open-run]`).click();

    see = await vscode.webview('see');

    await expect(see.locator(`.see[data-run="${runId}"]`)).toBeVisible();

    await see.locator('[data-see-tab="graph"]').click();
    await see.locator(`[data-run-node="${BLOCK}"]`).click();
    await see.locator('[data-replay]').click();

    const said = await vscode.answerDialog('Rebuild and replay');

    expect(said).toMatch(
      /The running app was built before your change to \S+\.ts\./,
    );

    const rows = runs.locator('[data-zone="session"] [data-session-row]');

    await expect(rows).toHaveCount(2, { timeout: 900_000 });

    const ids = await rows.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-session-row') ?? ''),
    );

    forkId = ids.find((id) => id !== runId) ?? '';
    expect(forkId, 'the panel logged no second run').not.toBe('');
  });

  /**
   * What the rebuilt image did with the recorded
   * input.
   *
   * The fork is a second run of the same workflow
   * over the input the first one was given, and it
   * finishes — which it could only do on code the
   * failure did not have. The step is asserted to
   * have run rather than to have been carried over:
   * this workflow records one operation, and a
   * replay from it is a replay of everything it has.
   */
  test('the fork runs the mended step and finishes', async () => {
    test.setTimeout(600_000);

    await expect(
      runs.locator(`[data-session-row="${forkId}"]`),
    ).toHaveAttribute('data-outcome', 'done', { timeout: 300_000 });

    await runs
      .locator(`[data-session-row="${forkId}"] [data-open-run]`)
      .click();

    await expect(see.locator(`.see[data-run="${forkId}"]`)).toBeVisible();

    await expect(
      see.locator(`[data-lineage] [data-lineage-run="${runId}"]`),
    ).toBeVisible();

    await see.locator('[data-see-tab="trace"]').click();

    const op = see
      .locator(`[data-trace-group="${BLOCK}"] [data-trace-op]`)
      .first();

    await expect(op).toHaveAttribute('data-reuse', 'own');
    await expect(op).toHaveAttribute('data-state', 'done');
  });
});

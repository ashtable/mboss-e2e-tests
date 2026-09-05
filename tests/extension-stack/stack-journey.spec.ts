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
 * The Runs panel, against a stack it started
 * itself.
 *
 * Every other extension spec stops at the editor:
 * a document is written, a proposal is applied, a
 * block lands where it was dropped. This one goes
 * the rest of the way. A project is scaffolded, the
 * code behind its one step is generated from the
 * document, the panel brings the project's own
 * containers up, a run is fired at the app inside
 * them by hand, and the run is followed to `done`
 * through the ledger Postgres wrote — with no
 * terminal anywhere in it.
 *
 * That is the only place four things are visible at
 * once: that the generated code compiles inside the
 * image the scaffold's Dockerfile builds, that the
 * app registers the workflow the document named,
 * that the ingress accepts the panel's request
 * under the id the panel minted, and that the
 * flight recorder opens on the run that just
 * finished rather than on whatever was selected
 * last.
 *
 * It is opt-in — `npm run e2e:stack`, its own
 * Playwright project, and not in CI. It wants a
 * Docker daemon, an image build and minutes, and
 * `npm run e2e:ext` is entitled to run on a machine
 * that has none of them. Global setup refuses it in
 * one sentence when the daemon is not answering or
 * one of its two ports is taken.
 *
 * `two-blocks` rather than `crash-fixture`: the
 * latter is triggered by an event, its second block
 * sends mail that fails without a sink and its
 * third parks on a form, so the furthest a run of
 * it reaches is `waiting`. This fixture's one step
 * quotes the question back, which is the smallest
 * thing that can honestly finish.
 */
test.describe('the Runs panel, over a real stack', () => {
  const NAME = 'stack-journey';
  const WORKFLOW = 'two_blocks';
  const QUESTION = 'what does durable execution buy me';

  let project: string;
  let vscode: DrivenVsCode;
  let runs: FrameLocator;

  /** Minted by the panel, read off the run it is
   *  following, and the thread through the last
   *  three tests. */
  let runId = '';

  test.beforeAll(async () => {
    // A scaffold, a full `npm install`, an editor
    // and a code generation. None of it is the
    // subject; all of it has to be real.
    test.setTimeout(900_000);

    project = await extensionProject({ name: NAME, overlay: 'two-blocks' });

    // The image build copies `package-lock.json`,
    // which only an install writes. The scaffold's
    // own README says the same thing in the same
    // order.
    await installDependencies(project);

    // The compose project name comes from the file
    // the scaffold wrote, so it is the same name
    // every run. A run that died before its
    // teardown would otherwise leave containers and
    // a volume behind for this one to inherit.
    await composeDown(project);

    vscode = await driveVsCode({ project });

    // Generating code writes TypeScript into the
    // workspace and starting a stack executes its
    // contents, so both stay disabled until the
    // folder is trusted. Nothing below this line
    // works without it.
    await vscode.trustFolder();

    await vscode.runCommand('mBoss: Generate Code');

    // Before the image is built, not after: the app
    // runs the code that was on disk at
    // `compose up`, so a workflow generated later
    // is a 404 at the ingress and a Rebuild in the
    // panel.
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
      // Volumes included. The run history is the
      // point of the database and it belongs to
      // this run of this spec.
      await composeDown(project).catch(() => undefined);
      await discardExtensionProject(project);
    }
  });

  /**
   * The image build is the slow part and it is not
   * skippable: the app that answers the run below
   * has to be the one built from the code generated
   * a moment ago.
   *
   * `--wait` is inside the extension, so a stack
   * that is up here is a stack whose healthchecks
   * went green — which for the app means it served
   * `/healthz` from inside its own container.
   */
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
   * A run started the way a person starts one:
   * pick the workflow, type its input as JSON,
   * press the button.
   *
   * `done` is read off `dbos.workflow_status`
   * through the panel's own watch, which polls the
   * project's database over the port this suite
   * moved it to. So the assertion covers the whole
   * length of it — the ingress accepted the
   * request, the workflow was registered under the
   * name the document carries, the step ran, and
   * the ledger says so.
   */
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
    await expect(live.locator('.run-name')).toHaveText(WORKFLOW);

    runId = (await live.locator('.run-id').innerText()).trim();
    expect(runId, 'the panel drew a run with no id').not.toBe('');
  });

  /**
   * What this window set going, as against what the
   * database happens to hold.
   *
   * The session zone is the panel's own memory of
   * the runs it started, and it is the only place a
   * run started here is told apart from one an
   * agent or a colleague started. So it is asserted
   * on the id the run above was given rather than
   * on the zone having any rows at all.
   */
  test('the session zone lists the run this window started', async () => {
    await expect(
      runs.locator(`[data-zone="session"] [data-session-row="${runId}"]`),
    ).toHaveAttribute('data-outcome', 'done');
  });

  /**
   * The flight recorder, opened from the row.
   *
   * The see webview is an editor tab rather than a
   * view in the container, and it draws the run the
   * store has selected — so an id in its markup is
   * the proof that pressing this row's button
   * selected this row's run, rather than revealing
   * a panel that was already showing something.
   */
  test('Open flight recorder shows that run', async () => {
    await runs.locator(`[data-session-row="${runId}"] [data-open-run]`).click();

    const see = await vscode.webview('see');

    await expect(see.locator(`.see[data-run="${runId}"]`)).toBeVisible();
  });
});

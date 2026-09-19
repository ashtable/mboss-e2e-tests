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
 * run's tab opens on the run that just finished
 * rather than on whatever was picked last.
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
  const BLOCK = 'answer_it';
  const QUESTION = 'what does durable execution buy me';

  let project: string;
  let vscode: DrivenVsCode;
  let runs: FrameLocator;
  let see: FrameLocator;
  let canvas: FrameLocator;

  /** Minted by the panel, read off the row it
   *  marked, and the thread through every test
   *  after the start. */
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
  test('Start app brings the project up', async () => {
    test.setTimeout(900_000);

    await startStack(runs, ['postgres', 'app'], { timeout: 900_000 });
  });

  /**
   * A run started the way a person starts one:
   * type its input as JSON, press the button.
   *
   * There is nothing to pick first. The project
   * saved one workflow, and a picker with one
   * choice in it is a question with one answer, so
   * the panel draws none — which the name on the
   * run's row then confirms was the workflow Run
   * meant.
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

    const start = runs.locator('[data-run-workflow]');

    await expect(start).toBeVisible();
    await expect(runs.locator('[data-workflow-picker]')).toHaveCount(0);

    await runs
      .locator('[data-input]')
      .fill(`{ "question": ${JSON.stringify(QUESTION)} }`);

    const before = await listedRuns(runs);

    await start.click();

    runId = await startedRun(runs, before);

    const row = runRow(runs, runId);

    await expect(row).toHaveAttribute('data-outcome', 'done', {
      timeout: 300_000,
    });
    await expect(row.locator('.run-name')).toHaveText(WORKFLOW);
  });

  /**
   * What this window set going, as against what the
   * database happens to hold.
   *
   * A run started here has no card of its own. It
   * is the top row of the project's ledger, marked
   * and opened out, which is the row somebody would
   * have picked to look at it — so it is asserted on
   * the id the run above was given, and on being the
   * row in front, rather than on the list having any
   * rows at all.
   */
  test('the list leads with the run this window started', async () => {
    const row = runRow(runs, runId);

    expect((await listedRuns(runs))[0]).toBe(runId);
    await expect(row.locator(':scope > button.run-head')).toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect(row.locator('[data-open-run]')).toBeVisible();
    await expect(row).toHaveAttribute('data-outcome', 'done');
  });

  /**
   * The run's own tab, opened from its row.
   *
   * The tab is an editor rather than a view in the
   * container, and it draws the run the store has
   * open — so an id in its markup is the proof that
   * pressing this row's button opened this row's
   * run, rather than revealing a tab that was
   * already showing something.
   */
  test("the row opens that run's tab", async () => {
    await openRunTab(runs, runId);

    see = await vscode.webview('see');

    await expect(see.locator(`.see[data-run="${runId}"]`)).toBeVisible();
  });

  /**
   * The same run twice over: as a picture and as a
   * list.
   *
   * Both are drawn from the rows Postgres holds and
   * neither is drawn from the other, so they are
   * asserted apart. The picture's claim is that
   * every block the run went through is drawn as
   * finished — the trigger included, which records
   * nothing and is done by the fact the run started.
   * The list's is that each row is laid under the
   * block that wrote it rather than out flat.
   *
   * One block and not two in the list, because a
   * trigger records nothing: it is how the run
   * started, not something the run did.
   */
  test('the run page draws the blocks and the rows they wrote', async () => {
    await see.locator('[data-see-tab="graph"]').click();

    await expect(see.locator('[data-pane="graph"]')).toHaveAttribute(
      'data-showing',
      'true',
    );

    await expect(see.locator('[data-run-node]')).toHaveCount(2);

    for (const block of [BLOCK, 'started_by_hand']) {
      await expect(
        see.locator(`[data-run-node="${block}"]`),
        `${block} should be drawn finished`,
      ).toHaveAttribute('data-state', 'done');
    }

    await see.locator('[data-see-tab="trace"]').click();

    await expect(see.locator(`li[data-trace-group="${BLOCK}"]`)).toBeVisible();

    const groups = await see
      .locator('li[data-trace-group]')
      .evaluateAll((rows) =>
        rows.map((row) => row.getAttribute('data-trace-group') ?? ''),
      );

    expect(new Set(groups.filter((group) => group !== ''))).toEqual(
      new Set([BLOCK]),
    );
  });

  /**
   * The way back from a run to the document it was a
   * run of.
   *
   * Beside rather than over, which is the whole
   * reason the button exists: somebody reading a run
   * and opening the workflow behind it is comparing
   * the two. So the run page is asked whether it is
   * still on screen afterwards, and the answer has
   * to be yes.
   */
  test('Edit workflow opens the document beside the run', async () => {
    // A way to the document drawn in the graph's
    // own corner, so it is there on the Graph tab
    // and nowhere on the Trace one.
    await see.locator('[data-see-tab="graph"]').click();
    await see.locator('[data-edit-workflow]').click();

    canvas = await vscode.webview('canvas');

    await expect(
      canvas.locator(`.react-flow__node[data-id="${BLOCK}"]`),
    ).toBeVisible();

    expect(await vscode.showsWebview('see')).toBe(true);
  });

  /**
   * What the run recorded, on the block that
   * recorded it, in the Inspector beside the
   * editor.
   *
   * The face was refused with a hint while nothing
   * had been run — a claim the plain editor suite
   * makes, having no stack to run anything on. This
   * is the other half: with a run followed, the
   * same face opens and carries figures that could
   * only have come from the ledger.
   *
   * The duration and the clock are read as shapes
   * rather than numbers. What they say is how long
   * the step took on this machine and when, which
   * is not a thing to assert; that they say a
   * number at all, and a time to the millisecond on
   * a 24-hour clock, is. And what the step returned
   * is shown as the step returned it, never in the
   * envelope the SDK stores it in.
   */
  test('the block carries what the run recorded', async () => {
    await canvas.locator(`.react-flow__node[data-id="${BLOCK}"]`).click();

    const inspector = await vscode.inspector();
    const header = inspector.locator('[data-inspector-header]');

    await expect(header.locator('[data-inspector-kind]')).toHaveText('step');

    await inspector.locator('[data-inspector-tab="evidence"]').click();

    await expect(header.locator('[data-run-state="done"]')).toBeVisible();

    const evidence = inspector.locator('[data-evidence="block"]');

    await expect(
      evidence.locator('[data-evidence-field="duration"] .value'),
    ).toHaveText(/^\d+(\.\d+)? (ms|s)$/);

    const moments = evidence.locator('[data-time="fine"]');

    await expect(moments.first()).toBeVisible();

    for (const moment of await moments.all()) {
      await expect(moment).toHaveText(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
    }

    await expect(evidence).not.toContainText('__dbos_serializer');
  });
});

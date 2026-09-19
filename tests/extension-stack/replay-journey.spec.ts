import { access, readFile } from 'node:fs/promises';
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
 * Inspector beside it, and the modal the editor
 * draws to confirm. The modal is workbench chrome
 * rather than anything a webview owns, which is why
 * the helper that answers it reads the box's words
 * rather than looking for a mark this suite chose.
 *
 * What the fork inherits is deliberately not
 * asserted here. `two-blocks` records exactly one
 * operation, so a replay from its only step has
 * nothing before it to carry over — the row that
 * runs new is the whole of the fork's trace. The
 * claim this file can honestly make is that the
 * fork ran the step again, finished, and knows which
 * run it came out of.
 *
 * With two runs on the ledger, the rest is about
 * the Inspector beside a run's tab: reaching the
 * replay with the keyboard alone, the pane coming
 * back when a run is opened, the run input as it is
 * typed, and an edit made from the run's tab. Each
 * of those finds its own frames and opens its own
 * run rather than trusting the one before.
 */
type Workflow = {
  nodes: { id: string; title?: string; retry?: { maxAttempts?: number } }[];
};

test.describe('a replay, from a run that finished', () => {
  const NAME = 'replay-journey';
  const WORKFLOW = 'two_blocks';
  const BLOCK = 'answer_it';
  const QUESTION = 'what does a fork keep';
  const TRIGGER = 'started_by_hand';
  const FILE = `${WORKFLOW}.workflow.json`;
  const RENAMED = 'Answer the enquiry';

  /** Typed into the Runs view's box, and nowhere
   *  else: unique to this run of the file, so
   *  finding it anywhere is finding it copied. */
  const MARK = `e2e-${Date.now()}`;
  const SENTINEL = JSON.stringify({ sentinel: MARK });

  const kind = '[data-inspector-header] [data-inspector-kind]';
  const runState = '[data-inspector-header] [data-run-state]';
  const title = '[data-field="title"] input';

  let project: string;
  let vscode: DrivenVsCode;
  let runs: FrameLocator;
  let see: FrameLocator;

  /** The run the fork came out of, and the fork. */
  let parentId = '';
  let forkId = '';

  const document = (): string => join(project, '.mboss', 'workflows', FILE);

  /** The Runs view, shown and found afresh. */
  const openRuns = async (): Promise<FrameLocator> => {
    await vscode.runCommand('mBoss: Open Runs');

    return vscode.webview('runs');
  };

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

    runs = await openRuns();
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

  test(`runs ${WORKFLOW} and the run reaches done`, async () => {
    test.setTimeout(600_000);

    const start = runs.locator('[data-run-workflow]');

    // One saved workflow, so nothing to pick: the
    // row's name below says which one Run meant.
    await expect(start).toBeVisible();
    await expect(runs.locator('[data-workflow-picker]')).toHaveCount(0);

    await runs
      .locator('[data-input]')
      .fill(`{ "question": ${JSON.stringify(QUESTION)} }`);

    const before = await listedRuns(runs);

    await start.click();

    parentId = await startedRun(runs, before);

    const row = runRow(runs, parentId);

    await expect(row).toHaveAttribute('data-outcome', 'done', {
      timeout: 300_000,
    });
    await expect(row.locator('.run-name')).toHaveText(WORKFLOW);
  });

  /**
   * Picking the block, on the run's own picture.
   *
   * The Inspector beside the run then reads that
   * block, and offers the replay from it. A block
   * picked with no row of its own picked stands for
   * the block's own default row, which is what makes
   * "from here" mean a point in the run rather than
   * a whole run over again.
   *
   * The offer is looked for on the block's card and
   * nowhere else: the whole run's card, which the
   * Inspector shows while nothing is picked, has a
   * replay of its own, from the start.
   */
  test('the run page offers a replay from the block that ran', async () => {
    await openRunTab(runs, parentId);

    see = await vscode.webview('see');

    await expect(see.locator(`.see[data-run="${parentId}"]`)).toBeVisible();

    await see.locator('[data-see-tab="graph"]').click();
    await see.locator(`[data-run-node="${BLOCK}"]`).click();

    const inspector = await vscode.inspector();

    await expect(inspector.locator(kind)).toHaveText('step');
    await expect(
      inspector.locator(
        '[data-evidence="block"] [data-evidence-action="replayFrom"]',
      ),
    ).toBeEnabled();
  });

  /**
   * The confirmation, and what comes out of it.
   *
   * The fork is found by elimination rather than by
   * reading an id off a page: the list is the
   * project's own ledger, nothing else in this
   * window starts runs, so the one id it shows after
   * the click that it did not show before is the run
   * that click made, whatever it is called.
   */
  test('replaying forks a second run that finishes', async () => {
    test.setTimeout(600_000);

    runs = await vscode.webview('runs');

    const before = await listedRuns(runs);

    expect(before).toEqual([parentId]);

    await (
      await vscode.inspector()
    )
      .locator('[data-evidence="block"] [data-evidence-action="replayFrom"]')
      .click();

    const said = await vscode.answerDialog('Replay');

    // The box names the point rather than the run,
    // and says in as many words that a first durable
    // operation has nothing behind it to carry over.
    expect(said).toContain('Replay from Answer it?');
    expect(said).toContain(
      "nothing — this is the run's first durable operation",
    );

    runs = await vscode.webview('runs');

    await expect
      .poll(
        async () => {
          const now = await listedRuns(runs);

          return now.filter((id) => !before.includes(id));
        },
        { message: 'the list showed no second run' },
      )
      .toHaveLength(1);

    forkId = (await listedRuns(runs)).find((id) => id !== parentId) ?? '';
    expect(forkId, 'the list showed no second run').not.toBe('');

    await expect(runRow(runs, forkId)).toHaveAttribute('data-outcome', 'done', {
      timeout: 300_000,
    });
  });

  /**
   * Which run this one came out of, said beside the
   * run's own tab.
   *
   * With the fork's tab open and nothing picked on
   * it, the Inspector is about the whole run. Its
   * lineage is drawn from the column the fork itself
   * carries, so the parent's line being there is the
   * proof that the fork was recorded as a replay of
   * it and not as an unrelated second run that
   * happens to have finished. The run the card is
   * about is not one of its lines; the header names
   * it, by its short id.
   *
   * The step is asserted to have run rather than to
   * have been carried over. A run of one step forked
   * from that step has nothing before it to copy, so
   * every row in the fork is a row the fork ran.
   */
  test('the fork names the run it came out of', async () => {
    await openRunTab(runs, forkId);

    await expect(see.locator(`.see[data-run="${forkId}"]`)).toBeVisible();

    const inspector = await vscode.inspector();

    await expect(
      inspector.locator(`[data-inspector-header] [data-short-run="${forkId}"]`),
    ).toBeVisible();
    await expect(
      inspector.locator(`[data-lineage] [data-lineage-run="${parentId}"]`),
    ).toBeVisible();

    await see.locator('[data-see-tab="trace"]').click();

    await expect(
      see.locator(`[data-trace-group="${BLOCK}"] [data-trace-op]`).first(),
    ).toHaveAttribute('data-reuse', 'own');
  });

  /**
   * The replay, reached from the keyboard alone.
   *
   * A row on the Trace tab is a control: Enter on
   * it picks the operation, and with it the block
   * that wrote it. The view's own focus command,
   * asked for from the palette by the keyboard,
   * then puts the keyboard in the Inspector, and
   * Tab walks it to the replay on that block's
   * card. The walk is bounded by the number of
   * places the Inspector's page can stop at, so a
   * card that left the replay out of the order
   * fails here rather than walking for ever.
   *
   * The palette is opened with its key rather than
   * through `runCommand()`. That one parks on the
   * Explorer first, which takes the mBoss views off
   * screen, and the editor drops the keyboard when
   * it focuses a view whose page is still being
   * drawn again — the Runs view's own focus command
   * does the same from there. Here the views are on
   * screen, as they are while a run's tab is open.
   */
  test('the replay is reached from the keyboard alone', async () => {
    runs = await openRuns();

    await openRunTab(runs, parentId);

    see = await vscode.webview('see');

    await expect(see.locator(`.see[data-run="${parentId}"]`)).toBeVisible();

    const trace = see.locator('[data-see-tab="trace"]');

    await trace.focus();
    await trace.press('Enter');

    const op = see
      .locator(`[data-trace-group="${BLOCK}"] [data-trace-op]`)
      .first();
    const functionId = await op.getAttribute('data-trace-op');

    await op.focus();
    await op.press('Enter');

    await expect(op).toHaveAttribute('aria-current', 'true');

    await vscode.runCommandWithKeyboard('mBoss: Focus on Inspector View');

    await expect.poll(() => vscode.webviewHasFocus('inspector')).toBe(true);

    const inspector = await vscode.webview('inspector');
    const replay = inspector.locator(
      '[data-evidence="block"] [data-evidence-action="replayFrom"]',
    );

    // The row, not only the block: the head names
    // the operation Enter picked.
    await expect(
      inspector.locator(
        `[data-inspector-header] [data-function-id="${functionId}"]`,
      ),
    ).toBeVisible();
    await expect(replay).toBeVisible();

    const stops = await inspector
      .locator('body')
      .evaluate(
        (body) =>
          body.querySelectorAll(
            'a[href], button, input, select, textarea, [tabindex]',
          ).length,
      );

    expect(stops, 'the Inspector drew nothing to stop at').toBeGreaterThan(0);

    // On the replay, and in the page that has the
    // keyboard: a page keeps its last focused
    // element after the keyboard has left it.
    const focused = (): Promise<boolean> =>
      replay.evaluate(
        (button) =>
          button === button.ownerDocument.activeElement &&
          button.ownerDocument.hasFocus(),
      );

    let presses = 0;

    while (!(await focused()) && presses <= stops) {
      await vscode.page.keyboard.press('Tab');
      presses += 1;
    }

    test.info().annotations.push({
      type: 'Tab presses',
      description: `${presses} of at most ${stops + 1}`,
    });

    expect(await focused(), 'Tab never reached the replay').toBe(true);
  });

  /**
   * A run opened brings back the Inspector somebody
   * folded away.
   *
   * The run's whole card is what there is to read
   * about a run nobody has picked anything on yet,
   * so a run the tab had not been showing puts the
   * Inspector back on screen, open under its header,
   * with no focus command run by anybody. Twice,
   * because the second fold is what says the first
   * reveal was not the view being drawn for the
   * first time.
   */
  test('a run opened unfolds the Inspector it is read in', async () => {
    runs = await openRuns();

    // The fork on the tab first, so the parent is
    // a run the tab had not been showing.
    await openRunTab(runs, forkId);
    await expect.poll(() => vscode.showsWebview('inspector')).toBe(true);

    for (const id of [parentId, forkId]) {
      await vscode.collapseView('Inspector');
      await expect.poll(() => vscode.showsWebview('inspector')).toBe(false);

      await openRunTab(runs, id);

      await expect.poll(() => vscode.showsWebview('inspector')).toBe(true);
      await expect(vscode.activeEditorTab()).toContainText(id);

      const inspector = await vscode.webview('inspector');

      await expect(inspector.locator('[data-evidence="run"]')).toBeVisible();
      await expect(
        inspector.locator(`[data-inspector-header] [data-short-run="${id}"]`),
      ).toBeVisible();
    }
  });

  /**
   * What a run will be started with, on the trigger,
   * as it is typed.
   *
   * The Runs view's box is the one place a run's
   * input is typed, and the trigger's card reads it
   * rather than keeping a copy: what is in the box
   * is on the card with nothing saved and nothing
   * refreshed in between. Nor does it go near the
   * document — the workflow file never has it.
   */
  test("the trigger's card shows the run input as it is typed", async () => {
    await vscode.openFile(FILE);

    const canvas = await vscode.webview('canvas');
    const trigger = canvas.locator(`.react-flow__node[data-id="${TRIGGER}"]`);

    await expect(trigger).toBeVisible();

    // Opening the file took the side bar to the
    // Explorer, and the box is in the Runs view.
    runs = await openRuns();

    await runs.locator('[data-input]').fill(SENTINEL);

    await trigger.click();

    const inspector = await vscode.inspector();

    await expect(inspector.locator(kind)).toHaveText('trigger');

    await inspector.locator('[data-inspector-tab="configure"]').click();

    await expect(
      inspector.locator('[data-run-sample] [data-recorded]'),
    ).toContainText(MARK);

    // Typed again with the card already drawn, so
    // what it shows next is the box followed rather
    // than the box read once. Found without a
    // command: a command would draw both pages anew.
    const RETYPED = `${MARK}-retyped`;

    runs = await vscode.webview('runs');

    await runs
      .locator('[data-input]')
      .fill(JSON.stringify({ sentinel: RETYPED }));

    await expect(inspector.locator(kind)).toHaveText('trigger');
    await expect(
      inspector.locator('[data-run-sample] [data-recorded]'),
    ).toContainText(RETYPED);

    expect(await readFile(document(), 'utf8')).not.toContain(MARK);
  });

  /**
   * An edit made from the run's tab, to a document
   * nobody has open.
   *
   * The edit goes through a canvas, because the
   * canvas is where an edit is checked and written,
   * so one opens beside the run without taking the
   * front from it. The run's tab stays in front, and
   * the Inspector stays about the block as it was
   * picked on the run: the run's state at its head,
   * on the face somebody chose there.
   *
   * The face is what tells the two apart. A canvas
   * follows the run this window last started, the
   * fork, so the same block picked on it carries a
   * run's state at its head too; but a canvas opens
   * a followed block on what the run recorded until
   * somebody picks otherwise there. So the block is
   * picked on the canvas once, to see that face,
   * before the run's tab is brought back.
   *
   * The edits land in the canvas' buffer, and saving
   * the run's tab would save nothing, since it holds
   * no document. Save All writes the canvas beside
   * it: both edits are then in the file, and the
   * run input typed into the Runs view is not.
   */
  test('an edit from the run tab opens the canvas beside it', async () => {
    await vscode.runCommand('View: Close All Editors');
    await expect(vscode.editorTab(FILE)).toHaveCount(0);

    runs = await openRuns();

    await openRunTab(runs, parentId);

    see = await vscode.webview('see');

    await expect(see.locator(`.see[data-run="${parentId}"]`)).toBeVisible();

    await see.locator('[data-see-tab="graph"]').click();
    await see.locator(`[data-run-node="${BLOCK}"]`).click();

    let inspector = await vscode.inspector();

    await expect(inspector.locator(kind)).toHaveText('step');
    await expect(inspector.locator(runState)).toBeVisible();

    await inspector.locator('[data-inspector-tab="configure"]').click();
    await inspector.locator(title).fill(RENAMED);
    await inspector.locator(title).press('Enter');

    await expect(vscode.editorTab(FILE)).toHaveCount(1);

    const canvas = await vscode.webview('canvas');
    const block = canvas.locator(`.react-flow__node[data-id="${BLOCK}"]`);

    // Read off the canvas, which draws the buffer:
    // the edit has landed once this holds.
    await expect(block.locator('.node-title')).toHaveText(RENAMED);

    await expect(vscode.activeEditorTab()).toContainText(parentId);

    const configure = '[data-inspector-tab="configure"]';
    const evidence = '[data-inspector-tab="evidence"]';

    inspector = await vscode.inspector();

    await expect(inspector.locator(kind)).toHaveText('step');
    await expect(inspector.locator(title)).toHaveValue(RENAMED);
    await expect(inspector.locator(runState)).toBeVisible();
    await expect(inspector.locator(configure)).toHaveAttribute(
      'aria-selected',
      'true',
    );

    // The same block, picked on the canvas instead.
    await vscode.editorTab(FILE).click();
    await block.click();

    inspector = await vscode.inspector();

    await expect(inspector.locator(title)).toHaveValue(RENAMED);
    await expect(inspector.locator(evidence)).toHaveAttribute(
      'aria-selected',
      'true',
    );

    // Back to the run's tab, whose pick and face
    // the Inspector takes up again, for the second
    // edit.
    await vscode.editorTabTitled(parentId).click();
    await expect(vscode.activeEditorTab()).toContainText(parentId);

    inspector = await vscode.inspector();

    await expect(inspector.locator(configure)).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(inspector.locator(runState)).toBeVisible();

    const tries = inspector.locator('[data-field="retryMaxAttempts"] input');

    await tries.fill('5');
    await tries.press('Enter');

    // Nothing has been written yet: both edits are
    // in the buffer the canvas holds.
    const unsaved = JSON.parse(await readFile(document(), 'utf8')) as Workflow;

    expect(unsaved.nodes.find((one) => one.id === BLOCK)?.title).not.toBe(
      RENAMED,
    );

    await vscode.runCommand('File: Save All');

    await expect(async () => {
      const text = await readFile(document(), 'utf8');
      const node = (JSON.parse(text) as Workflow).nodes.find(
        (one) => one.id === BLOCK,
      );

      expect(node?.title).toBe(RENAMED);
      expect(node?.retry?.maxAttempts).toBe(5);
      expect(text).not.toContain(MARK);
    }).toPass({ timeout: 60_000 });
  });
});

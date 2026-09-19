import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type FrameLocator } from '@playwright/test';

import {
  discardExtensionProject,
  driveVsCode,
  extensionProject,
  type DrivenVsCode,
} from '../../helpers/vscode.js';

/**
 * The Inspector, following the block picked on a
 * canvas, and selecting one costs nothing else on
 * screen.
 *
 * The Inspector is a view of its own in the mBoss
 * side bar, beside the agent panel rather than in
 * its place. Picking a block tells it which one to
 * draw; nothing is swapped out to make room. So the
 * sharpest assertion here is about a panel this
 * spec never selects anything in. A view that is
 * built again comes back empty, so an unsent draft
 * left in the composer is the one piece of state
 * that can tell "still there" from "built again":
 * nothing on the host side holds it, and no reload
 * can put it back.
 *
 * Every test selects for itself rather than
 * inheriting the one before it. A selection is the
 * canvas' own state and a redraw is entitled to
 * clear it, so a test that assumed a block was
 * still selected would be asserting against
 * whatever the last redraw left — and would pass
 * for the wrong reason on the day the Inspector
 * stopped following.
 *
 * And every read of the Inspector finds its page
 * afresh. A save through the palette takes the side
 * bar's views off screen, and a view off screen
 * loses its page, so a frame kept from before one
 * would be reading nothing.
 */
test.describe('the Inspector, following a canvas', () => {
  /** Typed into the agent panel and left there. */
  const DRAFT = 'a question nobody sent';

  const FIXTURE = 'two_blocks.workflow.json';
  const TRIGGER = 'started_by_hand';
  const STEP = 'answer_it';

  const title = '[data-field="title"] input';
  const kind = '[data-inspector-header] [data-inspector-kind]';

  let project: string;
  let vscode: DrivenVsCode;
  let canvas: FrameLocator;
  let sidebar: FrameLocator;

  /** Only the parts of a workflow this spec reads. */
  type Workflow = {
    nodes: { id: string; title: string; out?: string }[];
  };

  const workflow = async (): Promise<Workflow> =>
    JSON.parse(
      await readFile(join(project, '.mboss', 'workflows', FIXTURE), 'utf8'),
    ) as Workflow;

  const block = (id: string) =>
    canvas.locator(`.react-flow__node[data-id="${id}"]`);

  test.beforeAll(async () => {
    project = await extensionProject({
      name: 'inspector',
      overlay: 'two-blocks',
      fakeAgent: true,
    });
    vscode = await driveVsCode({ project });

    // The composer is only offered once there is
    // somewhere for what is typed into it to go,
    // and a restricted window is not that.
    await vscode.trustFolder();

    await vscode.openFile(FIXTURE);
    canvas = await vscode.webview('canvas');

    await vscode.runCommand('mBoss: Open Agent Sidebar');
    sidebar = await vscode.webview('sidebar');

    await sidebar.locator('.composer textarea').fill(DRAFT);
  });

  test.afterAll(async () => {
    await vscode?.close();
    await discardExtensionProject(project);
  });

  test('selecting a block names it at the head of the Inspector', async () => {
    await block(STEP).click();

    const inspector = await vscode.inspector();

    await expect(inspector.locator(kind)).toHaveText('step');
    await expect(inspector.locator(title)).toHaveValue('Answer it');
  });

  /**
   * The other half of the same claim, and the only
   * one a real editor is needed for.
   *
   * The Inspector being filled is checked first, so
   * that what follows is read after a selection has
   * definitely landed rather than after one that
   * quietly did not.
   */
  test('the agent panel is left alone by a selection', async () => {
    await block(TRIGGER).click();

    await expect((await vscode.inspector()).locator(kind)).toHaveText(
      'trigger',
    );

    expect(await vscode.showsWebview('sidebar')).toBe(true);

    // The draft from before the selection, still in
    // the box a person left it in. A panel that had
    // been built again would be offering an empty
    // one.
    await expect(sidebar.locator('.composer textarea')).toHaveValue(DRAFT);
  });

  test('letting the block go leaves the Inspector asking for one', async () => {
    await block(STEP).click();
    await expect((await vscode.inspector()).locator(kind)).toHaveText('step');

    await canvas
      .locator('.react-flow__pane')
      .click({ position: { x: 8, y: 8 } });

    await expect(
      (await vscode.inspector()).locator(
        '[data-inspector] .empty-state .empty-title',
      ),
    ).toHaveText('Pick a block to set what it does');
  });

  /**
   * A block renamed at the head of the Inspector,
   * on disk.
   *
   * The Inspector's edits reach VS Code as edits to
   * the document the canvas has open, which is a
   * buffer and not a file — so this saves the way a
   * person does and then reads what is actually
   * there. The canvas redrawing the block under its
   * new name is what says the edit reached the
   * document before the save is asked for; a save
   * that overtook it would write the old name.
   */
  test('a block renamed in the Inspector is saved by that name', async () => {
    await block(STEP).click();

    const inspector = await vscode.inspector();

    await expect(inspector.locator(kind)).toHaveText('step');

    const field = inspector.locator(title);

    await field.fill('Answer the enquiry');
    await field.press('Enter');

    await expect(block(STEP).locator('.node-title')).toHaveText(
      'Answer the enquiry',
    );

    await vscode.save();

    await expect(async () => {
      const node = (await workflow()).nodes.find((one) => one.id === STEP);

      expect(node?.title).toBe('Answer the enquiry');
    }).toPass();
  });

  /**
   * The second face, with nothing behind it.
   *
   * Nothing in this window has been run, so the tab
   * that reads what a run recorded has nothing to
   * read — and says which of the two things missing
   * would give it something rather than opening
   * empty. It refuses rather than being switched
   * off, so the arrow keys still land on it and the
   * reason is read out there.
   *
   * The tab is found by its mark and not by its
   * words. What it says is "Run evidence", which a
   * spec matching a title case by case would be
   * asserting about typography, and a translated
   * window would not say at all.
   */
  test('offers no evidence until there is a run', async () => {
    await block(STEP).click();

    const inspector = await vscode.inspector();

    await expect(inspector.locator(kind)).toHaveText('step');
    await expect(
      inspector.locator('[data-inspector-tab="evidence"]'),
    ).toHaveAttribute('aria-disabled', 'true');
    await expect(
      inspector.locator('[data-inspector] [data-no-run]'),
    ).toHaveText('start or pick a run to see what it recorded');

    // Which leaves the face that is about what the
    // block should do — including how hard it tries,
    // the three numbers together, because a step
    // that runs once on a timeout is a different
    // step.
    for (const field of [
      'retryMaxAttempts',
      'retryIntervalSeconds',
      'retryBackoffRate',
    ]) {
      await expect(inspector.locator(`[data-field="${field}"]`)).toBeVisible();
    }
  });

  /**
   * A trigger offers to start a run only of the
   * workflow as it was saved.
   *
   * A run starts what was saved and built, so an
   * edit nobody has saved means a run would start
   * something that is not on screen, and the card
   * says to save instead. Saving puts the offer
   * back — and nothing but the save tells the
   * Inspector to: the edit is already in, and the
   * only thing that changes is that the editor
   * stops holding unsaved changes.
   *
   * So the save here is made with the keyboard,
   * leaving the Inspector on screen in the page it
   * was already showing. A save through the palette
   * would take that page away and draw a new one,
   * which would read the saved state whether or not
   * the Inspector had ever been told of the save.
   *
   * The input type is put back afterwards, for the
   * test after this one.
   */
  test('a trigger offers its run again once the edit is saved', async () => {
    await block(TRIGGER).click();

    const inspector = await vscode.inspector();

    await expect(inspector.locator(kind)).toHaveText('trigger');

    // Offered before anything changes, so that its
    // going away below is the edit's doing.
    await expect(inspector.locator('[data-run-trigger]')).toBeVisible();

    const input = inspector.locator('[data-field="out"] input');

    await input.fill('Question');
    await input.press('Enter');

    await expect(inspector.locator('[data-run-trigger]')).toHaveCount(0);
    await expect(inspector.locator('[data-run-refused]')).toHaveText(
      'save the workflow to run it',
    );

    await vscode.saveWithKeyboard();

    await expect(inspector.locator('[data-run-trigger]')).toBeVisible();
    await expect(inspector.locator('[data-run-refused]')).toHaveCount(0);

    await expect(async () => {
      const node = (await workflow()).nodes.find((one) => one.id === TRIGGER);

      expect(node?.out).toBe('Question');
    }).toPass();

    await input.fill('Enquiry');
    await input.press('Enter');
    await vscode.saveWithKeyboard();

    await expect(async () => {
      const node = (await workflow()).nodes.find((one) => one.id === TRIGGER);

      expect(node?.out).toBe('Enquiry');
    }).toPass();
  });

  /**
   * The way out of the Inspector and into the code.
   *
   * Last in the file on purpose: the handler opens
   * in the group the canvas is in, so it takes the
   * canvas' place — and a test that ran after this
   * one would be reading a frame that is no longer
   * on screen.
   *
   * The tab is asserted absent first. Without that
   * this would pass on a file some earlier step had
   * already opened, which is the one way a button
   * that does nothing looks like a button that
   * works.
   */
  test('the way to the code opens the function in a tab', async () => {
    const tab = vscode.editorTab('answerIt.ts');

    await expect(tab).toHaveCount(0);

    await block(STEP).click();

    const inspector = await vscode.inspector();

    await expect(inspector.locator(kind)).toHaveText('step');
    await inspector
      .locator('[data-configure-actions] [data-open-function]')
      .click();

    await expect(tab).toBeVisible();
  });
});

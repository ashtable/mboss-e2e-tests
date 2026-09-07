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
 * The Inspector is a column of the canvas, and
 * selecting a block costs nothing else on screen.
 *
 * It used to be a view of its own that took the
 * agent panel's place while a block was selected —
 * a context key, two opposite `when` clauses, and
 * the editor swapping one view for the other. That
 * arrangement worked, and it threw a conversation
 * away to answer a question about a title. The
 * column lives in the canvas' own page now, so
 * there is nothing left to swap.
 *
 * Which is why the sharpest assertion here is about
 * a panel this spec never selects anything in. A
 * view that is disposed comes back empty, so an
 * unsent draft left in the composer is the one
 * piece of state that can tell "still there" from
 * "built again": nothing on the host side holds it,
 * and no reload can put it back.
 *
 * Every test selects for itself rather than
 * inheriting the one before it. A selection is the
 * canvas' own state and a redraw is entitled to
 * clear it, so a test that assumed a block was
 * still selected would be asserting against
 * whatever the last redraw left — and would pass
 * for the wrong reason on the day the column
 * stopped working.
 */
test.describe('the Inspector, in the canvas', () => {
  /** Typed into the agent panel and left there. */
  const DRAFT = 'a question nobody sent';

  const heading = '[data-inspector-heading]';
  const title = '[data-field="title"] input';

  let project: string;
  let vscode: DrivenVsCode;
  let canvas: FrameLocator;
  let sidebar: FrameLocator;

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

    await vscode.openFile('two_blocks.workflow.json');
    canvas = await vscode.webview('canvas');

    await vscode.runCommand('mBoss: Open Agent Sidebar');
    sidebar = await vscode.webview('sidebar');

    await sidebar.locator('.composer textarea').fill(DRAFT);
  });

  test.afterAll(async () => {
    await vscode?.close();
    await discardExtensionProject(project);
  });

  test('selecting a block fills the column beside the graph', async () => {
    await canvas.locator('.react-flow__node[data-id="answer_it"]').click();

    // In the canvas' own frame, which is the whole
    // claim: one page, one message channel, no
    // second webview.
    await expect(canvas.locator(heading)).toHaveText('Node inspector · Step');
    await expect(canvas.locator(title)).toHaveValue('Answer it');
  });

  /**
   * The other half of the same claim, and the only
   * one a real editor is needed for.
   *
   * The column being filled is checked first, so
   * that what follows is read after a selection has
   * definitely landed rather than after one that
   * quietly did not.
   */
  test('the agent panel is left alone by a selection', async () => {
    await canvas
      .locator('.react-flow__node[data-id="started_by_hand"]')
      .click();

    await expect(canvas.locator(heading)).toHaveText(
      'Node inspector · Trigger',
    );

    expect(await vscode.showsWebview('sidebar')).toBe(true);

    // The draft from before the selection, still in
    // the box a person left it in. A panel that had
    // been disposed and built again would be
    // offering an empty one.
    await expect(sidebar.locator('.composer textarea')).toHaveValue(DRAFT);
  });

  test('letting the block go leaves the column asking for one', async () => {
    await canvas.locator('.react-flow__node[data-id="answer_it"]').click();
    await expect(canvas.locator(heading)).toBeVisible();

    await canvas
      .locator('.react-flow__pane')
      .click({ position: { x: 8, y: 8 } });

    await expect(canvas.locator('.inspector .state')).toHaveText(
      'Pick a block to set what it does.',
    );
  });

  /**
   * What the column is told, on disk.
   *
   * The Inspector's edits reach VS Code as edits to
   * the document it owns, which is a buffer and not
   * a file — so this saves the way a person does
   * and then reads what is actually there. A spec
   * that read the file without saving would be
   * asserting against the version it opened.
   */
  test('a field committed in the column reaches the file', async () => {
    await canvas.locator('.react-flow__node[data-id="answer_it"]').click();

    const field = canvas.locator(title);

    await field.fill('Answer the enquiry');
    await field.press('Enter');

    await vscode.save();

    await expect(async () => {
      const ir = JSON.parse(
        await readFile(
          join(project, '.mboss', 'workflows', 'two_blocks.workflow.json'),
          'utf8',
        ),
      ) as { nodes: { id: string; title: string }[] };

      expect(ir.nodes.find((node) => node.id === 'answer_it')?.title).toBe(
        'Answer the enquiry',
      );
    }).toPass();
  });

  /**
   * The second face, with nothing behind it.
   *
   * Nothing in this window has been run, so the tab
   * that reads what a run recorded has nothing to
   * read — and says which of the two things missing
   * would give it something rather than opening
   * empty.
   *
   * The tab is found by its mark and not by its
   * words. What it says is "Run evidence", which a
   * spec matching a title case by case would be
   * asserting about typography, and a translated
   * window would not say at all.
   */
  test('offers no evidence until there is a run', async () => {
    await canvas.locator('.react-flow__node[data-id="answer_it"]').click();

    await expect(
      canvas.locator('[data-inspector-tab="evidence"]'),
    ).toBeDisabled();
    await expect(canvas.locator('.inspector .hint')).toHaveText(
      'start or pick a run to see what it recorded',
    );

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
      await expect(canvas.locator(`[data-field="${field}"]`)).toBeVisible();
    }
  });

  /**
   * The way out of the column and into the code.
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

    await canvas.locator('.react-flow__node[data-id="answer_it"]').click();
    await canvas
      .locator(
        '[data-field="handler"][data-control="picker"] [data-open-function]',
      )
      .click();

    await expect(tab).toBeVisible();
  });
});

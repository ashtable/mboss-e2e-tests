import { expect, test, type FrameLocator } from '@playwright/test';

import {
  discardExtensionProject,
  driveVsCode,
  extensionProject,
  type DrivenVsCode,
} from '../../helpers/vscode.js';

/**
 * When the Inspector puts itself in front of
 * somebody, and when it keeps out of the way.
 *
 * The Inspector is a view in the mBoss container of
 * the side bar, and a view is only drawn while its
 * container is the one the side bar shows. So the
 * extension opens it for somebody once in a
 * window's life: the first canvas opened opens the
 * container, and the keyboard goes straight back to
 * the canvas. After that, a block picked on a
 * canvas brings the Inspector forward only while
 * that container is already showing. Showing a view
 * opens its container, so doing it for somebody who
 * has the Explorer in the side bar would take the
 * side bar from them on every click.
 *
 * Both halves are one window's story, told in
 * order: the first is a thing that happens once
 * per window, and the second is about every click
 * after it. Nothing here asks for the Inspector
 * through the helper that shows it again — whether
 * it is showing is the question.
 */
test.describe.serial('the Inspector shows itself', () => {
  const FIXTURE = 'two_blocks.workflow.json';
  const STEP = 'answer_it';

  /**
   * How long the side bar is watched for a view
   * that should not come.
   *
   * A selection reaches the extension in one
   * message and a reveal is one call back, so one
   * that was going to happen happens well inside
   * this.
   */
  const QUIET_MS = 5_000;

  /** Between looks at the side bar while watching. */
  const LOOK_MS = 100;

  let project: string;
  let vscode: DrivenVsCode;
  let canvas: FrameLocator;

  /**
   * Marks the page a webview is drawing, the first
   * time it is seen, and says which mark it
   * carries.
   *
   * A mark on the root element outlives every
   * redraw the page makes of itself and goes only
   * when the page does, so two different marks
   * seen for one view are two pages: the first one
   * dropped and drawn again.
   */
  const markOf = async (frame: FrameLocator): Promise<string | undefined> =>
    frame
      .locator('html')
      .evaluate((root) => {
        root.dataset.e2ePage ??= String(Math.random());

        return root.dataset.e2ePage;
      })
      .catch(() => undefined);

  test.beforeAll(async () => {
    project = await extensionProject({
      name: 'reveal',
      overlay: 'two-blocks',
    });
    vscode = await driveVsCode({ project });
  });

  test.afterAll(async () => {
    await vscode?.close();
    await discardExtensionProject(project);
  });

  /**
   * The first canvas meets somebody with the
   * Inspector, and leaves them where they were.
   *
   * Where they were is the canvas' tab, in front,
   * with nothing in the side bar holding the
   * keyboard. The extension shows the Inspector by
   * focusing it and then hands the keyboard back to
   * the editor, so the side bar is where a keyboard
   * that did not come back would be. Whether the
   * canvas' own page then has it is the editor's
   * business: a canvas opened from the file finder
   * asks for focus while its page is still loading,
   * and the editor can leave the keyboard on the
   * window itself instead, with no Inspector
   * anywhere.
   *
   * The Runs view is in the same container and is
   * drawn when it opens. It is watched from before
   * the canvas is asked for, because opening the
   * Inspector for somebody is only worth it if
   * nothing else in the side bar is torn down and
   * drawn again on the way.
   */
  test('the first canvas opens it, and leaves the keyboard be', async () => {
    const runsPages = new Set<string>();

    // Where the keyboard was each time it was
    // looked for once the Inspector showed, counted
    // only while the window had it at all: a
    // window the machine is not typing into has no
    // keyboard anywhere, which would say nothing
    // about the side bar.
    const keyboard: ('side bar' | 'elsewhere')[] = [];
    let shown = false;
    let watching = true;

    const watched = (async () => {
      while (watching) {
        if (await vscode.showsWebview('runs')) {
          const mark = await markOf(await vscode.webview('runs'));

          if (mark !== undefined) runsPages.add(mark);
        }

        if (shown && (await vscode.page.evaluate(() => document.hasFocus()))) {
          keyboard.push(
            (await vscode.sideBarHasFocus()) ? 'side bar' : 'elsewhere',
          );
        }

        await vscode.page.waitForTimeout(LOOK_MS);
      }
    })();

    try {
      // The window is made the one the machine is
      // typing into, as a person's is. An editor
      // started from a terminal is not, on every
      // desktop.
      await vscode.page.bringToFront();
      await vscode.openFile(FIXTURE);
      canvas = await vscode.webview('canvas');

      await canvas.locator(`.react-flow__node[data-id="${STEP}"]`).waitFor();

      await expect.poll(() => vscode.showsWebview('inspector')).toBe(true);
      shown = true;

      await expect(vscode.editorTab(FIXTURE)).toHaveClass(/\bactive\b/);

      // Long enough for a second drawing to have
      // started, or the keyboard to have gone to
      // the side bar, if anything was going to do
      // either.
      await vscode.page.waitForTimeout(QUIET_MS);
    } finally {
      watching = false;
      await watched;
    }

    expect(runsPages.size).toBe(1);

    await expect(vscode.editorTab(FIXTURE)).toHaveClass(/\bactive\b/);
    expect(keyboard.length).toBeGreaterThan(0);
    expect(keyboard).not.toContain('side bar');
  });

  test('a block picked beside the Explorer leaves it hidden', async () => {
    await vscode.runCommand('View: Show Explorer');

    await expect.poll(() => vscode.showsWebview('inspector')).toBe(false);
    await expect.poll(() => vscode.showsExplorer()).toBe(true);

    const block = canvas.locator(`.react-flow__node[data-id="${STEP}"]`);

    await block.click();

    // The selection landed, so a reveal had
    // something to answer; the Inspector not coming
    // is the container rule, not a click that went
    // nowhere.
    await expect(block).toHaveClass(/\bselected\b/);

    const until = Date.now() + QUIET_MS;

    while (Date.now() < until) {
      expect(await vscode.showsWebview('inspector')).toBe(false);

      await vscode.page.waitForTimeout(LOOK_MS);
    }

    expect(await vscode.showsWebview('inspector')).toBe(false);
    expect(await vscode.showsExplorer()).toBe(true);
  });
});

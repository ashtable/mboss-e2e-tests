import { expect, test } from '@playwright/test';

import {
  discardExtensionProject,
  driveVsCode,
  extensionProject,
  type DrivenVsCode,
} from '../../helpers/vscode.js';

/**
 * The one thing every other spec here is built on.
 *
 * A VS Code webview is not one iframe. The
 * workbench holds an `iframe.webview` whose name is
 * a fresh GUID, that iframe holds a second one that
 * calls itself `pending-frame` whatever it is
 * showing, and the extension's own page is inside
 * the second. Neither layer is documented, and the
 * editor moves both out of the view they belong to
 * and into an overlay, so nothing about the chain
 * can be read off the extension's own manifest.
 *
 * `helpers/vscode.ts` walks that chain, and every
 * assertion about the canvas, the agent panel or
 * the runs list depends on it. So it is asserted
 * once, here, on its own: an editor that renames a
 * layer fails as one spec saying the frame chain
 * broke rather than as every spec in this directory
 * failing on a selector that resolved to nothing.
 */
test.describe('the webview frame chain', () => {
  let project: string;
  let vscode: DrivenVsCode;

  test.beforeAll(async () => {
    project = await extensionProject({
      name: 'topology',
      overlay: 'sermon-helper',
    });
    vscode = await driveVsCode({ project });
  });

  test.afterAll(async () => {
    await vscode?.close();
    await discardExtensionProject(project);
  });

  test('the canvas renders inside the nested webview iframes', async () => {
    await vscode.openFile('sermon_helper.workflow.json');

    const canvas = await vscode.webview('canvas');

    // The caption under the graph, which the canvas
    // only draws once the host has handed it a
    // parsed document and core has laid it out.
    await expect(canvas.locator('[data-caption="graph"]')).toHaveText(
      /sermon_helper/,
    );
  });

  /**
   * Two of the four webviews are on screen at once
   * here, in the same overlay layer, and telling
   * them apart is the other half of what the helper
   * does. A chain that resolved but always answered
   * with the first frame would pass the assertion
   * above and quietly make every later spec read
   * the wrong panel.
   */
  test('each webview is reached by its own name', async () => {
    await vscode.runCommand('mBoss: Open Agent Sidebar');

    const sidebar = await vscode.webview('sidebar');
    const runs = await vscode.webview('runs');

    await expect(sidebar.locator('.agent')).toBeVisible();
    await expect(runs.locator('.runs')).toBeVisible();
  });
});

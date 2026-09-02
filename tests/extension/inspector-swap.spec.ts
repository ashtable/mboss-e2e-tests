import { expect, test, type FrameLocator } from '@playwright/test';

import {
  discardExtensionProject,
  driveVsCode,
  extensionProject,
  type DrivenVsCode,
} from '../../helpers/vscode.js';

/**
 * One container, two panels, and the selection
 * deciding which one is in it.
 *
 * Selecting a block on the canvas is meant to put
 * the Node Inspector where the agent panel was, and
 * letting go of it is meant to give the agent panel
 * back. Nothing about that is the extension's to
 * do: it sets a context key, the two views declare
 * opposite `when` clauses, and the editor swaps
 * them. Which means every piece of it can be
 * correct — the key is set, the clauses are
 * opposites, both bundles render — and the swap
 * still not happen, or happen with the Inspector
 * arriving as a collapsed section header nobody
 * asked to open.
 *
 * So this asks the editor. It is the one question
 * in this suite that only a real window can answer,
 * and the only place the answer is worth having.
 */
test.describe('the panel a selection swaps', () => {
  let project: string;
  let vscode: DrivenVsCode;
  let canvas: FrameLocator;

  test.beforeAll(async () => {
    project = await extensionProject({
      name: 'inspector',
      overlay: 'two-blocks',
    });
    vscode = await driveVsCode({ project });

    await vscode.openFile('two_blocks.workflow.json');
    canvas = await vscode.webview('canvas');

    // The container starts on the agent panel, which
    // is the state the swap is away from and back
    // to.
    await vscode.runCommand('mBoss: Open Agent Sidebar');
    await vscode.webview('sidebar');
  });

  test.afterAll(async () => {
    await vscode?.close();
    await discardExtensionProject(project);
  });

  test('selecting a block puts the Inspector where the agent was', async () => {
    await canvas.locator('.react-flow__node[data-id="answer_it"]').click();

    const inspector = await vscode.webview('inspector');

    // Expanded and drawing the block, not a section
    // header somebody still has to open.
    await expect(inspector.locator('[data-inspector-heading]')).toBeVisible();
    await expect(inspector.locator('[data-field="title"] input')).toHaveValue(
      'Answer it',
    );

    await expect(async () => {
      expect(await vscode.showsWebview('sidebar')).toBe(false);
    }).toPass();
  });

  test('letting go of it gives the agent panel back', async () => {
    await canvas
      .locator('.react-flow__pane')
      .click({ position: { x: 8, y: 8 } });

    const sidebar = await vscode.webview('sidebar');

    await expect(sidebar.locator('.agent')).toBeVisible();

    await expect(async () => {
      expect(await vscode.showsWebview('inspector')).toBe(false);
    }).toPass();
  });
});

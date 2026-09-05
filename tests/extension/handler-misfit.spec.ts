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
 * A handler that reaches another system, offered to
 * a step and put away by a transaction.
 *
 * Every link in this is asserted somewhere already,
 * and none of them is asserted joined. Core's own
 * suite scans a fixture and checks the manifest it
 * writes; the extension's webview suite feeds a
 * golden manifest to a picker and checks the row.
 * Between the two sits the thing a person actually
 * has: a packaged extension, type-checking a real
 * `lib/` on disk from inside the editor, and sending
 * what it found to a webview.
 *
 * That join is worth a spec because it fails
 * quietly. A handler with nothing recorded against
 * it is a handler that fits, so a scan that stopped
 * finding calls does not put an error anywhere — it
 * puts the row back in the list and the refusal
 * simply stops happening. Nothing that runs from a
 * repository checkout can catch that: the scan needs
 * Node's type declarations to know what `fetch` is,
 * and beside its own `node_modules` it always finds
 * them. Only the `.vsix` can be missing them.
 *
 * The wording is core's rule said short, and this is
 * the outermost place it is read, so it is read
 * exactly. The line in it is looked up in the
 * fixture rather than written down here, because a
 * number that agreed with a constant and not with
 * the file would be the one part of the sentence
 * nobody could trust.
 */
test.describe('a handler that dials out', () => {
  const FIXTURE = 'pay_claim.workflow.json';

  /** Calls a payment service. */
  const DIALS_OUT = 'chargeCard';

  /** Reaches outward too, on a socket it builds on
   *  the line that dials it. */
  const BUILDS_AND_DIALS = 'wireSettlement';

  /** Writes to the app's own database, and is here
   *  so that a picker with nothing in it cannot be
   *  mistaken for a picker that put everything
   *  away. */
  const LOCAL = 'recordPayment';

  let project: string;
  let vscode: DrivenVsCode;
  let canvas: FrameLocator;

  const row = (fn: string) => canvas.locator(`[data-picker-fn="${fn}"]`);
  const hidden = () => canvas.locator('[data-picker-hidden]');

  /** Selects a block, and waits for the column
   *  beside the graph to be showing that one. */
  const select = async (id: string, heading: string): Promise<void> => {
    await canvas.locator(`.react-flow__node[data-id="${id}"]`).click();

    await expect(canvas.locator('[data-inspector-heading]')).toHaveText(
      heading,
    );
  };

  /** Opens the drawer the put-away rows are behind.
   *  The control is a toggle and the block stays
   *  selected from one test to the next, so pressing
   *  it unasked would shut what the test before had
   *  opened. */
  const reveal = async (): Promise<void> => {
    if ((await row(DIALS_OUT).count()) === 0) await hidden().click();

    await expect(row(DIALS_OUT)).toBeVisible();
  };

  /** Where a handler's one outward call is, as the
   *  editor counts lines. */
  const outwardLineOf = async (fn: string, call: string): Promise<number> => {
    const source = await readFile(join(project, 'lib', `${fn}.ts`), 'utf8');
    const at = source.split('\n').findIndex((line) => line.includes(call));

    expect(at).toBeGreaterThanOrEqual(0);

    return at + 1;
  };

  test.beforeAll(async () => {
    project = await extensionProject({
      name: 'dialsout',
      overlay: 'dials-out',
    });
    vscode = await driveVsCode({ project });

    // Reading the code behind a workflow is a
    // type-check of somebody's files, which a
    // restricted window does not do — and without it
    // there is no picker to put anything away.
    await vscode.trustFolder();

    await vscode.openFile(FIXTURE);
    canvas = await vscode.webview('canvas');

    await canvas
      .locator('.react-flow__node[data-id="record_payment"]')
      .waitFor();
  });

  test.afterAll(async () => {
    await vscode?.close();
    await discardExtensionProject(project);
  });

  /**
   * Read first, because it is what makes the refusal
   * afterwards mean anything. A picker that had
   * nothing to say about this function — a scan that
   * found no handlers at all, a manifest that never
   * arrived — would fail here rather than passing
   * the next test for the wrong reason.
   */
  test('the step that runs it offers it, with nothing put away', async () => {
    await select('charge_card', 'Node inspector · Step');

    await expect(row(DIALS_OUT)).toBeVisible();
    await expect(row(BUILDS_AND_DIALS)).toBeVisible();
    await expect(row(LOCAL)).toBeVisible();
    await expect(hidden()).toHaveCount(0);
  });

  test('a transaction puts it away, and says why', async () => {
    await select('record_payment', 'Node inspector · Transaction');

    // Its neighbour is still offered: what the
    // transaction refuses is this function, not
    // every function.
    await expect(row(LOCAL)).toBeVisible();
    await expect(row(DIALS_OUT)).toHaveCount(0);

    await reveal();

    await expect(row(DIALS_OUT).locator('.lib-note')).toHaveText(
      `calls fetch at line ${await outwardLineOf(DIALS_OUT, 'fetch(')}, ` +
        'needs a step',
    );
  });

  /**
   * The same refusal, asked of the other way to
   * write the same line.
   *
   * Not a second test of one rule. The package is
   * built from a checkout of the library rather
   * than from a resolution of it, so nothing in
   * this suite has ever been able to say which
   * commit of the rules a `.vsix` carries: a
   * package zipped from a stale build directory,
   * or from a gitlink nobody moved, greys `fetch`
   * exactly as it always did and says nothing.
   * What is asked here is something the library
   * only learned recently — that a socket built on
   * the line that dials it is still a call out of
   * the handler, and not a chain rooted at a name
   * with an inner call to be recorded in its
   * place.
   *
   * Asked of the note rather than of the row's
   * absence, which is what the test above can ask
   * because it meets a closed drawer. By here the
   * drawer is open and every row is in the page,
   * so counting rows would be asking whether the
   * drawer is open. The note is the thing itself:
   * the picker writes one under a function it has
   * put away and none at all under one it is
   * offering.
   *
   * The module is in the sentence because the
   * callee is not a global. `fetch` is the whole
   * story under its own name; `new Socket().connect`
   * is a method on something, and the something is
   * where a person goes to look.
   */
  test('and the same call built inline, named where it is', async () => {
    await select('record_payment', 'Node inspector · Transaction');
    await reveal();

    const at = await outwardLineOf(BUILDS_AND_DIALS, '.connect(');

    await expect(row(BUILDS_AND_DIALS).locator('.lib-note')).toHaveText(
      `calls new Socket().connect (node:net) at line ${at}, needs a step`,
    );
  });
});

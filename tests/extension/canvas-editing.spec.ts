import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  expect,
  test,
  type FrameLocator,
  type Locator,
} from '@playwright/test';

import {
  discardExtensionProject,
  driveVsCode,
  extensionProject,
  type DrivenVsCode,
} from '../../helpers/vscode.js';

/**
 * Building a workflow by hand, and what that leaves
 * on disk.
 *
 * Two rules about coordinates are asserted from the
 * inside by the extension's own unit suite, and
 * neither of them is a rule about a function: they
 * are rules about what a person's hand does to a
 * file. Moving one block writes a position for every
 * block, so that the ones nobody touched stop
 * drifting when the engine lays the graph out again;
 * arranging takes every position back off, so that
 * there is one layout mode rather than two. Both are
 * only really true if a real pointer, a real save
 * and a real file agree, which is what this spec
 * asks.
 *
 * The pointer is the point. A block leaves the rail
 * on a press the canvas watches rather than on a
 * drag the browser runs, and a block already on the
 * graph is moved by the graph's own drag — so a
 * synthesised event would be testing neither. Every
 * gesture here is a press, a journey and a release.
 *
 * Arranging is asked for twice, because it is
 * shipped twice: the button in the canvas' toolbar
 * is the feature, and the palette command is what a
 * keybinding would reach. A person who found one of
 * them broken would not care which.
 */
test.describe('editing a workflow on the canvas', () => {
  const FIXTURE = 'two_blocks.workflow.json';

  /** The blocks the fixture arrives with. Anything
   *  else in the file was put there by this spec. */
  const TRIGGER = 'started_by_hand';
  const STEP = 'answer_it';
  const CAME_WITH = [TRIGGER, STEP];

  /** How far inside the pane a block is dropped:
   *  clear of the edges, and clear of the one wire,
   *  so this is a block being added rather than one
   *  spliced into a run. */
  const CLEAR = 90;

  /** How long the editor gets to write a gesture
   *  down, over as many saves as that takes. */
  const WRITE_MS = 30_000;

  let project: string;
  let vscode: DrivenVsCode;
  let canvas: FrameLocator;

  /** Only the parts of a workflow this spec reads. */
  type Workflow = {
    nodes: {
      id: string;
      kind: string;
      position?: { x: number; y: number };
    }[];
  };

  const workflow = async (): Promise<Workflow> =>
    JSON.parse(
      await readFile(join(project, '.mboss', 'workflows', FIXTURE), 'utf8'),
    ) as Workflow;

  /**
   * What the file says, once the editor has written
   * down what it was just told.
   *
   * Saving is inside the retry rather than before
   * it. A webview's edit reaches the document a
   * message later, and a save that overtook one
   * would write the version the gesture was about to
   * change — then sit re-reading that same file
   * until the timeout, blaming the gesture.
   *
   * The retry is given a clock of its own because
   * its default is the whole test's: a gesture that
   * genuinely did nothing would otherwise be saved
   * and re-read for five minutes before saying so.
   */
  const onDisk = async (check: (doc: Workflow) => void): Promise<void> => {
    await expect(async () => {
      await vscode.save();
      check(await workflow());
    }).toPass({ timeout: WRITE_MS });
  };

  /** The one block this spec put there. */
  const placed = (doc: Workflow): Workflow['nodes'][number] => {
    const [arrival, ...also] = doc.nodes.filter(
      (node) => !CAME_WITH.includes(node.id),
    );

    expect(also).toHaveLength(0);

    if (arrival === undefined) throw new Error('no block was added');

    return arrival;
  };

  /** Where something is on the page, which is what
   *  a pointer is aimed with. */
  const boxOf = async (what: Locator) => {
    const box = await what.boundingBox();

    if (box === null) throw new Error('nothing to aim at — it has no box');

    return box;
  };

  /**
   * A press, a journey and a release, in page
   * coordinates.
   *
   * The journey is in steps rather than one jump
   * because both gestures decide what they are doing
   * from where the pointer has been: one has a
   * threshold to cross before the block leaves the
   * rail, the other snaps to the grid as it goes.
   */
  const dragTo = async (
    what: Locator,
    to: { x: number; y: number },
  ): Promise<void> => {
    await what.hover();
    await vscode.page.mouse.down();
    await vscode.page.mouse.move(to.x, to.y, { steps: 20 });
    await vscode.page.mouse.up();
  };

  /** A block on the graph, moved by the given
   *  distance from wherever it is now. */
  const nudge = async (
    id: string,
    by: { x: number; y: number },
  ): Promise<void> => {
    const block = canvas.locator(`.react-flow__node[data-id="${id}"]`);
    const box = await boxOf(block);

    await dragTo(block, {
      x: box.x + box.width / 2 + by.x,
      y: box.y + box.height / 2 + by.y,
    });
  };

  test.beforeAll(async () => {
    project = await extensionProject({
      name: 'canvasedit',
      overlay: 'two-blocks',
    });
    vscode = await driveVsCode({ project });

    // A restricted window offers a canvas to read
    // and not one to edit, and every gesture here
    // is an edit.
    await vscode.trustFolder();

    await vscode.openFile(FIXTURE);
    canvas = await vscode.webview('canvas');

    await canvas.locator(`.react-flow__node[data-id="${STEP}"]`).waitFor();
  });

  test.afterAll(async () => {
    await vscode?.close();
    await discardExtensionProject(project);
  });

  test('a block carried out of the rail lands in the file', async () => {
    const pane = await boxOf(canvas.locator('.react-flow__pane'));

    await dragTo(canvas.locator('[data-palette-kind="step"]'), {
      x: pane.x + pane.width - CLEAR,
      y: pane.y + pane.height - CLEAR,
    });

    await expect(canvas.locator('.react-flow__node')).toHaveCount(
      CAME_WITH.length + 1,
    );

    await onDisk((doc) => {
      expect(doc.nodes).toHaveLength(CAME_WITH.length + 1);
      expect(placed(doc).kind).toBe('step');
    });
  });

  test('a block moved by hand stays where it was put', async () => {
    const before = placed(await workflow()).position;

    await nudge(placed(await workflow()).id, { x: -120, y: -40 });

    await onDisk((doc) => {
      expect(placed(doc).position).not.toEqual(before);

      for (const node of doc.nodes) expect(node.position).toBeDefined();
    });
  });

  test('the toolbar lets go of every position', async () => {
    await canvas.locator('[data-arrange]').click();

    await onDisk((doc) => {
      for (const node of doc.nodes) expect(node.position).toBeUndefined();
    });
  });

  /**
   * The same claim through the other door.
   *
   * A block is moved first, and not for tidiness: a
   * graph nobody has placed has nothing to let go
   * of, so the assertion below would read true of a
   * command that did nothing at all.
   *
   * That move is also where the first-move rule is
   * plainest, because here the file genuinely starts
   * with no positions in it — one block is dragged,
   * and afterwards every block has one.
   */
  test('and so does the command behind it', async () => {
    await nudge(placed(await workflow()).id, { x: 100, y: 60 });

    await onDisk((doc) => {
      for (const node of doc.nodes) expect(node.position).toBeDefined();
    });

    await vscode.runCommand('mBoss: Arrange Workflow');

    await onDisk((doc) => {
      for (const node of doc.nodes) expect(node.position).toBeUndefined();
    });
  });
});

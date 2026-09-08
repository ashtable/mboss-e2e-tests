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

  /** The queue block the last two tests build, by
   *  the id the editor gives the first one. */
  const QUEUE = 'queue';

  /**
   * What core says about a queue that holds its
   * items back per partition and never says which
   * partition an item is in.
   *
   * Written out rather than looked up: this
   * repository may not import `mboss-core`, and a
   * sentence quoted in half would still match the
   * other finding on the same rule.
   */
  const NO_PARTITION_KEY =
    '`queue` limits its queue per partition, but does not say which ' +
    'partition an item belongs to. Set the partition path.';

  /** And about deduplicating on one, which is the
   *  half of the same rule that a box on the form
   *  is a way out of. */
  const DEDUPLICATES =
    '`queue` deduplicates items on a partitioned queue, which DBOS does ' +
    'not support. Drop the deduplication path or the partition limits.';

  let project: string;
  let vscode: DrivenVsCode;
  let canvas: FrameLocator;

  /** Only the parts of a workflow this spec reads. */
  type Workflow = {
    nodes: {
      id: string;
      kind: string;
      position?: { x: number; y: number };

      /** A queue's two policies, as much of each as
       *  the last two tests set. Optional because
       *  every other kind here has a config of its
       *  own shape and none of it is read. */
      config?: QueueConfig;
    }[];
  };

  type QueueConfig = {
    itemsPath?: string;
    itemType?: string;
    queue?: {
      name?: string;
      globalConcurrency?: number;
      partitionConcurrency?: number;
    };
    enqueue?: { deduplicationPath?: string; partitionPath?: string };
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

  /** A box in the Inspector's column. Every field
   *  the last two tests type into is a line of
   *  text, including the ones holding a number. */
  const box = (id: string): Locator =>
    canvas.locator(`[data-field="${id}"] input`);

  /** Typed in and let go of, which is what commits
   *  a box — a field that changed on every
   *  keystroke would write a revision per letter. */
  const type = async (id: string, value: string): Promise<void> => {
    await box(id).fill(value);
    await box(id).press('Enter');
  };

  /**
   * The queue block, as the file has it once the
   * gesture before this has come back.
   *
   * Every gesture in the last two tests is followed
   * by one of these, and not for tidiness: an edit
   * carries the revision it was made against, and
   * the column is handed the next revision only
   * when the document changes — so a second box
   * committed while the first is still on its way
   * back is refused as stale, exactly as a second
   * writer would be. A person fills the next box
   * after seeing the last one take; this waits for
   * the same thing, and asserts what it waited for.
   */
  const onQueue = (check: (config: QueueConfig) => void): Promise<void> =>
    onDisk((doc) => {
      const config = doc.nodes.find((node) => node.id === QUEUE)?.config;

      if (config === undefined) throw new Error('no queue block in the file');

      check(config);
    });

  /** Whether the queue holds its items back per
   *  partition. A menu, so it commits the moment it
   *  changes. */
  const partitioning = (state: 'on' | 'off'): Promise<string[]> =>
    canvas.locator('[data-field="partitioning"] select').selectOption(state);

  /** What the Inspector draws under a box, which is
   *  a finding that box is one of the ways out
   *  of. */
  const note = (id: string): Locator =>
    canvas.locator(`[data-field="${id}"] .field-note`);

  /**
   * Whether the editor is saying a sentence about
   * the block, or has stopped.
   *
   * Saved first, because PROBLEMS is filled by code
   * generation and generation answers the file
   * rather than the buffer the column edits. The
   * count is retried from there: a panel still
   * showing what the last generation found is the
   * ordinary state of one for a second or so after
   * a save, so both answers are waited for rather
   * than read once.
   */
  const said = async (sentence: string, times: number): Promise<void> => {
    await vscode.save();

    await expect(
      (await vscode.problems()).filter({ hasText: sentence }),
    ).toHaveCount(times);
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

  /**
   * A queue, set from both of the policies it has.
   *
   * A queue is registered once and its items are
   * enqueued one at a time, which is two scopes and
   * two groups on the form. Filling one field in
   * each is what says the groups are both reachable
   * — a form that folded the second away, or drew
   * it from the wrong half of the config, would
   * still pass a test that only ever typed above
   * the first header.
   *
   * Then the finding this block owns and no box on
   * the form does. Core reports two things about a
   * partitioned queue under one rule, and only the
   * deduplication half has a box holding half its
   * remedy; the missing partition key is answered
   * by filling a box in, not by emptying one, so it
   * stays the block's and is read where a block's
   * findings are read.
   */
  test('a queue is filled from both policies, and says what it lacks', async () => {
    const pane = await boxOf(canvas.locator('.react-flow__pane'));

    await dragTo(canvas.locator('[data-palette-kind="queue"]'), {
      x: pane.x + pane.width - CLEAR,
      y: pane.y + pane.height - CLEAR,
    });

    const block = canvas.locator(`.react-flow__node[data-id="${QUEUE}"]`);

    await expect(canvas.locator('[data-node-kind="queue"]')).toHaveCount(1);
    await expect(block.locator('.node-title')).toHaveText('Queue');

    await block.click();

    // Two boxes from the group that registers the
    // queue, and two from the group that enqueues
    // each item.
    await type('queueName', 'document-index');
    await onQueue((config) =>
      expect(config.queue?.name).toBe('document-index'),
    );

    await type('globalConcurrency', '8');
    await onQueue((config) => expect(config.queue?.globalConcurrency).toBe(8));

    await type('itemsPath', 'pages');
    await onQueue((config) => expect(config.itemsPath).toBe('pages'));

    await type('itemType', 'Page');
    await onQueue((config) => expect(config.itemType).toBe('Page'));

    // Turning it on writes a per-partition limit,
    // and a limit per partition with nothing saying
    // which partition an item is in is the thing
    // core refuses to let go quiet.
    await partitioning('on');
    await onQueue((config) =>
      expect(config.queue?.partitionConcurrency).toBeDefined(),
    );

    await expect(box('partitionPath')).toBeVisible();
    await said(NO_PARTITION_KEY, 1);

    // And the box that owns the other half of the
    // rule is left alone, because emptying it would
    // not answer this.
    await expect(note('deduplicationPath')).toHaveCount(0);

    await type('partitionPath', 'documentId');
    await onQueue((config) =>
      expect(config.enqueue?.partitionPath).toBe('documentId'),
    );
    await said(NO_PARTITION_KEY, 0);

    // The third group is the one nobody turns
    // often, so it arrives folded and stays that
    // way until it is asked for.
    const advanced = canvas.locator('[data-field="advanced"] .section-head');

    await expect(advanced).toHaveAttribute('aria-expanded', 'false');
    await expect(canvas.locator('[data-field="onConflict"]')).toHaveCount(0);

    await advanced.click();

    await expect(
      canvas.locator('[data-field="onConflict"] select'),
    ).toBeVisible();
  });

  /**
   * The other half of the same rule, which one box
   * does own.
   *
   * Deduplicating items on a partitioned queue is
   * the one of these DBOS refuses outright, and it
   * refuses it mid-run holding the item — so the
   * finding is drawn twice: on the block, where
   * every finding is, and under the box whose
   * emptying is half the remedy.
   *
   * That box stays editable while the queue is
   * partitioned, which is the design's one
   * deliberate divergence from a form that would
   * grey it out. Emptying it is a way out that a
   * disabled box would put behind the other way
   * out, so the last gesture here is not optional:
   * it is the reason the box is still a box.
   */
  test('and a queue says which of two remedies a box holds', async () => {
    await canvas.locator(`.react-flow__node[data-id="${QUEUE}"]`).click();

    // Back to a queue nothing is partitioned by,
    // which takes the partition key with it.
    await partitioning('off');
    await onQueue((config) => {
      expect(config.queue?.partitionConcurrency).toBeUndefined();
      expect(config.enqueue?.partitionPath).toBeUndefined();
    });

    await expect(box('partitionPath')).toHaveCount(0);

    await type('deduplicationPath', 'documentId');
    await onQueue((config) =>
      expect(config.enqueue?.deduplicationPath).toBe('documentId'),
    );

    // From here the note is the wait as well as the
    // assertion: it is drawn from the document and
    // not from what the column is holding, so it
    // only appears once the edit has come back.
    await partitioning('on');

    await expect(note('deduplicationPath')).toHaveText(DEDUPLICATES);
    await said(DEDUPLICATES, 1);

    await partitioning('off');

    await expect(note('deduplicationPath')).toHaveCount(0);
    await said(DEDUPLICATES, 0);

    // And the other way out of it, from the box
    // that is still a box.
    await partitioning('on');

    await expect(note('deduplicationPath')).toHaveText(DEDUPLICATES);
    await said(DEDUPLICATES, 1);

    await type('deduplicationPath', '');

    await expect(note('deduplicationPath')).toHaveCount(0);
    await said(DEDUPLICATES, 0);
  });
});

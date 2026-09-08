import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { driveVsCode, type DrivenVsCode } from '../../helpers/vscode.js';

/**
 * `mBoss: New Workflow…`, in a project made moments
 * earlier by `mBoss: New Project`.
 *
 * The claim the gallery makes is that a pattern is
 * not a wizard: what Use writes is the same
 * document the canvas draws, with the code its
 * blocks name already beside it. So each pattern
 * here is followed to where a person would look —
 * the blocks on the canvas, a handler file on disk,
 * and the TypeScript the project will actually run.
 *
 * That last file is the one nothing in the gallery
 * writes. Generation is what answers a document
 * landing, and it only answers in a window somebody
 * has trusted, which is why the folder is trusted
 * before either workflow is started rather than
 * after: writing handlers into somebody's
 * repository is the decision workspace trust exists
 * to make, and an untrusted window is told so
 * instead of being written into.
 *
 * Every workflow is started in the one project,
 * because what they have in common — a fresh
 * project, made by the command that makes them — is
 * the expensive half, and none of them can see what
 * the others wrote.
 */
test.describe('the template gallery', () => {
  /** The project both workflows land in. */
  const NAME = 'refunds_desk';

  /**
   * The palette entry, without the ellipsis its
   * title ends in.
   *
   * What is typed here is a filter, and every
   * character of it is one more chance for this to
   * be about an input method rather than about a
   * command.
   */
  const NEW_WORKFLOW = 'mBoss: New Workflow';

  /**
   * Every block `refund_approval` is made of.
   *
   * Written out rather than counted off the
   * library, because a spec that read the pattern to
   * find out what the pattern contains would pass on
   * the day the pattern lost half of it.
   */
  const REFUND_BLOCKS = [
    'refund_requested',
    'load_purchase',
    'evaluate_refund',
    'request_approval',
    'refund_payment',
    'update_order',
    'email_customer',
    'email_denial',
  ];

  /**
   * And every block the pattern that has a queue in
   * it is made of, written out for the same reason.
   *
   * `index_pages` is the queue: the pattern exists
   * to show a block that starts a run per item, so
   * a canvas that drew the other five would be
   * drawing the pattern with its point removed.
   */
  const INGESTION_BLOCKS = [
    'document_uploaded',
    'download_pdf',
    'parse_pages',
    'index_pages',
    'finalize_document',
    'notify_caller',
  ];

  let parent: string;
  let project: string;
  let vscode: DrivenVsCode;

  test.beforeAll(async () => {
    // Through `realpath` because the system temp
    // directory is a symlink on macOS, and the
    // editor reports back the resolved path.
    parent = await realpath(await mkdtemp(join(tmpdir(), 'mboss-gallery-')));
    project = join(parent, NAME);

    vscode = await driveVsCode({});

    await vscode.runCommand('mBoss: New Project');
    await vscode.answerFolderPick(parent);
    await vscode.answerInput(NAME);

    // The window comes back on the folder it just
    // made, and comes back restricted. Waiting for
    // that badge is also how this waits for the
    // reload.
    await vscode.trustFolder();
  });

  test.afterAll(async () => {
    await vscode?.close();
    await rm(parent, { recursive: true, force: true });
  });

  test('a pattern arrives whole, with its code beside it', async () => {
    await vscode.runCommand(NEW_WORKFLOW);

    const gallery = await vscode.webview('gallery');

    await gallery
      .locator('[data-pattern="refund_approval"] [data-use]')
      .click();

    // The pattern's own name, offered rather than
    // asked for, and taken as offered.
    expect(await vscode.acceptInput()).toBe('refund_approval');

    const canvas = await vscode.webview('canvas');
    const blocks = canvas.locator('.react-flow__node');

    await expect(blocks).toHaveCount(REFUND_BLOCKS.length);
    await expect(
      canvas.locator('.react-flow__node[data-id="refund_payment"]'),
    ).toBeVisible();

    // Sorted, because which block the graph draws
    // first is the layout's business and not this
    // spec's.
    const drawn = await blocks.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-id')),
    );

    expect(drawn.sort()).toEqual([...REFUND_BLOCKS].sort());

    // One of the four functions the document names,
    // written into the project rather than left as
    // an exercise.
    await expect(
      access(join(project, 'lib', 'getPurchase.ts')),
      'the pattern should have written its handlers',
    ).resolves.toBeUndefined();

    // And the file nothing in the gallery writes:
    // the document landed, the watchers answered it,
    // and the project has code to run. Polled
    // because generation is debounced — a person
    // sees it appear a moment later too.
    await expect(async () => {
      await expect(
        access(
          join(project, 'src', 'workflows', 'refund_approval.workflow.ts'),
        ),
      ).resolves.toBeUndefined();
    }).toPass();
  });

  /**
   * The other way in, which is not a pattern at all.
   *
   * A blank workflow is one trigger and nothing
   * else, so this asserts the count as well as the
   * block: a canvas that opened the workflow before
   * it would answer the second question and fail the
   * first.
   */
  test('and a blank one arrives as a single trigger', async () => {
    await vscode.runCommand(NEW_WORKFLOW);

    const gallery = await vscode.webview('gallery');

    await gallery.locator('[data-start-blank]').click();

    expect(await vscode.acceptInput()).toBe('my_workflow');

    const canvas = await vscode.webview('canvas');
    const blocks = canvas.locator('.react-flow__node');

    await expect(blocks).toHaveCount(1);
    await expect(blocks).toHaveAttribute('data-id', 'started');
  });

  /**
   * The pattern whose work is held by a queue,
   * followed the same way and one step further.
   *
   * The step further is what the generated file
   * says. A queue block compiles to a child
   * workflow the parent enqueues by name, and that
   * name is the only place the block's id, the
   * document's name and the queued grammar meet —
   * so it is the one string that proves the whole
   * chain ran rather than that six blocks were
   * drawn.
   */
  test('and the pattern that queues its work brings its queue', async () => {
    await vscode.runCommand(NEW_WORKFLOW);

    const gallery = await vscode.webview('gallery');

    await gallery
      .locator('[data-pattern="document_ingestion_queued"] [data-use]')
      .click();

    expect(await vscode.acceptInput()).toBe('document_ingestion_queued');

    const canvas = await vscode.webview('canvas');
    const blocks = canvas.locator('.react-flow__node');

    await expect(blocks).toHaveCount(INGESTION_BLOCKS.length);
    await expect(
      canvas.locator('.react-flow__node[data-id="index_pages"]'),
    ).toBeVisible();

    const drawn = await blocks.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-id')),
    );

    expect(drawn.sort()).toEqual([...INGESTION_BLOCKS].sort());

    // The function the queue runs for each item,
    // written beside the document the way the
    // other pattern's handlers were.
    await expect(
      access(join(project, 'lib', 'indexPage.ts')),
      'the pattern should have written its handlers',
    ).resolves.toBeUndefined();

    await expect(async () => {
      const generated = await readFile(
        join(
          project,
          'src',
          'workflows',
          'document_ingestion_queued.workflow.ts',
        ),
        'utf8',
      );

      expect(generated).toContain(
        'index_pages.queued.document_ingestion_queued',
      );
    }).toPass();
  });
});

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type FrameLocator } from '@playwright/test';

import {
  EXTENSION_MAILSINK_PORT,
  EXTENSION_MAIL_BASE_URL,
  composeDown,
  installDependencies,
  readEnv,
  rewriteEnv,
} from '../../helpers/app.js';
import { startMailsink, type Mailsink } from '../../helpers/mail.js';
import {
  discardExtensionProject,
  driveVsCode,
  extensionProject,
  type DrivenVsCode,
} from '../../helpers/vscode.js';

/**
 * The block that starts a run per item, against a
 * stack it started itself.
 *
 * The journey beside this one follows a workflow
 * whose every block runs inside the one run. This
 * follows the block that does not: the gallery's
 * queued pattern is used, its work is fanned out
 * over twelve pages, and each surface with
 * something to say about a queue is asked what it
 * says while the app is really running the code the
 * canvas drew.
 *
 * That is the only place any of them can be asked.
 * A queue block writes no row of its own — the work
 * is its children's runs — so everything the
 * extension says about one is counted out of a
 * ledger rather than read off a record, and nothing
 * below this tier has a ledger with children in it.
 *
 * One edit is made to the pattern before anything
 * runs, and it is the only one: the key its items
 * are deduplicated on is emptied, because the
 * pattern keys them on the document and twelve
 * pages of one upload would otherwise join one run.
 * It is spelled out where it happens.
 *
 * Opt-in, like its neighbour: `npm run e2e:stack`,
 * its own Playwright project, and not in CI. It
 * wants a Docker daemon, an image build and
 * minutes.
 *
 * It adds one thing to that neighbour's appetite:
 * an inbox. This pattern's last block mails whoever
 * uploaded the document, and a send with nowhere to
 * go ends the run `failed` for a reason that has
 * nothing to do with queues — so the project is
 * pointed at the suite's mail fixture and the run is
 * allowed to finish.
 */
test.describe('a queue block, over a real stack', () => {
  /**
   * One journey, so the tests below are steps in it
   * rather than cases.
   *
   * Serial because a worker that has failed a test
   * is thrown away and the next test starts a new
   * one — which here means a second scaffold, a
   * second install and a second stack, all of them
   * to run a step whose subject never happened.
   * Stopping at the first failure is both the
   * honest report and the cheap one.
   */
  test.describe.configure({ mode: 'serial' });

  const NAME = 'queue-journey';
  const WORKFLOW = 'document_ingestion_queued';
  const BLOCK = 'index_pages';
  const QUEUE = 'document-index';

  /**
   * The name the block's children are registered
   * under: the block's id, the queued region, and
   * the document this file belongs to.
   *
   * Written out rather than composed, because it is
   * the one string the emitter, the ledger and the
   * run page all have to agree about — and a spec
   * that built it the way the emitter does would be
   * agreeing with itself.
   */
  const QUEUED = 'index_pages.queued.document_ingestion_queued';

  /** How many pages the upload declares, which is
   *  how many runs the block starts. */
  const PAGES = 12;

  /**
   * What core says about a queue that holds its
   * items back per partition and never says which
   * partition an item is in.
   *
   * Written out for the reason the editor suite
   * writes it out: this repository may not import
   * `mboss-core`.
   */
  const NO_PARTITION_KEY =
    '`index_pages` limits its queue per partition, but does not say ' +
    'which partition an item belongs to. Set the partition path.';

  /** How long the editor gets to write a gesture
   *  down, over as many saves as that takes. */
  const WRITE_MS = 30_000;

  /** How long code generation gets to answer a
   *  document that has just changed. */
  const GENERATE_MS = 120_000;

  let project: string;
  let sink: Mailsink;
  let vscode: DrivenVsCode;
  let runs: FrameLocator;
  let canvas: FrameLocator;
  let see: FrameLocator;

  /** The run the panel started, and the thread
   *  through every test after it. */
  let runId = '';

  /** Only the parts of the block this spec reads
   *  back off disk. */
  type QueueConfig = {
    queue?: { partitionConcurrency?: number };
    enqueue?: { deduplicationPath?: string };
  };

  const documentPath = (): string =>
    join(project, '.mboss', 'workflows', `${WORKFLOW}.workflow.json`);

  const generatedPath = (): string =>
    join(project, 'src', 'workflows', `${WORKFLOW}.workflow.ts`);

  /** What the app will run, once the watchers have
   *  answered whatever just changed. */
  const generated = (): Promise<string> => readFile(generatedPath(), 'utf8');

  /**
   * The block, as the file has it once the editor
   * has written down what it was just told.
   *
   * Saving is inside the retry rather than before
   * it: a webview's edit reaches the document a
   * message later, and a save that overtook one
   * would write the version the gesture was about
   * to change.
   */
  const onQueue = (check: (config: QueueConfig) => void): Promise<void> =>
    expect(async () => {
      await vscode.save();

      const doc = JSON.parse(await readFile(documentPath(), 'utf8')) as {
        nodes: { id: string; config?: QueueConfig }[];
      };
      const config = doc.nodes.find((node) => node.id === BLOCK)?.config;

      if (config === undefined) throw new Error('no queue block in the file');

      check(config);
    }).toPass({ timeout: WRITE_MS });

  /** A box in the Inspector's column. */
  const box = (id: string) => canvas.locator(`[data-field="${id}"] input`);

  /** Typed in and let go of, which is what commits
   *  a box — a field that changed on every
   *  keystroke would write a revision per letter. */
  const type = async (id: string, value: string): Promise<void> => {
    await box(id).fill(value);
    await box(id).press('Enter');
  };

  /**
   * Whether the editor is saying a sentence about
   * the block.
   *
   * Saved first, because PROBLEMS is filled by code
   * generation and generation answers the file
   * rather than the buffer the column edits.
   */
  const said = async (sentence: string, times: number): Promise<void> => {
    await vscode.save();

    await expect(
      (await vscode.problems()).filter({ hasText: sentence }),
    ).toHaveCount(times);
  };

  /** One upload, with as many pages as the queue is
   *  meant to start runs for. */
  const upload = (): string =>
    JSON.stringify(
      {
        documentId: randomUUID(),
        filename: 'twelve-pages.pdf',
        storageKey: `${NAME}/twelve-pages.pdf`,
        pageCount: PAGES,
        requestedBy: 'reader@queue.test',
      },
      null,
      2,
    );

  test.beforeAll(async () => {
    // A scaffold, a full `npm install`, an editor
    // and a mail fixture. None of it is the subject;
    // all of it has to be real.
    test.setTimeout(1_800_000);

    project = await extensionProject({ name: NAME });

    // The app runs in a container while the sink is
    // a process on this machine, so the address the
    // project is given is the daemon's name for the
    // host. The credentials are the scaffold's own:
    // the sink refuses a send whose Basic auth does
    // not match, which is what makes passing them
    // through a check on the minted pair.
    await rewriteEnv(project, {
      TWILIO_EMAIL_BASE_URL: EXTENSION_MAIL_BASE_URL,
    });

    const env = await readEnv(project);

    sink = await startMailsink({
      port: EXTENSION_MAILSINK_PORT,
      apiKey: env['TWILIO_API_KEY'] ?? '',
      apiSecret: env['TWILIO_API_SECRET'] ?? '',
    });

    // The image build copies `package-lock.json`,
    // which only an install writes.
    await installDependencies(project);

    // The compose project name comes from the file
    // the scaffold wrote, so it is the same name on
    // every run. One that died before its teardown
    // would otherwise leave containers and a volume
    // behind for this one to inherit.
    await composeDown(project);

    vscode = await driveVsCode({ project });

    // A pattern writes handlers into the project and
    // generation writes TypeScript beside them.
    // Neither happens in a window nobody trusted.
    await vscode.trustFolder();
  });

  test.afterAll(async () => {
    await vscode?.close();
    await sink?.process.kill();

    if (project !== undefined) {
      // Volumes included. The run history is the
      // point of the database and it belongs to this
      // run of this spec.
      await composeDown(project).catch(() => undefined);
      await discardExtensionProject(project);
    }
  });

  /**
   * The pattern, and the file nothing in the gallery
   * writes.
   *
   * The generated name is what proves the whole
   * chain ran rather than that six blocks were
   * drawn: the block's id, the document's name and
   * the queued grammar meet in it and nowhere else.
   */
  test('the gallery brings the pattern whose work is queued', async () => {
    await vscode.runCommand('mBoss: New Workflow');

    const gallery = await vscode.webview('gallery');

    await gallery.locator(`[data-pattern="${WORKFLOW}"] [data-use]`).click();

    expect(await vscode.acceptInput()).toBe(WORKFLOW);

    canvas = await vscode.webview('canvas');

    await expect(
      canvas.locator(`.react-flow__node[data-id="${BLOCK}"]`),
    ).toBeVisible();

    await expect(async () => {
      expect(await generated()).toContain(QUEUED);
    }).toPass({ timeout: GENERATE_MS });
  });

  /**
   * One page, one run — which the pattern as shipped
   * does not do, on purpose.
   *
   * It keys items on the document, so every page of
   * one upload carries the same key and a page
   * offered while another is in flight joins the run
   * already going. That is a fine thing for a
   * pattern to teach and a poor thing to fan out
   * over: twelve pages become one run, and every
   * count below would be counting enqueues instead.
   * Emptying the key is what the pattern's own
   * handler tells a reader to do to index every page
   * on its own, and it is the only edit this journey
   * makes before it runs anything.
   */
  test('and the queue is told to start a run for every page', async () => {
    await canvas.locator(`.react-flow__node[data-id="${BLOCK}"]`).click();

    await type('deduplicationPath', '');
    await onQueue((config) =>
      expect(config.enqueue?.deduplicationPath).toBeUndefined(),
    );

    // Generation answers the file, so the emitted
    // enqueue loses the key with it.
    await expect(async () => {
      expect(await generated()).not.toContain('deduplicationID');
    }).toPass({ timeout: GENERATE_MS });
  });

  /**
   * The image build is the slow part and it is not
   * skippable: the app that answers the run below
   * has to be the one built from the code generated
   * a moment ago.
   *
   * `--wait` is inside the extension, so a stack
   * that is up here is one whose healthchecks went
   * green — which for the app means it served
   * `/healthz` from inside its own container, having
   * registered the queue on the way up.
   */
  test('Start Local Stack brings the project up', async () => {
    test.setTimeout(1_800_000);

    await vscode.runCommand('mBoss: Open Runs');
    runs = await vscode.webview('runs');

    await runs.locator('[data-stack-toggle]').click();

    for (const service of ['postgres', 'app']) {
      await expect(
        runs.locator(`[data-zone="stack"] [data-service="${service}"]`),
        `${service} should be running`,
      ).toHaveAttribute('data-state', 'running', { timeout: 1_800_000 });
    }
  });

  /**
   * Twelve pages, and the block that holds them.
   *
   * The counts line is the reason the canvas is left
   * on screen while the panel starts the run: it is
   * drawn only while something is still to finish,
   * and it is the one thing about a queue block that
   * a person sees without opening anything. Twelve
   * items behind a queue that lets two through at a
   * time is seconds of counting, which is the only
   * reason it can be caught at all.
   *
   * `done` is read off `dbos.workflow_status` through
   * the panel's own watch, so it covers the whole
   * length of it — the ingress accepted the event,
   * the parent ran, the queue dispatched every item,
   * each child recorded its own row, and the parent
   * gathered the results and finished.
   */
  test('runs the workflow, and the block counts its children', async () => {
    test.setTimeout(1_800_000);

    const picker = runs.locator('[data-workflow-picker]');

    await expect(picker.locator(`option[value="${WORKFLOW}"]`)).toHaveCount(1);
    await picker.selectOption(WORKFLOW);

    await runs.locator('[data-input]').fill(upload());
    await runs.locator('[data-run-workflow]').click();

    const line = canvas.locator(
      `.react-flow__node[data-id="${BLOCK}"] .node-line`,
    );

    await expect(line).toHaveAttribute('data-line', 'counts', {
      timeout: 600_000,
    });

    const live = runs.locator('[data-zone="running-now"]');

    await expect(live.locator('.run-line')).toHaveAttribute(
      'data-outcome',
      'done',
      { timeout: 900_000 },
    );

    runId = (await live.locator('.run-id').innerText()).trim();
    expect(runId, 'the panel drew a run with no id').not.toBe('');

    // Nothing left to finish, so the block goes back
    // to saying what it runs.
    await expect(line).not.toHaveAttribute('data-line');
  });

  /**
   * The list is the run somebody started, never the
   * twelve it started in turn.
   *
   * A queue block's children are runs of their own
   * in the same table, so a fence is the only thing
   * between a list of runs and a list of items. The
   * filter's count is where that shows: the rows are
   * drawn minus whatever the session zone already
   * showed, so this run is not among them, while the
   * count is over the whole ledger — a fence that
   * had failed would read thirteen.
   *
   * A filter is pressed first, and that is the read
   * as well as the gesture. The list goes to the
   * database when it is shown and when a filter is
   * chosen, never on a timer, so what it is holding
   * was read before this run existed.
   */
  test('and the list carries the run, not its twelve children', async () => {
    await runs.locator('[data-filter="all"]').click();

    await expect(runs.locator('[data-filter="all"] .count')).toHaveText('1');

    // Nowhere on the panel — not the list, not the
    // session zone, not the run being followed.
    await expect(runs.locator('.run-name', { hasText: QUEUED })).toHaveCount(0);
  });

  /**
   * What the block has to show for itself, which is
   * not rows.
   *
   * Three provenances on one card, and the chips are
   * the assertion as much as the figures are: the
   * counts and the window are this panel's arithmetic
   * over somebody's ledger, the limits are what the
   * document asks for, and a card that mixed them
   * would be reporting a ceiling somebody typed as
   * though a run had reached it.
   *
   * The starts are asserted as a shape rather than
   * as twelve. What the row says is how many items
   * the whole queue started inside its window, and
   * the window is a minute — so the number is only
   * twelve while this test is quick, which is not
   * something to hold a suite to. That it is a
   * count and not a fraction is the claim: the row
   * above it is a fraction, and DBOS records what
   * ran and never what it was allowed to run.
   */
  test('Run Evidence reads the queue rather than the block', async () => {
    canvas = await vscode.webview('canvas');

    await canvas.locator(`.react-flow__node[data-id="${BLOCK}"]`).click();
    await canvas.locator('[data-inspector-tab="evidence"]').click();

    const card = canvas.locator('[data-evidence="queue"]');
    const reading = (field: string) =>
      card.locator(`[data-evidence-field="${field}"]`);

    await expect(card).toBeVisible();

    await expect(reading('queue').locator('.value')).toHaveText(QUEUE);
    await expect(
      reading('queue').locator('[data-provenance="configured"]'),
    ).toBeVisible();

    for (const counted of ['active', 'queued']) {
      await expect(
        reading(counted).locator('[data-provenance="derived"]'),
        `${counted} should say the panel worked it out`,
      ).toBeVisible();
    }

    await expect(reading('active').locator('.value')).toHaveText(
      /^\d+ of 8 queue-wide$/,
    );
    await expect(reading('rateLimit').locator('.value')).toHaveText(
      '100 per 60 s',
    );

    await expect(reading('observedStarts').locator('.value')).toHaveText(
      /^\d+ in the last \d+ s$/,
    );
    await expect(
      reading('observedStarts').locator('[data-provenance="derived"]'),
    ).toBeVisible();

    await expect(reading('registered').locator('.value')).toHaveText(
      'matches the document',
    );

    await expect(
      reading('recentWork').locator('[data-queue-item]'),
    ).toHaveCount(PAGES);

    await expect(reading('local')).toBeVisible();
  });

  /**
   * The way from an item to the run it became.
   *
   * The id is the whole of what the parent recorded
   * about an item, so the id is the way there. The
   * child's own page is where the work is, under a
   * workflow named for the block and the document
   * together.
   *
   * And it is where the trace runs out of names. A
   * page attributes its rows against the document
   * the run is a run of, and this run's workflow is
   * not a document — it is what the block registered
   * its children under — so the one turn it took is
   * drawn as belonging to no block. The row is the
   * work either way; nothing here maps it back onto
   * the block a hand's width away on the canvas.
   */
  test('and a recent-work row opens the run that item started', async () => {
    const items = canvas.locator(
      '[data-evidence-field="recentWork"] [data-queue-item]',
    );

    // One of the twelve, read off the card that
    // lists them.
    const itemId = (await items.first().getAttribute('data-queue-item')) ?? '';

    expect(itemId, 'the card listed an item with no id').not.toBe('');
    expect(itemId, 'an item is a run of its own').not.toBe(runId);

    await items.first().click();

    see = await vscode.webview('see');

    await expect(see.locator(`.see[data-run="${itemId}"]`)).toBeVisible();
    await expect(see.locator('.crumb')).toContainText(QUEUED);

    await see.locator('[data-see-tab="trace"]').click();

    const group = see.locator('[data-trace-group]');

    await expect(group).toHaveCount(1);
    await expect(group).toHaveAttribute('data-trace-group', '');
    await expect(group.locator('[data-unattributed]')).toBeVisible();

    // One turn, which is the handler the block runs
    // for one item.
    await expect(group.locator('.trace-op')).toHaveCount(1);
  });

  /**
   * And the way back, on the parent's own page.
   *
   * Twelve starts under the block that made them,
   * each carrying the run it started; and twelve
   * waits beside them that DBOS owns rather than any
   * block, which is what the raw toggle is for. A
   * trace that showed both by default would be
   * twenty-four rows for a block a person drew once.
   */
  test("the parent's trace gathers the starts under the block", async () => {
    // Asked for again rather than kept: a webview is
    // found among the editor's overlay frames by
    // where it sits among them, and opening the run
    // page a moment ago moved what sits where.
    runs = await vscode.webview('runs');

    await runs.locator(`[data-session-row="${runId}"] [data-open-run]`).click();

    see = await vscode.webview('see');

    await expect(see.locator(`.see[data-run="${runId}"]`)).toBeVisible();

    await see.locator('[data-see-tab="trace"]').click();

    const group = see.locator(`[data-trace-group="${BLOCK}"]`);

    await group.locator('.trace-head').click();

    await expect(group.locator('[data-run-select]')).toHaveCount(PAGES);
    await expect(group.locator('.trace-op[data-owner="sdk"]')).toHaveCount(0);

    // Clicked rather than checked: the box is drawn
    // from what the extension holds, so it comes
    // back ticked a message later and a helper that
    // reads the state straight after the click sees
    // the old one. The rows below are the wait.
    await see.locator('[data-raw-toggle]').click();

    await expect(group.locator('.trace-op[data-owner="sdk"]')).toHaveCount(
      PAGES,
    );
  });

  /**
   * The finding that stops the code, on a document
   * that already has an app running it.
   *
   * A partitioned queue with nothing saying which
   * partition an item belongs to is the one DBOS
   * takes quietly: it accepts the enqueue and never
   * dispatches it. So the editor refuses to generate
   * rather than letting a run park for ever, and
   * what is on disk is what the running stack is
   * still built from.
   */
  test('and partitioning with no key stops the code', async () => {
    // The document has been open in a tab since the
    // pattern landed, with the run page beside it.
    // Clicked rather than opened again, so that this
    // is the same editor the journey has been
    // editing rather than a second one.
    await vscode.editorTab(`${WORKFLOW}.workflow.json`).click();

    canvas = await vscode.webview('canvas');

    await canvas.locator(`.react-flow__node[data-id="${BLOCK}"]`).click();
    await canvas.locator('[data-inspector-tab="configure"]').click();

    const before = await generated();

    await canvas
      .locator('[data-field="partitioning"] select')
      .selectOption('on');
    await onQueue((config) =>
      expect(config.queue?.partitionConcurrency).toBeDefined(),
    );

    await said(NO_PARTITION_KEY, 1);

    expect(await generated(), 'the refusal still wrote code').toBe(before);
  });
});

import {
  access,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type FrameLocator } from '@playwright/test';

import {
  SCENARIOS_DIR,
  loadScenario,
} from '../../fixtures/fake-acp-agent/index.js';
import { promptsSent, transcriptLines } from '../../helpers/transcript.js';
import {
  discardExtensionProject,
  driveVsCode,
  extensionProject,
  type DrivenVsCode,
} from '../../helpers/vscode.js';

/**
 * The loop this product is: a person asks, an agent
 * proposes, mBoss validates and draws it, the
 * person approves, and the agent is sent on to the
 * code behind.
 *
 * Everything here is driven through the surfaces a
 * person uses — the palette, the composer in the
 * agent panel, the button on the proposal card —
 * against the packaged extension, with a coding
 * agent registered the way any other custom one
 * would be. Nothing in the extension knows this
 * agent is a fixture.
 *
 * The tests run in order and share one window: the
 * third one approves, and everything after it is
 * about what that did. That is this suite's shape
 * anyway — one worker, no retries — and splitting
 * the approval across files would mean paying for
 * a second editor to reach the same state.
 */
test.describe('preview and approve', () => {
  /**
   * The proposal covers a workflow that has no code
   * behind it yet. Sixteen blocks and eighteen
   * wires, all arriving at once — which is what the
   * banner counts.
   */
  const NODES = 16;

  let project: string;
  let scratch: string;
  let transcript: string;
  let vscode: DrivenVsCode;
  let sidebar: FrameLocator;
  let canvas: FrameLocator;

  test.beforeAll(async () => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'mboss-tr-')));
    transcript = join(scratch, 'agent.ndjson');

    project = await extensionProject({
      name: 'sermon_helper',
      overlay: 'sermon-helper',
      fakeAgent: true,
    });

    vscode = await driveVsCode({ project, agentTranscript: transcript });

    // Generating code and running an agent both act
    // on the folder's own contents, which is the
    // decision workspace trust exists to make. The
    // window starts restricted, as any window on a
    // folder nobody has vouched for does.
    await vscode.trustFolder();

    await vscode.openFile('sermon_helper.workflow.json');
    canvas = await vscode.webview('canvas');

    await vscode.runCommand('mBoss: Open Agent Sidebar');
    sidebar = await vscode.webview('sidebar');

    const scenario = await loadScenario(
      join(SCENARIOS_DIR, 'sermon-helper-asking.scenario.json'),
    );

    const composer = sidebar.locator('.composer textarea');
    await composer.fill(scenario.prompt);
    await composer.press('Enter');

    await sidebar.locator('[data-preview-card]').waitFor();

    // The card arrives mid-turn: the proposal is
    // written by a tool call, and the panel sees the
    // file the moment it lands. Nothing here waits
    // for the agent to finish talking first —
    // pressing Approve while it is still working is
    // what a person does, and the prompt an approval
    // sends has to survive it.
    //
    // Which means the turn has to still be running
    // when this spec presses, as a fact rather than
    // as a race it usually wins: this scenario's
    // agent ends by asking a question of its own and
    // holds the turn open until it is answered.
    await expect(sidebar.locator('.permission')).toBeVisible();
  });

  test.afterAll(async () => {
    await vscode?.close();
    await discardExtensionProject(project);
    await rm(scratch, { recursive: true, force: true });
  });

  /**
   * A conversation drawn as a work log: what the
   * agent said is prose, what it did is a card. The
   * trace matters more than the prose — it is how a
   * person sees that the graph went through the
   * control plane rather than being invented.
   */
  test('the panel traces the agent through the control plane', async () => {
    const said = sidebar.locator('.transcript .said');

    await expect(said.filter({ hasText: 'skill: mboss' })).toBeVisible();
    await expect(
      said.filter({ hasText: 'mboss://node-catalog' }),
    ).toBeVisible();
    await expect(
      said.filter({ hasText: 'mboss://workflow-schema' }),
    ).toBeVisible();

    // The one the agent made, told apart from the
    // question it is still waiting on — which the
    // panel also draws as a card.
    const call = sidebar
      .locator('[data-tool-call]')
      .filter({ hasText: 'workflow.apply_spec' });

    await expect(call).toHaveAttribute('data-status', 'completed');

    // A row is what was done and what it was done
    // to, and the panel sets the second half apart:
    // the tool's name is the verb, and the argument
    // that made it a rehearsal rather than a write
    // is the thing it acted on.
    await expect(call.locator('.tool-verb')).toHaveText('workflow.apply_spec');
    await expect(call.locator('.tool-target')).toHaveText('dryRun');
  });

  /**
   * The graph on screen is the proposal's, not the
   * document's, and the banner over it is what says
   * so.
   *
   * Its counts are the diff the control plane
   * returned, and the sentence after them is the
   * claim the product is built on: the agent sent
   * semantics, so the layout is mBoss's and the same
   * graph is drawn the same way for everyone.
   */
  test('the canvas draws the proposal over the graph', async () => {
    await expect(canvas.locator('[data-preview-headline]')).toHaveText(
      'PREVIEW — proposed by fake-acp-agent · not applied yet',
    );

    await expect(canvas.locator('[data-preview-banner]')).toHaveText(
      'PREVIEW CHANGES · +16 nodes +18 edges · ' +
        'deterministic layout — the agent sent semantics, ' +
        'never coordinates',
    );

    // Drawn in pencil: every block is arriving, so
    // every block is dashed. Arriving is one of the
    // states a block can be drawn in rather than a
    // flag beside them, which is what makes it lose
    // to selection and win over a run's colours.
    await expect(canvas.locator('[data-state="proposed"]')).toHaveCount(NODES);
  });

  /**
   * A stale proposal offers only `Refine`, so a card
   * offering `Approve & apply` is also the assertion
   * that the graph has not moved under it.
   */
  test('the card offers the decision, and taking it applies', async () => {
    const card = sidebar.locator('[data-preview-card]');

    // Still mid-turn, which is the point: the agent
    // is waiting on its own question and this is
    // answering a different one.
    await expect(sidebar.locator('.permission')).toBeVisible();

    await expect(card).toHaveAttribute('data-at', 'proposed');
    await expect(card.locator('[data-approve]')).toHaveText('Approve & apply');

    await card.locator('[data-approve]').click();

    await expect(card).toHaveAttribute('data-at', 'applied');

    // And it is written into the log the agent's own
    // work is written into, marked as the person's.
    // The transcript is the record of what happened
    // to this project, and an approval is the one
    // thing in it that nobody was asked to do — so
    // an approval missing from it reads as the agent
    // having applied its own proposal.
    const applied = sidebar.locator('[data-tool-call][data-by="person"]');

    await expect(applied).toHaveAttribute('data-status', 'applied');
    await expect(applied.locator('.tool-verb')).toHaveText('Apply proposal');

    // Now let the agent's own question be answered,
    // which is what ends the turn the approval
    // landed in the middle of.
    await sidebar.locator('.permission [data-option="once"]').click();
  });

  /**
   * Approving is the only way proposed content
   * reaches disk, and it lands as a new revision of
   * the document VS Code owns.
   */
  test('the document is written at the next revision', async () => {
    const ir = JSON.parse(
      await readFile(
        join(project, '.mboss', 'workflows', 'sermon_helper.workflow.json'),
        'utf8',
      ),
    ) as { revision: number; nodes: unknown[]; edges: unknown[] };

    expect(ir.revision).toBe(2);
    expect(ir.nodes).toHaveLength(NODES);
    expect(ir.edges).toHaveLength(18);
  });

  /** The proposal file is core's record of the
   *  answer, and it keeps it. */
  test('the proposal is marked applied', async () => {
    const dir = join(project, '.mboss', 'proposals');
    const [file] = (await readdir(dir)).filter((name) =>
      name.endsWith('.proposal.json'),
    );

    expect(file).toBeDefined();

    const proposal = JSON.parse(
      await readFile(join(dir, file as string), 'utf8'),
    ) as { status: string; proposedBy: string };

    expect(proposal.status).toBe('applied');
    expect(proposal.proposedBy).toBe('fake-acp-agent');
  });

  /**
   * An approval regenerates the project the same way
   * saving the file does, and the status bar is the
   * only feedback there is — the code would land in
   * files nobody has open.
   *
   * What it reports here is that the approved graph
   * produced no code, and that is the right answer
   * rather than a disappointing one: a block whose
   * handler the code-behind does not export yet has
   * no function to call, so the graph is a design
   * and not yet a program. Which is exactly what the
   * prompt the next test is about asks the agent to
   * fix.
   */
  test('code generation runs, and says why it made nothing', async () => {
    const codegen = vscode.page
      .locator('.statusbar-item')
      .filter({ hasText: 'codegen' });

    await expect(codegen).toHaveText(/codegen ✗ \d+ ms/);
    await expect(codegen).toHaveAttribute(
      'aria-label',
      /Some workflows produced no code/,
    );

    // One per handler the approved graph now names
    // and the code-behind does not export. The empty
    // draft this started from named none, so the
    // count moving is itself the assertion that
    // generation ran over the new document.
    await expect(async () => {
      const label = await vscode.page
        .locator('#status\\.problems')
        .getAttribute('aria-label');

      expect(
        Number(/Warnings: (\d+)/.exec(label ?? '')?.[1] ?? 0),
      ).toBeGreaterThan(1);
    }).toPass();
  });

  /**
   * The last thing the extension says, and the only
   * thing it says on its own initiative.
   *
   * A substring rather than the sentence: the whole
   * of it leads with an em dash, and the canonical
   * copy is `APPROVAL_PROMPT` in `mboss-vscode`'s
   * `src/preview/approve.ts`, which this repository
   * may not import. Two copies kept in step by
   * somebody reading them are better served by an
   * assertion a terminal or a paste cannot break.
   */
  test('the agent is told the proposal was applied', async () => {
    await expect(async () => {
      const prompts = promptsSent(await transcriptLines(transcript));

      expect(prompts).toHaveLength(2);
      expect(prompts.at(-1)).toContain('Scaffold the handlers.');
    }).toPass();
  });

  /**
   * And the loop closes: the agent answers that
   * prompt by scaffolding the code behind, through
   * the same vendored server it wrote the proposal
   * with, into the project the editor has open.
   */
  test('the agent scaffolds the code behind it was sent for', async () => {
    await expect(async () => {
      for (const handler of ['extractText.ts', 'chunkText.ts']) {
        await expect(
          access(join(project, 'lib', handler)),
          `lib/${handler} should have been scaffolded`,
        ).resolves.toBeUndefined();
      }
    }).toPass();

    const scaffolded = await readFile(
      join(project, 'lib', 'extractText.ts'),
      'utf8',
    );

    // Typed from the block that asked for it, which
    // is what the scan of `lib/types.ts` was for.
    expect(scaffolded).toContain(
      'export async function extractText(input: UploadedDocs)',
    );
  });
});

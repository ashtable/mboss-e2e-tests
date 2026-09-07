import { access, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type FrameLocator } from '@playwright/test';

import { composeDown, installDependencies } from '../../helpers/app.js';
import {
  promptBlocksSent,
  promptsSent,
  transcriptLines,
} from '../../helpers/transcript.js';
import {
  discardExtensionProject,
  driveVsCode,
  extensionProject,
  type DrivenVsCode,
} from '../../helpers/vscode.js';

/**
 * A failed run, handed to an agent.
 *
 * The button is one click, and what leaves the
 * window on that click is three things that have to
 * agree: a row in the transcript saying mBoss read
 * the run, a sentence a person could have typed, and
 * a machine-readable copy of everything the ledger
 * had about it. The first is what somebody sees; the
 * last is what the agent actually reasons over; and
 * an editor that drew the row without sending the
 * record would look identical and be useless.
 *
 * So the row is read off the panel and the blocks
 * are read off the wire. The agent standing in here
 * has no scenario for this sentence and says so,
 * which is fine and deliberate: it writes down every
 * prompt before it decides whether it can answer
 * one, and what it was handed is the whole question.
 *
 * The second case is the same click against an agent
 * that says it cannot take a record beside the
 * words. Nothing may be dropped — a JSON object in
 * prose with nothing marking its edges is a
 * paragraph the agent has to guess the shape of — so
 * the record is fenced under its own name inside the
 * one block that agent can read. Each window writes
 * its own transcript so neither case can read the
 * other's lines.
 */
test.describe('a failed run, handed to an agent', () => {
  const NAME = 'ask-agent';
  const WORKFLOW = 'failing_step';
  const BLOCK_TITLE = 'Settle it';
  const REFUSAL = 'the ledger refused this claim';

  let project: string;
  let scratch: string;
  let vscode: DrivenVsCode;
  let runs: FrameLocator;
  let sidebar: FrameLocator;

  test.beforeAll(async () => {
    test.setTimeout(900_000);

    scratch = await realpath(await mkdtemp(join(tmpdir(), 'mboss-ask-')));

    project = await extensionProject({
      name: NAME,
      overlay: 'failing-step',
      fakeAgent: true,
    });

    await installDependencies(project);
    await composeDown(project);

    vscode = await driveVsCode({
      project,
      agentTranscript: join(scratch, 'embedded.ndjson'),
    });
    await vscode.trustFolder();

    await vscode.runCommand('mBoss: Generate Code');

    await expect(async () => {
      await access(
        join(project, 'src', 'workflows', `${WORKFLOW}.workflow.ts`),
      );
    }).toPass({ timeout: 60_000 });

    await vscode.runCommand('mBoss: Open Runs');
    runs = await vscode.webview('runs');
  });

  test.afterAll(async () => {
    await vscode?.close();

    if (project !== undefined) {
      await composeDown(project).catch(() => undefined);
      await discardExtensionProject(project);
    }

    if (scratch !== undefined) {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('Start Local Stack brings the project up', async () => {
    test.setTimeout(900_000);

    await runs.locator('[data-stack-toggle]').click();

    for (const service of ['postgres', 'app']) {
      await expect(
        runs.locator(`[data-zone="stack"] [data-service="${service}"]`),
        `${service} should be running`,
      ).toHaveAttribute('data-state', 'running', { timeout: 900_000 });
    }
  });

  /**
   * Everything the click sends, against an agent
   * that takes a record beside the words.
   *
   * The transcript row is asserted by its mark and
   * its status rather than by its words alone: what
   * makes it different from a row the agent wrote is
   * that mBoss did the reading rather than asking
   * for permission to, and `applied` is how that is
   * said.
   */
  test('Ask agent why sends the run, read and attached', async () => {
    test.setTimeout(600_000);

    const transcript = join(scratch, 'embedded.ndjson');
    const runId = await failARun(runs);

    await vscode.runCommand('mBoss: Open Agent Sidebar');
    sidebar = await vscode.webview('sidebar');

    await runs
      .locator(`[data-session-row="${runId}"] [data-ask-agent]`)
      .click();

    const row = sidebar.locator(`[data-tool-call="evidence:${runId}"]`);

    await expect(row).toHaveAttribute('data-kind', 'read');
    await expect(row).toHaveAttribute('data-status', 'applied');
    await expect(row.locator('.tool-verb')).toHaveText('Read');
    await expect(row.locator('.tool-target')).toHaveText(
      `run ${runId} · mBoss run evidence`,
    );
    await expect(row.locator('[data-tool-action="openRun"]')).toHaveText(
      'Open run',
    );

    await expect(async () => {
      const lines = await transcriptLines(transcript);
      const sent = promptsSent(lines);

      expect(sent).toHaveLength(1);

      const said = sent[0] ?? '';

      expect(said).toContain(
        `Run \`${runId}\` of \`${WORKFLOW}\` failed at ${BLOCK_TITLE}`,
      );
      expect(said).toContain(REFUSAL);
      expect(said).toContain('ƒ settleIt');
      expect(said).toContain('settleIt.ts');
      expect(said).toContain(
        'The attached mBoss run evidence was assembled by the editor from ' +
          'the local DBOS ledger',
      );

      const [blocks = []] = promptBlocksSent(lines);

      expect(blocks.map(typeOf)).toEqual(['text', 'resource']);

      const attached = resourceOf(blocks[1]);

      expect(attached.mimeType).toBe('application/json');
      expect(attached.uri.startsWith('mboss://run-evidence/')).toBe(true);
      expect(JSON.parse(attached.text)).toMatchObject({ workflowId: runId });
    }).toPass({ timeout: 120_000 });
  });

  /**
   * The same click, to an agent that takes only
   * words.
   *
   * A second window on the same project, because
   * what the agent will accept is settled at the
   * handshake and the handshake is the window's. The
   * session log is this window's own memory and
   * arrives empty, so the run is made again — which
   * costs seconds, the stack being already up.
   *
   * Nothing is trusted here, because the folder
   * already is: the decision belongs to the path and
   * outlives the profile that made it, so a window
   * opened where the one before it said yes never
   * asks again. A window that did arrive restricted
   * would fail at the picker below, which a
   * restricted panel does not draw.
   */
  test('an agent that takes only words gets the record fenced', async () => {
    test.setTimeout(600_000);

    const transcript = join(scratch, 'fenced.ndjson');

    await vscode.close();

    vscode = await driveVsCode({
      project,
      agentTranscript: transcript,
      agentEmbeddedContext: false,
    });

    await vscode.runCommand('mBoss: Open Runs');
    runs = await vscode.webview('runs');

    const runId = await failARun(runs);

    await vscode.runCommand('mBoss: Open Agent Sidebar');
    sidebar = await vscode.webview('sidebar');

    await runs
      .locator(`[data-session-row="${runId}"] [data-ask-agent]`)
      .click();

    await expect(
      sidebar.locator(`[data-tool-call="evidence:${runId}"]`),
    ).toHaveAttribute('data-status', 'applied');

    await expect(async () => {
      const [blocks = []] = promptBlocksSent(await transcriptLines(transcript));

      expect(blocks.map(typeOf)).toEqual(['text']);

      const only = textOf(blocks[0]);

      expect(only).toContain(`Run \`${runId}\` of \`${WORKFLOW}\``);
      expect(only).toContain(`run ${runId} · mBoss run evidence`);
      expect(only).toContain('```json');
      expect(only).toContain(`"workflowId": "${runId}"`);
    }).toPass({ timeout: 120_000 });
  });
});

/**
 * One run of the fixture, given the input it exists
 * to refuse, followed until the panel says it
 * failed.
 *
 * Both cases need exactly this and neither is about
 * it, which is why it is a function here rather than
 * a test they share: the second window has no memory
 * of the first one's run and has to make its own.
 */
async function failARun(runs: FrameLocator): Promise<string> {
  const picker = runs.locator('[data-workflow-picker]');

  await expect(picker.locator('option[value="failing_step"]')).toHaveCount(1);
  await picker.selectOption('failing_step');

  await runs.locator('[data-input]').fill('{ "fail": true }');
  await runs.locator('[data-run-workflow]').click();

  const live = runs.locator('[data-zone="running-now"]');

  await expect(live.locator('.run-line')).toHaveAttribute(
    'data-outcome',
    'failed',
    { timeout: 300_000 },
  );

  const runId = (await live.locator('.run-id').innerText()).trim();

  expect(runId, 'the panel drew a run with no id').not.toBe('');

  return runId;
}

/** What kind of content block this is, without
 *  trusting the transcript to hold one. */
function typeOf(block: unknown): unknown {
  return block !== null && typeof block === 'object' && 'type' in block
    ? (block as { type: unknown }).type
    : undefined;
}

/** The words of a text block. */
function textOf(block: unknown): string {
  return block !== null && typeof block === 'object' && 'text' in block
    ? String((block as { text: unknown }).text)
    : '';
}

/** The record a resource block carries. */
function resourceOf(block: unknown): {
  uri: string;
  mimeType: string;
  text: string;
} {
  const found =
    block !== null && typeof block === 'object' && 'resource' in block
      ? (block as { resource: unknown }).resource
      : undefined;

  const fields = (found ?? {}) as {
    uri?: unknown;
    mimeType?: unknown;
    text?: unknown;
  };

  return {
    uri: String(fields.uri ?? ''),
    mimeType: String(fields.mimeType ?? ''),
    text: String(fields.text ?? ''),
  };
}

import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type FrameLocator } from '@playwright/test';

import {
  SCENARIOS_DIR,
  loadScenario,
} from '../../fixtures/fake-acp-agent/index.js';
import {
  discardExtensionProject,
  driveVsCode,
  extensionProject,
  type DrivenVsCode,
} from '../../helpers/vscode.js';

/**
 * The other answer to a proposal: not yet.
 *
 * `Refine` is the one control in this extension
 * that deliberately does nothing to anything. It
 * puts the cursor back in the composer and stops —
 * no write, no message to the host, no change to
 * the proposal — because "let me type instead" is
 * not a fact the extension needs to remember, and
 * an extension that remembered it would have a
 * second idea of which proposal is live beside the
 * one on disk.
 *
 * What replaces a proposal is a newer proposal, and
 * the discarding is the control plane's: core
 * supersedes the older one when it writes the next.
 */
test.describe('preview and refine', () => {
  let project: string;
  let proposals: string;
  let scratch: string;
  let vscode: DrivenVsCode;
  let sidebar: FrameLocator;
  let prompt: string;

  /** Every proposal on disk, by id, with the status
   *  it is carrying now. */
  const statuses = async (): Promise<Record<string, string>> => {
    const files = (await readdir(proposals)).filter((name) =>
      name.endsWith('.proposal.json'),
    );
    const found: Record<string, string> = {};

    for (const file of files) {
      const proposal = JSON.parse(
        await readFile(join(proposals, file), 'utf8'),
      ) as { id: string; status: string };

      found[proposal.id] = proposal.status;
    }

    return found;
  };

  /** Sends the prompt and waits for the turn it
   *  starts to finish. */
  const ask = async (): Promise<void> => {
    const composer = sidebar.locator('.composer textarea');

    await composer.fill(prompt);
    await composer.press('Enter');

    await sidebar.locator('[data-preview-card]').waitFor();
    await expect(sidebar.locator('[data-stop]')).toHaveCount(0);
  };

  test.beforeAll(async () => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'mboss-tr-')));

    project = await extensionProject({
      name: 'sermon_helper',
      overlay: 'sermon-helper',
      fakeAgent: true,
    });
    proposals = join(project, '.mboss', 'proposals');

    vscode = await driveVsCode({
      project,
      agentTranscript: join(scratch, 'agent.ndjson'),
    });

    await vscode.trustFolder();
    await vscode.runCommand('mBoss: Open Agent Sidebar');
    sidebar = await vscode.webview('sidebar');

    prompt = (
      await loadScenario(join(SCENARIOS_DIR, 'sermon-helper.scenario.json'))
    ).prompt;

    await ask();
  });

  test.afterAll(async () => {
    await vscode?.close();
    await discardExtensionProject(project);
    await rm(scratch, { recursive: true, force: true });
  });

  test('refining leaves the proposal exactly as it was', async () => {
    const before = await statuses();
    expect(Object.values(before)).toEqual(['proposed']);

    await sidebar.locator('[data-refine]').click();

    // Where the cursor goes is the whole of what
    // this button does, and the webview is the only
    // place that can say so.
    await expect(sidebar.locator('.composer textarea')).toBeFocused();

    expect(await statuses()).toEqual(before);
    await expect(sidebar.locator('[data-preview-card]')).toHaveAttribute(
      'data-at',
      'proposed',
    );
  });

  /**
   * Asking again is what actually replaces a
   * proposal, and the older one goes because core
   * discards it — not because the panel stopped
   * drawing it.
   *
   * The card is still one card offering the
   * decision afterwards. Two outstanding proposals
   * for one workflow would be two answers a person
   * could give to the same question, which is the
   * thing superseding exists to prevent.
   */
  test('asking again supersedes the outstanding proposal', async () => {
    const [older] = Object.keys(await statuses());
    expect(older).toBeDefined();

    await ask();

    await expect(async () => {
      const now = await statuses();

      expect(Object.keys(now)).toHaveLength(2);
      expect(now[older as string]).toBe('discarded');
      expect(Object.values(now).filter((at) => at === 'proposed')).toHaveLength(
        1,
      );
    }).toPass();

    await expect(sidebar.locator('[data-preview-card]')).toHaveCount(1);
    await expect(sidebar.locator('[data-preview-card]')).toHaveAttribute(
      'data-at',
      'proposed',
    );
    await expect(sidebar.locator('[data-approve]')).toBeVisible();
  });
});

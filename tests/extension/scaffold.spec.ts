import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { connectToBundle } from '../../helpers/mcp.js';
import { driveVsCode, type DrivenVsCode } from '../../helpers/vscode.js';

/**
 * `mBoss: New Project`, from the palette a person
 * types into, in a window with the packaged
 * extension installed and nothing else.
 *
 * Two of this phase's honest gaps close here. That
 * the package installs and activates was until now
 * asserted by reading the manifest; that the
 * command is in the palette at all was asserted by
 * reading `package.nls.json`. Both are now driven.
 *
 * The command starts from an empty window on
 * purpose. That is the first-run case it was
 * written for — no folder open, so it asks for a
 * parent directory rather than reading one — and it
 * is the only case where the new project opens in
 * the window that made it.
 */
test.describe('mBoss: New Project', () => {
  const NAME = 'sermon_scaffold';

  let parent: string;
  let project: string;
  let vscode: DrivenVsCode;

  test.beforeAll(async () => {
    // Through `realpath` because the system temp
    // directory is a symlink on macOS, and the
    // editor reports back the resolved path.
    parent = await realpath(await mkdtemp(join(tmpdir(), 'mboss-new-')));
    project = join(parent, NAME);

    vscode = await driveVsCode({});

    await vscode.runCommand('mBoss: New Project');
    await vscode.answerFolderPick(parent);
    await vscode.answerInput(NAME);
  });

  test.afterAll(async () => {
    await vscode?.close();
    await rm(parent, { recursive: true, force: true });
  });

  /** Everything `mBoss: New Project` leaves behind. */
  const WRITTEN = [
    // What a coding agent reads to find the server,
    // and the server itself.
    '.mcp.json',
    '.mboss/mcp/server.js',
    '.mboss/mcp/VERSION',
    // The skill, in both the places an agent looks
    // for one.
    '.mboss/skills/mboss/SKILL.md',
    '.mboss/skills/mboss/references/tools.md',
    '.claude/skills/mboss/SKILL.md',
    '.claude/skills/mboss/references/tools.md',
    // And the two directories a workflow's code lives
    // in either side of generation.
    'lib',
    'src/app/main.ts',
    'src/workflows/index.ts',
  ];

  /**
   * One test writes the project and the rest read
   * it, so the wait for the command to finish is
   * here rather than in `beforeAll` — a hook that
   * timed out would report as every test in the
   * file failing for no stated reason.
   *
   * The wait covers the whole list, not the first
   * file on it. The command writes the project and
   * then vendors the skill into it, so the bundle
   * landing says the command started rather than
   * that it finished — a machine slow enough to be
   * caught between the two halves would otherwise
   * read a project that is still being written.
   */
  test('writes a project with the control plane inside it', async () => {
    await expect(async () => {
      for (const path of WRITTEN) {
        await expect(
          access(join(project, ...path.split('/'))),
          `${path} should exist in a new project`,
        ).resolves.toBeUndefined();
      }
    }).toPass();
  });

  /**
   * The bundle is the point of vendoring it, so it
   * is asked to be an MCP server rather than
   * asserted to be a large file.
   *
   * Driven from inside the project, the way an
   * agent starts it — the server resolves which
   * project it serves by walking up from its own
   * working directory, so a copy that only works
   * next to its own repository fails here.
   */
  test('the vendored bundle answers as an MCP server', async () => {
    const session = await connectToBundle(
      project,
      'the extension suite',
      join(project, '.mboss', 'mcp', 'server.js'),
    );

    try {
      const { tools } = await session.client.listTools();

      expect(tools.map((tool) => tool.name)).toContain('workflow_apply_spec');
    } finally {
      await session.close();
    }
  });

  /**
   * The variable is Claude Code's own substitution,
   * applied when it reads this file. It is left
   * unexpanded here on purpose, and the extension
   * expands it before handing the same server to an
   * agent over ACP — so a `.mcp.json` carrying an
   * absolute path would mean the two spellings had
   * drifted.
   */
  test('the agent config names the server it vendored', async () => {
    const config = JSON.parse(
      await readFile(join(project, '.mcp.json'), 'utf8'),
    ) as { mcpServers: Record<string, { command: string; args: string[] }> };

    expect(config.mcpServers.mboss?.command).toBe('node');
    expect(config.mcpServers.mboss?.args.join(' ')).toContain(
      '.mboss/mcp/server.js',
    );
  });
});

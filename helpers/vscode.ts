import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { _electron } from '@playwright/test';
import type { FrameLocator, Page } from '@playwright/test';
import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
} from '@vscode/test-electron';

import {
  EXTENSION_APP_PORT,
  EXTENSION_COMPOSE_OVERRIDE,
  EXTENSION_DATABASE_URL,
  rewriteEnv,
  scaffoldApp,
} from './app.js';

/**
 * Driving the packaged extension inside a real VS
 * Code.
 *
 * Every fact about Electron, the workbench's DOM
 * and the webview iframe chain lives in this file
 * and nowhere else. A spec says "open the canvas",
 * "the sidebar frame", "trust the folder"; it never
 * spells a launch flag, a Monaco class name or an
 * `iframe`.
 *
 * The artifact under test is the `.vsix` — not the
 * source tree, and not an extension development
 * host. It is installed into a throwaway profile
 * and the editor is started on it, which is the
 * only arrangement that can catch an asset the
 * package left out or a bundle that only resolves
 * next to its own repository.
 *
 * Nothing here imports `mboss-vscode`'s TypeScript.
 * The nested checkout is a build context, the same
 * as the four service repos.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** The checkout this suite packages and drives. */
const EXTENSION_REPO = join(HERE, '..', 'mboss-vscode');

/**
 * The extension's own build output, which is what
 * the `.vsix` was zipped from.
 *
 * A project needs the same control plane vendored
 * into it that the installed extension ships, or
 * the extension offers to refresh it — a modal, on
 * the way up, in front of whatever a spec was about
 * to do. Copying out of `dist/` rather than
 * unzipping the package keeps that to a directory
 * read.
 */
const SHIPPED = join(EXTENSION_REPO, 'dist');

/**
 * The editor the suite runs against, pinned.
 *
 * A version rather than `stable`, because the frame
 * chain `webviewFrame` walks and the workbench
 * selectors below are this build's — an editor that
 * moved under the suite should fail as one obvious
 * thing rather than as every spec at once.
 *
 * In its own file for the same reason the Node
 * version is: CI keys a 300-megabyte download's
 * cache on it, and a key that read this module
 * instead would throw the editor away every time a
 * selector moved.
 */
export const VSCODE_VERSION = readFileSync(
  join(HERE, '..', '.vscode-version'),
  'utf8',
).trim();

/** Where the download lands, and what CI caches. */
export const VSCODE_CACHE = join(HERE, '..', '.vscode-test');

/** The package the specs install and drive. */
export const E2E_VSIX =
  process.env.E2E_VSIX ?? join(EXTENSION_REPO, 'mboss-vscode-0.0.0.vsix');

/** What builds it, named in the failure that wants
 *  it. */
export const VSCODE_BUILD_COMMAND = 'npm run vscode:build';

/**
 * Proves the package is there before any spec tries
 * to install it.
 *
 * Building it here instead would bury an `npm ci`,
 * an esbuild run and a `vsce package` behind
 * Playwright's reporter — the same reason global
 * setup neither brings the compose stack up nor
 * builds the MCP bundle. The bundle is checked
 * beside the package because a project is given a
 * copy of it, and a `dist/` cleared since the
 * package was made would fail one spec deep instead
 * of here.
 */
export async function assertExtensionBuilt(): Promise<void> {
  for (const path of [E2E_VSIX, join(SHIPPED, 'mcp', 'server.js')]) {
    try {
      await access(path);
    } catch (cause) {
      throw new Error(
        `the extension is not built at ${path} — ` +
          `run \`${VSCODE_BUILD_COMMAND}\``,
        { cause },
      );
    }
  }
}

/**
 * Which webview a spec means.
 *
 * These are the extension's own bundle names, which
 * is how a frame is told from its siblings below:
 * the built page loads exactly one module, and its
 * path ends in the entry point's name. The
 * alternative — matching on a heading or a class —
 * would be matching on something localized, or on
 * markup a redesign owns.
 */
export type WebviewName = 'canvas' | 'sidebar' | 'runs' | 'see';

/** A running editor, driven. */
export type DrivenVsCode = {
  /** The workbench window. */
  page: Page;

  /** The named webview's content frame, once it has
   *  rendered. */
  webview(name: WebviewName): Promise<FrameLocator>;

  /** Whether it is on screen right now, asked once
   *  and answered either way. */
  showsWebview(name: WebviewName): Promise<boolean>;

  /** Runs a command from the palette, by the title
   *  it shows there. */
  runCommand(title: string): Promise<void>;

  /** Writes the open document to disk.
   *
   *  A webview that edits a workflow edits the
   *  buffer VS Code owns, and nothing more —
   *  while codegen, the runs list and any
   *  assertion about a file all read the disk. So
   *  a spec that changed something and then read
   *  the file would be reading what it opened. */
  save(): Promise<void>;

  /** Opens a project file in whichever editor
   *  claims it. */
  openFile(relative: string): Promise<void>;

  /** Answers an open dialog with a directory. */
  answerFolderPick(path: string): Promise<void>;

  /** Answers an input box with a line of text. */
  answerInput(text: string): Promise<void>;

  /** Answers the workspace-trust question with yes,
   *  through the editor a person would use. */
  trustFolder(): Promise<void>;

  close(): Promise<void>;
};

export type DriveRequest = {
  /** The folder to open, or none for the empty
   *  window `mBoss: New Project` starts from. */
  project?: string;

  /** Where a fake agent started from this window
   *  should write what it was told. Reaches the
   *  agent because the editor spawns it, and a
   *  child inherits the editor's environment. */
  agentTranscript?: string;
};

/**
 * A VS Code with the packaged extension installed,
 * open on one project.
 *
 * The profile is minted per call and thrown away
 * with it. That is not tidiness: a workspace-trust
 * decision outlives the window that made it, so a
 * reused profile would arrive already trusting the
 * fixture and every assertion about a restricted
 * window would pass without having been tested.
 * `extensionProject` mints a fresh directory for
 * the same reason — the decision is remembered
 * against the folder's path, and it outlives the
 * profile that made it, so a fixture opened where
 * an earlier run trusted one starts trusted however
 * new the profile is.
 *
 * Both directories are minted under the system temp
 * root rather than beside the suite, because the
 * editor's per-profile IPC socket lives inside the
 * profile and the OS caps a Unix socket path at 103
 * characters. A deep path fails the launch outright.
 */
export async function driveVsCode(
  request: DriveRequest,
): Promise<DrivenVsCode> {
  const executable = await downloadAndUnzipVSCode({
    version: VSCODE_VERSION,
    cachePath: VSCODE_CACHE,
  });

  const profile = await mkdtemp(join(await realpath(tmpdir()), 'mboss-vsc-'));
  const userData = join(profile, 'u');
  const extensions = join(profile, 'e');

  await installExtension(executable, userData, extensions);
  await writeEditorSettings(userData);

  const app = await _electron.launch({
    executablePath: executable,
    args: [
      // The editor is being driven, not used: no
      // sandbox to negotiate under xvfb, no update
      // check, and none of the first-run pages that
      // would take the editor area a spec is about
      // to open a document into.
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--disable-updates',
      '--disable-telemetry',
      '--skip-welcome',
      '--skip-release-notes',
      `--user-data-dir=${userData}`,
      `--extensions-dir=${extensions}`,
      ...(request.project === undefined ? [] : [request.project]),
    ],
    env: {
      ...process.env,
      ...(request.agentTranscript === undefined
        ? {}
        : { MBOSS_FAKE_AGENT_TRANSCRIPT: request.agentTranscript }),
    },
    timeout: LAUNCH_MS,
  });

  const page = await app.firstWindow({ timeout: LAUNCH_MS });
  await page.waitForSelector('.monaco-workbench', { timeout: LAUNCH_MS });

  return {
    page,
    webview: (name) => webviewFrame(page, name),
    showsWebview: async (name) =>
      (await showingWebview(page, name)) !== undefined,
    runCommand: (title) => runCommand(page, title),
    save: () => runCommand(page, 'File: Save'),
    openFile: (relative) => openFile(page, relative),
    answerFolderPick: (path) => answerFolderPick(page, path),
    answerInput: (text) => answerInput(page, text),
    trustFolder: () => trustFolder(page),
    close: async () => {
      await app.close();
      await rm(profile, { recursive: true, force: true });
    },
  };
}

export type FixtureRequest = {
  /** The project's name, and its directory's. */
  name: string;

  /** A checked-in directory from `fixtures/projects/`,
   *  laid over the scaffold's output. */
  overlay?: string;

  /** Whether to register the fake ACP agent as this
   *  project's custom one. */
  fakeAgent?: boolean;
};

/**
 * A fresh project with this extension's own control
 * plane already inside it.
 *
 * Scaffolded rather than checked in, the way the
 * durability spec's project is: a snapshot of the
 * scaffold's output would stop testing the scaffold
 * on the day it changed. The overlay on top is what
 * a scaffold does not write and a spec needs — the
 * code-behind's types, and a workflow document to
 * look at.
 *
 * The project sits one level inside a throwaway
 * directory, because the scaffold is given a
 * parent and a name the way the command is;
 * `discardExtensionProject` takes both away.
 *
 * Its ports are moved before the editor ever sees
 * it, and every project gets that whether or not it
 * will be started. The scaffold publishes Postgres
 * on 5432 and the app on 3000, which are the dev
 * stack's, and the one spec that has the Runs panel
 * bring a stack up would otherwise fail on a bind
 * conflict that reads exactly like the panel
 * failing to start anything. Rewriting it in one
 * place rather than in that spec is what keeps the
 * next spec to start a stack from inheriting the
 * collision.
 */
export async function extensionProject(
  request: FixtureRequest,
): Promise<string> {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), `mboss-ext-${request.name}-`),
  );
  const project = join(root, request.name);

  await scaffoldApp({
    dir: project,
    name: request.name,
    bundle: join(SHIPPED, 'mcp', 'server.js'),
    version: join(SHIPPED, 'mcp', 'VERSION'),
  });

  await rewriteEnv(project, {
    DATABASE_URL: EXTENSION_DATABASE_URL,
    DBOS_SYSTEM_DATABASE_URL: EXTENSION_DATABASE_URL,
    APP_BASE_URL: `http://127.0.0.1:${EXTENSION_APP_PORT}`,
  });
  await writeFile(
    join(project, 'docker-compose.override.yml'),
    EXTENSION_COMPOSE_OVERRIDE,
  );

  await vendorSkill(project);

  if (request.overlay !== undefined) {
    await cp(
      join(HERE, '..', 'fixtures', 'projects', request.overlay),
      project,
      { recursive: true },
    );
  }

  if (request.fakeAgent === true) await useFakeAgent(project);

  return project;
}

/** Removes a project and the directory it was made
 *  in. Missing is fine — a spec may have cleaned up
 *  already. */
export async function discardExtensionProject(project: string): Promise<void> {
  await rm(dirname(project), { recursive: true, force: true });
}

/** How long the editor gets to come up. It unzips a
 *  package, starts an extension host and paints a
 *  workbench. */
const LAUNCH_MS = 120_000;

/** How long a webview gets to render. The canvas
 *  lays a graph out before it draws one. */
const WEBVIEW_MS = 60_000;

/** Between passes over the frame tree. Long enough
 *  not to spin, short enough not to be the reason a
 *  spec is slow. */
const FRAME_POLL_MS = 250;

const execute = promisify(execFile);

/**
 * The fake ACP agent, registered through the slot a
 * real custom agent would use.
 *
 * This is the no-test-hooks constraint in practice:
 * nothing in the extension knows the fake exists,
 * and what makes it reachable is three ordinary
 * workspace settings. `resource` scope is what lets
 * them be written into one project rather than into
 * the machine.
 */
async function useFakeAgent(project: string): Promise<void> {
  const agent = join(HERE, '..', 'fixtures', 'fake-acp-agent', 'index.ts');

  await mkdir(join(project, '.vscode'), { recursive: true });
  await writeFile(
    join(project, '.vscode', 'settings.json'),
    `${JSON.stringify(
      {
        'mboss.agent.id': 'custom',
        // The interpreter running the suite, by
        // absolute path: the extension host spawns
        // this from the editor's environment, which
        // is not the shell's and need not have the
        // same `node` on its PATH.
        'mboss.agent.command': process.execPath,
        'mboss.agent.args': [agent],
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * The skill, in both the places the extension puts
 * it.
 *
 * The scaffold leaves these directories empty and
 * the extension fills them; a project missing them
 * reads as out of date, and the extension offers to
 * refresh it with a modal in front of whatever the
 * spec was about to do. Writing them here is how
 * the other specs stay about what they say they are
 * about — `scaffold.spec.ts` is where the real
 * vendoring is proven.
 */
async function vendorSkill(project: string): Promise<void> {
  for (const destination of ['.mboss/skills/mboss', '.claude/skills/mboss']) {
    const to = join(project, ...destination.split('/'));

    await mkdir(dirname(to), { recursive: true });
    await cp(join(SHIPPED, 'skill'), to, { recursive: true });
  }
}

/**
 * The package, into a profile that has never seen
 * it.
 *
 * Run through the editor's own CLI entry point
 * rather than by unzipping into the extensions
 * directory, because "the package installs" is one
 * of the things this suite exists to prove. Only
 * the resolver's first answer is used: the rest of
 * what it hands back are default profile
 * directories, and this passes its own.
 */
async function installExtension(
  executable: string,
  userData: string,
  extensions: string,
): Promise<void> {
  const [cli] = resolveCliArgsFromVSCodeExecutablePath(executable);

  if (cli === undefined) {
    throw new Error(`no CLI beside the editor at ${executable}`);
  }

  await execute(
    cli,
    [
      `--user-data-dir=${userData}`,
      `--extensions-dir=${extensions}`,
      '--install-extension',
      E2E_VSIX,
    ],
    { timeout: LAUNCH_MS, maxBuffer: 8 * 1024 * 1024 },
  );
}

/**
 * The editor's own settings, written into the
 * throwaway profile.
 *
 * Each one removes something that would sit in
 * front of a spec: a welcome page in the editor
 * area, an update check, and the chat pane a fresh
 * profile opens itself.
 *
 * The two dialog settings are the load-bearing
 * pair. A message box and a file dialog are drawn
 * by the operating system by default, which is to
 * say outside the page and out of Playwright's
 * reach entirely — `mBoss: New Project` asks for a
 * folder, and without `files.simpleDialog.enable`
 * that question is asked somewhere nothing here can
 * answer it.
 *
 * Workspace trust is deliberately not among them.
 * Turning it off would make every window trusted,
 * which is exactly the gate these specs are here to
 * watch work.
 */
async function writeEditorSettings(userData: string): Promise<void> {
  const dir = join(userData, 'User');

  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'settings.json'),
    `${JSON.stringify(
      {
        'window.dialogStyle': 'custom',
        'files.simpleDialog.enable': true,
        'workbench.startupEditor': 'none',
        'telemetry.telemetryLevel': 'off',
        'update.mode': 'none',
        'extensions.autoCheckUpdates': false,
        'chat.commandCenter.enabled': false,
        'workbench.secondarySideBar.defaultVisibility': 'hidden',
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * The content frame of one of the extension's
 * webviews.
 *
 * A webview is two nested iframes, and neither is
 * labelled with anything a spec chose: the outer
 * one is `iframe.webview` carrying a fresh GUID for
 * a name, and the inner one reports its name as
 * `pending-frame` whatever it is showing. Both are
 * moved out of the pane they belong to and into an
 * overlay layer, so walking down from the view is
 * not open either.
 *
 * So the frames are asked what they are: the page
 * the extension builds loads exactly one module,
 * and its path ends in the build's own entry-point
 * name. That survives a redesign, a translation,
 * and a VS Code that renames its layers.
 */
async function webviewFrame(
  page: Page,
  name: WebviewName,
): Promise<FrameLocator> {
  const until = Date.now() + WEBVIEW_MS;

  while (Date.now() < until) {
    const frame = await showingWebview(page, name);

    if (frame !== undefined) return frame;

    await pause(FRAME_POLL_MS);
  }

  throw new Error(
    `the ${name} webview never rendered — no visible frame under any ` +
      `\`iframe.webview\` loaded /webview/${name}.js`,
  );
}

/**
 * That webview's frame if it is on screen at this
 * instant, and nothing if it is not.
 *
 * Kept apart from the wait above because a helper
 * that only ever waits can say "not yet" but never
 * "gone". A spec whose point is that a panel is
 * still there needs the second answer, and needs it
 * at the moment it asks rather than after a minute
 * of hoping.
 *
 * On screen rather than merely present: the editor
 * hoists every webview into one overlay layer, and
 * whether the one it is hiding is removed from the
 * DOM or only hidden in it is the editor's business
 * and not a contract. Asking whether it is visible
 * answers the question a person would ask either
 * way.
 */
async function showingWebview(
  page: Page,
  name: WebviewName,
): Promise<FrameLocator | undefined> {
  const marker = `script[src$="/webview/${name}.js"]`;
  const outer = page.locator('iframe.webview');

  for (let at = 0; at < (await outer.count()); at += 1) {
    const host = outer.nth(at);
    const frame = host.contentFrame().locator('iframe').contentFrame();

    // A frame detaches while it is being read
    // whenever the editor re-lays the view out.
    // That is not a failure; it is the next
    // pass's problem.
    const found = await frame
      .locator(marker)
      .count()
      .catch(() => 0);

    if (found > 0 && (await host.isVisible().catch(() => false))) {
      return frame;
    }
  }

  return undefined;
}

/**
 * A command, through the palette a person types
 * into.
 *
 * Focus is parked on the Explorer first, and that
 * is load-bearing rather than tidy: a webview with
 * keyboard focus swallows the palette's keystroke,
 * so a command run after a spec has typed into the
 * agent panel would silently never open.
 */
async function runCommand(page: Page, title: string): Promise<void> {
  await parkFocus(page);
  await page.keyboard.press('F1');
  await page.waitForSelector('.quick-input-widget', { state: 'visible' });
  await page.keyboard.type(title);

  const row = page
    .locator('.quick-input-list .monaco-list-row')
    .filter({ hasText: title })
    .first();

  await row.click();
}

/**
 * Opens a project file by its path.
 *
 * Through quick open rather than the Explorer tree,
 * because a file under `.mboss/workflows` is three
 * disclosure triangles deep and each of them is a
 * chance for this to be about the tree instead.
 * Backspacing the leading `>` is how the palette
 * turns back into the file finder.
 */
async function openFile(page: Page, relative: string): Promise<void> {
  await parkFocus(page);
  await page.keyboard.press('F1');
  await page.waitForSelector('.quick-input-widget', { state: 'visible' });
  await page.keyboard.press('Backspace');
  await page.keyboard.type(relative);

  await page.locator('.quick-input-list .monaco-list-row').first().click();
}

/**
 * Answers an open dialog with a directory.
 *
 * The simple file dialog is a quick input with a
 * path box: a trailing separator is what makes it
 * navigate rather than filter, and its accept
 * button is what returns the directory now in the
 * box. The button is found by where it sits rather
 * than by what it says, because what it says is the
 * caller's `openLabel` and is translated.
 */
async function answerFolderPick(page: Page, path: string): Promise<void> {
  const box = page.locator('.quick-input-box input');

  await box.waitFor();
  await box.fill(`${path}/`);

  await page
    .locator('.quick-input-action .monaco-button')
    .filter({ visible: true })
    .first()
    .click();
}

/**
 * Answers an input box.
 *
 * Filled rather than typed: the box validates on
 * every keystroke, and a name checked letter by
 * letter spends most of its keystrokes refused.
 */
async function answerInput(page: Page, text: string): Promise<void> {
  const box = page.locator('.quick-input-box input');

  await box.waitFor();
  await box.fill(text);
  await box.press('Enter');
}

/**
 * Says yes to the folder, the way a person does.
 *
 * Through the real Workspace Trust editor rather
 * than a setting, because a spec that switched
 * trust off in the profile would prove the
 * extension works in the one case it is never asked
 * about.
 *
 * The editor is closed afterwards, by the keyboard
 * because there is nothing to click: it opens with
 * no tab of its own, behind a block that eats every
 * pointer event aimed at what is underneath — so a
 * spec that left it open would find every later
 * click going nowhere.
 */
async function trustFolder(page: Page): Promise<void> {
  const badge = page.locator('#status\\.workspaceTrust');

  await badge.waitFor({ timeout: LAUNCH_MS });
  await badge.click();

  await page
    .locator('.monaco-button', { hasText: /^Trust$/ })
    .first()
    .click();
  await badge.waitFor({ state: 'detached' });

  await page.keyboard.press('ControlOrMeta+w');
  await page
    .locator('.monaco-modal-editor-block')
    .waitFor({ state: 'detached' });
}

/**
 * Somewhere in the workbench that is neither a
 * webview nor a document.
 *
 * The whole activity bar entry is clicked, not the
 * icon inside it. The editor draws a badge over
 * that icon whenever something is unsaved, and a
 * badge is the icon's sibling rather than its
 * child — so a click aimed at the icon is refused
 * as intercepted, and every spec that saves twice
 * finds the second save waiting on a badge to go
 * away that only saving would take away.
 */
async function parkFocus(page: Page): Promise<void> {
  await page
    .locator('.activitybar .action-item:has([aria-label^="Explorer"])')
    .first()
    .click();
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

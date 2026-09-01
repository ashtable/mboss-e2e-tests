import { cp, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Fixture mBoss projects, and copies of them.
 *
 * A spec drives a project the way an agent does,
 * which means writing into it: new workflows,
 * proposal files, scaffolded handlers, generated
 * code. So it gets a copy in a scratch directory
 * and the checked-in fixture stays the state every
 * run starts from.
 *
 * The fixtures hold inputs only — no `node_modules`
 * and nothing built — so a copy is a directory
 * read, which is what makes copying one per round
 * of a twenty-five round race reasonable.
 */

export const FIXTURE_PROJECTS = fileURLToPath(
  new URL('../fixtures/projects', import.meta.url),
);

/**
 * A scratch copy of the named fixture project.
 *
 * The path is resolved through `realpath` because
 * the system temp directory is a symlink on macOS,
 * and a spec comparing the directory it asked for
 * against the one a tool reports back would
 * otherwise fail for the wrong reason.
 */
export async function copyFixtureProject(name: string): Promise<string> {
  const source = join(FIXTURE_PROJECTS, name);
  await assertFixture(source, name);

  const dir = await realpath(
    await mkdtemp(join(tmpdir(), `mboss-e2e-${name}-`)),
  );
  await cp(source, dir, { recursive: true });

  return dir;
}

/**
 * Removes a copy. Missing is fine — a spec may
 * have cleaned up already.
 */
export async function discardProject(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/**
 * A fixture name nobody checked in reads as an
 * empty project three tool calls later, so it is
 * refused here instead.
 */
async function assertFixture(source: string, name: string): Promise<void> {
  try {
    const found = await stat(source);
    if (found.isDirectory()) return;
  } catch {
    // Falls through to the same message: absent and
    // not-a-directory are one mistake.
  }

  throw new Error(
    `there is no fixture project called \`${name}\` — ` +
      `fixtures/projects/${name}/ does not exist`,
  );
}

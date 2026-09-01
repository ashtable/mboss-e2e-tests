import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  FIXTURE_PROJECTS,
  copyFixtureProject,
  discardProject,
} from '../helpers/project.js';

/**
 * The fixture projects, copied.
 *
 * A spec writes into the project it drives — new
 * workflows, proposals, scaffolded handlers,
 * generated code — so it gets a copy and the
 * checked-in original stays the thing every run
 * starts from.
 */

const copies: string[] = [];

afterEach(async () => {
  while (copies.length > 0) await discardProject(copies.pop() ?? '');
});

async function copy(name = 'minimal'): Promise<string> {
  const dir = await copyFixtureProject(name);
  copies.push(dir);

  return dir;
}

describe('copyFixtureProject', () => {
  it('copies the dotted directory that makes it a project', async () => {
    const dir = await copy();

    expect(existsSync(join(dir, '.mboss', 'workflows'))).toBe(true);
    expect(existsSync(join(dir, '.mboss', 'conventions.md'))).toBe(true);
  });

  it('copies the code-behind and the build files', async () => {
    const dir = await copy();

    expect(existsSync(join(dir, 'lib', 'types.ts'))).toBe(true);
    expect(existsSync(join(dir, 'tsconfig.json'))).toBe(true);
    expect(existsSync(join(dir, 'package.json'))).toBe(true);
  });

  /**
   * Two copies of one fixture are two projects.
   * The lock-contention spec races two servers over
   * a single copy on purpose; nothing else should
   * be sharing a directory by accident.
   */
  it('gives each copy its own directory', async () => {
    const first = await copy();
    const second = await copy();

    expect(first).not.toBe(second);

    writeFileSync(join(first, 'lib', 'marker.ts'), 'export const n = 1;\n');

    expect(existsSync(join(second, 'lib', 'marker.ts'))).toBe(false);
  });

  it('leaves the checked-in fixture alone', async () => {
    const original = join(FIXTURE_PROJECTS, 'minimal', 'lib', 'types.ts');
    const before = readFileSync(original, 'utf8');

    const dir = await copy();
    writeFileSync(join(dir, 'lib', 'types.ts'), 'export type Gone = never;\n');

    expect(readFileSync(original, 'utf8')).toBe(before);
  });

  it('names a fixture that is not there', async () => {
    await expect(copyFixtureProject('no-such-project')).rejects.toThrow(
      /no-such-project/,
    );
  });
});

describe('discardProject', () => {
  it('removes the copy', async () => {
    const dir = await copyFixtureProject('minimal');

    await discardProject(dir);

    expect(existsSync(dir)).toBe(false);
  });
});

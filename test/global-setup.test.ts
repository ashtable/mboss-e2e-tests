import { createServer } from 'node:net';

import { describe, expect, it } from 'vitest';

import { portInUse, requestedProjects } from '../global-setup.js';

/**
 * Which suites a run is about.
 *
 * Global setup runs once per invocation whatever
 * `--project` was given, and `FullConfig.projects`
 * is the whole declared list rather than the
 * filtered one — checked against Playwright 1.62,
 * which hands global setup all three names even
 * for `--project=mcp`. So the filter has to be
 * read off the command line, and this is the part
 * of that worth testing without spawning a runner.
 *
 * The argv shapes below are the ones Playwright's
 * own CLI accepts: `--project` takes a value
 * either joined by `=` or as one or more following
 * words.
 */

const PLAYWRIGHT = ['/usr/bin/node', '/repo/node_modules/.bin/playwright'];

function argv(...rest: string[]): string[] {
  return [...PLAYWRIGHT, 'test', ...rest];
}

describe('requestedProjects', () => {
  it('reads a project joined by an equals sign', () => {
    expect(requestedProjects(argv('--project=mcp'))).toEqual(new Set(['mcp']));
  });

  it('reads a project given as the next word', () => {
    expect(requestedProjects(argv('--project', 'cloud'))).toEqual(
      new Set(['cloud']),
    );
  });

  /** `--project` is variadic in Playwright's own CLI. */
  it('reads several projects given as following words', () => {
    expect(requestedProjects(argv('--project', 'mcp', 'extension'))).toEqual(
      new Set(['mcp', 'extension']),
    );
  });

  it('reads a repeated flag', () => {
    expect(requestedProjects(argv('--project=cloud', '--project=mcp'))).toEqual(
      new Set(['cloud', 'mcp']),
    );
  });

  it('stops at the next flag', () => {
    expect(
      requestedProjects(argv('--project', 'mcp', '--reporter=line')),
    ).toEqual(new Set(['mcp']));
  });

  /**
   * No filter is every project, and the caller has
   * to be able to tell that from a filter that
   * happened to name none — otherwise `npm run e2e`
   * would quietly check nothing.
   */
  it('says nothing when no project was named', () => {
    expect(requestedProjects(argv())).toBeUndefined();
    expect(
      requestedProjects(argv('tests/cloud/landing.spec.ts')),
    ).toBeUndefined();
  });

  it('says nothing when the flag carries no value', () => {
    expect(requestedProjects(argv('--project'))).toBeUndefined();
  });
});

/**
 * The half of the `extension-stack` gate that can
 * be checked without a Docker daemon.
 *
 * That journey publishes a scaffolded project's own
 * Postgres and app on this machine, and a port
 * something else holds turns into a bind conflict
 * inside `docker compose up` — which reads exactly
 * like the Runs panel failing to start a stack. So
 * the gate says so first, and this is the part of
 * it worth proving with a socket rather than a
 * container.
 */
describe('portInUse', () => {
  it('says a port something is listening on is in use', async () => {
    const held = await hold();

    try {
      expect(await portInUse(held.port)).toBe(true);
    } finally {
      await held.release();
    }
  });

  it('says a port nothing holds is free', async () => {
    const held = await hold();
    await held.release();

    expect(await portInUse(held.port)).toBe(false);
  });
});

/**
 * A port this test knows is taken, and the way to
 * give it back.
 *
 * Asked for as 0 and read back, because a number
 * written down here would be a number something
 * else on the machine may hold — which is the very
 * thing the gate exists to notice, and would make
 * the second test below pass without having been
 * tested.
 */
async function hold(): Promise<{ port: number; release: () => Promise<void> }> {
  const server = createServer();

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();

  if (typeof address !== 'object' || address === null) {
    throw new Error('the listening server reported no port');
  }

  return {
    port: address.port,
    release: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

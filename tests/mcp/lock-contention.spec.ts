import { existsSync } from 'node:fs';
import { readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import {
  connectToBundle,
  errorCodeOf,
  outputOf,
  type McpSession,
} from '../../helpers/mcp.js';
import { copyFixtureProject, discardProject } from '../../helpers/project.js';

/**
 * Two server processes writing one workflow at the
 * same instant.
 *
 * `baseRevision` alone cannot make this safe:
 * check-then-write is a race, and two writers that
 * both read revision 12 both pass the check and
 * both write a revision 13, the second erasing the
 * first. What makes it safe is the advisory lock
 * on `.mboss/.lock` that every writer takes — and
 * a lock is only worth anything across real
 * processes, so this spec runs two of them.
 *
 * A racy lock fails probabilistically, so one
 * passing round proves nothing. The race runs
 * twenty-five times and any single round fails the
 * spec; the repetition is the assertion, not a
 * retry.
 */

const WORKFLOW = 'contended';
const ROUNDS = 25;

/**
 * How long a fresh lock is watched before it is
 * called a wait. Well under the ten seconds after
 * which a lock is presumed abandoned, so the two
 * cases below stay different from each other.
 */
const WAITING_MS = 1_500;

let project = '';
let racers: McpSession[] = [];

/** The document both racers are writing. */
function workflowPath(): string {
  return join(project, '.mboss', 'workflows', `${WORKFLOW}.workflow.json`);
}

function lockPath(): string {
  return join(project, '.mboss', '.lock');
}

/** A whole document, distinguishable by who wrote it. */
function specBy(racer: string, round: number) {
  return {
    title: `Written by ${racer} in round ${round}`,
    nodes: [
      {
        id: 'arrival',
        kind: 'trigger',
        title: 'Visitor arrives',
        config: { mode: 'manual' },
        out: 'Visitor',
      },
    ],
    edges: [],
  };
}

type ApplyOutput = { applied: boolean; revision?: number };

async function documentOnDisk(): Promise<{
  revision: number;
  title: string;
}> {
  return JSON.parse(await readFile(workflowPath(), 'utf8'));
}

test.beforeAll(async () => {
  project = await copyFixtureProject('minimal');
  racers = [
    await connectToBundle(project, 'racer one'),
    await connectToBundle(project, 'racer two'),
  ];

  const [first] = racers;
  await first?.client.callTool({
    name: 'workflow_create',
    arguments: { name: WORKFLOW, title: 'Contended' },
  });
});

test.afterAll(async () => {
  for (const racer of racers) await racer.close();
  await discardProject(project);
});

test.describe('two racing servers', () => {
  test(`lets exactly one apply win, ${ROUNDS} times over`, async () => {
    // Fifty applies through two cold bundles, each
    // one a validate and an atomic write.
    test.setTimeout(180_000);

    const [one, two] = racers;
    if (one === undefined || two === undefined) {
      throw new Error('both racers have to be connected');
    }

    for (let round = 1; round <= ROUNDS; round += 1) {
      const before = (await documentOnDisk()).revision;
      const where = `round ${round}`;

      // Both from the same base revision, fired
      // together. One of them is wrong by the time
      // it holds the lock, and that is the whole
      // question.
      const results = await Promise.all(
        racers.map((racer, at) =>
          racer.client.callTool({
            name: 'workflow_apply_spec',
            arguments: {
              name: WORKFLOW,
              spec: specBy(at === 0 ? 'one' : 'two', round),
              dryRun: false,
              baseRevision: before,
            },
          }),
        ),
      );

      const codes = results.map(errorCodeOf);
      const winners = codes
        .map((code, at) => (code === undefined ? at : -1))
        .filter((at) => at >= 0);

      expect(winners, `${where}: exactly one apply should win`).toHaveLength(1);
      expect(
        codes.filter((code) => code !== undefined),
        `${where}: the loser should be refused, not hung or applied`,
      ).toEqual(['REVISION_CONFLICT']);

      const winner = winners[0] ?? 0;
      const applied = outputOf<ApplyOutput>(results[winner] as never);
      expect(applied, `${where}: the winner should have written`).toMatchObject(
        { applied: true, revision: before + 1 },
      );

      // Reads the file rather than trusting the
      // answer: a torn write is exactly what would
      // not show up in a tool result.
      const written = await documentOnDisk();
      expect(written.revision, `${where}: the revision advances once`).toBe(
        before + 1,
      );
      expect(
        written.title,
        `${where}: the whole winning document should have landed`,
      ).toBe(specBy(winner === 0 ? 'one' : 'two', round).title);

      expect(
        existsSync(lockPath()),
        `${where}: the lock should have been given back`,
      ).toBe(false);
    }
  });

  /**
   * The crash path. A process that dies holding the
   * lock leaves the file behind with nobody to
   * release it, so a lock nothing has touched for
   * ten seconds is broken open by the next caller —
   * otherwise one crash would stop every writer for
   * good.
   */
  test('takes over a lock left behind by a crash', async () => {
    const [one] = racers;
    if (one === undefined) throw new Error('a racer has to be connected');

    const before = (await documentOnDisk()).revision;

    await writeFile(lockPath(), '99999:deadbeefdead', 'utf8');
    const abandoned = new Date(Date.now() - 30_000);
    await utimes(lockPath(), abandoned, abandoned);

    const applied = outputOf<ApplyOutput>(
      await one.client.callTool({
        name: 'workflow_apply_spec',
        arguments: {
          name: WORKFLOW,
          spec: specBy('the survivor', 0),
          dryRun: false,
          baseRevision: before,
        },
      }),
    );

    expect(applied).toMatchObject({ applied: true, revision: before + 1 });
    expect(existsSync(lockPath())).toBe(false);
  });

  /**
   * The other side of the same rule: a lock
   * somebody is still holding is waited on, not
   * walked past. Bounded well under the ten-second
   * takeover so this case and the one above cannot
   * be confused for each other.
   */
  test('waits behind a lock that is still fresh', async () => {
    const [one] = racers;
    if (one === undefined) throw new Error('a racer has to be connected');

    const before = (await documentOnDisk()).revision;

    await writeFile(lockPath(), '99999:deadbeefdead', 'utf8');

    const pending = one.client.callTool({
      name: 'workflow_apply_spec',
      arguments: {
        name: WORKFLOW,
        spec: specBy('the waiter', 0),
        dryRun: false,
        baseRevision: before,
      },
    });

    expect(
      await Promise.race([
        pending.then(() => 'settled'),
        after(WAITING_MS, 'waiting'),
      ]),
      'the apply went through while another writer held the lock',
    ).toBe('waiting');

    // Still untouched: waiting is waiting, not
    // writing and reporting later.
    expect((await documentOnDisk()).revision).toBe(before);

    await rm(lockPath());

    expect(outputOf<ApplyOutput>(await pending)).toMatchObject({
      applied: true,
      revision: before + 1,
    });
    expect(existsSync(lockPath())).toBe(false);
  });
});

function after<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * The overlay a spec breaks and then mends,
 * checked for still being the shape that story
 * needs.
 *
 * Structural only, like the crash fixture's own
 * check and for the same reason: this runs in the
 * hermetic job, on a checkout with no submodules,
 * so there is no `@mboss/core` here to validate
 * against. Whether the document is *legal* is
 * answered by the real validator through the
 * bundle.
 *
 * What is worth catching here is the part the
 * validator has no opinion about: a handler that
 * no longer refuses anything, that refuses it from
 * somewhere other than the one line a spec
 * rewrites while a run is on screen, or a step
 * losing the block in front of it that a replay
 * has to inherit.
 */

const PROJECT = fileURLToPath(
  new URL('../fixtures/projects/failing-step', import.meta.url),
);

type Node = {
  id: string;
  kind: string;
  handler?: { export: string };
  config: Record<string, unknown>;
};

type Edge = { id: string; from: { node: string }; to: { node: string } };

const ir = JSON.parse(
  readFileSync(
    `${PROJECT}/.mboss/workflows/failing_step.workflow.json`,
    'utf8',
  ),
) as { name: string; nodes: Node[]; edges: Edge[] };

const nodeOf = (id: string): Node | undefined =>
  ir.nodes.find((node) => node.id === id);

describe('the failing-step fixture', () => {
  test('is the workflow the specs run by name', () => {
    expect(ir.name).toBe('failing_step');
  });

  /**
   * Three blocks, and the middle one is the reason
   * this fixture can prove anything. A fork copies
   * the durable rows below the point it starts
   * from, so a step with nothing in front of it
   * has nothing to carry over and its replay reads
   * the same as a second run. A fourth block would
   * only be something else to wait for between the
   * failure and the replay.
   */
  test('starts by hand and runs two steps', () => {
    expect(ir.nodes.map((node) => node.kind)).toEqual([
      'trigger',
      'step',
      'step',
    ]);
  });

  /**
   * A spec starts this run itself and types the
   * input that makes it fail, so the trigger has
   * to be the one a person presses.
   */
  test('waits to be started by a person', () => {
    expect(nodeOf('started_by_hand')?.config).toEqual({ mode: 'manual' });
  });

  /** One path, head to tail. A dangling node would
   *  never run and never be missed. */
  test('wires every node to the next one', () => {
    const chained = ir.edges.map((edge) => [edge.from.node, edge.to.node]);
    const ids = ir.nodes.map((node) => node.id);

    expect(chained).toEqual(
      ids.slice(0, -1).map((id, at) => [id, ids[at + 1]]),
    );
  });

  /**
   * The handler travels with the document. A block
   * naming an export nobody wrote compiles to an
   * import of nothing, and the failure arrives
   * from `tsc` inside a scaffolded project rather
   * than from here.
   */
  test('ships the code behind the block that names one', () => {
    const named = ir.nodes
      .map((node) => node.handler?.export)
      .filter((exported) => exported !== undefined);

    expect(named).toEqual(['loadClaim', 'settleIt']);

    for (const exported of named) {
      expect(
        existsSync(`${PROJECT}/lib/${exported}.ts`),
        `lib/${exported}.ts`,
      ).toBe(true);
    }
  });

  /**
   * The whole fixture is one line long. A spec
   * rewrites it mid-run and asks for a replay, so
   * the refusal has to be exactly one statement,
   * on one line, and the only one in the file —
   * otherwise the edit that mends it is a judgement
   * call made in the middle of a run.
   */
  test('refuses the claim on the one line a spec rewrites', () => {
    const handler = readFileSync(`${PROJECT}/lib/settleIt.ts`, 'utf8');
    const throwing = handler
      .split('\n')
      .filter((line) => line.includes('throw'));

    expect(throwing).toEqual([
      "  if (claim.fail) throw new Error('the ledger refused this claim');",
    ]);
  });
});

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * The overlay a spec cancels and resumes, checked
 * for still being the shape that story needs.
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
 * validator has no opinion about: a wait short
 * enough to be over before the spec has cancelled
 * anything, or long enough that the run cannot
 * finish inside the spec's own patience.
 */

const PROJECT = fileURLToPath(
  new URL('../fixtures/projects/timer-then-answer', import.meta.url),
);

type Node = {
  id: string;
  kind: string;
  handler?: { export: string };
  config: Record<string, unknown>;
};

type Edge = {
  id: string;
  from: { node: string };
  to: { node: string };
  type: string;
};

const ir = JSON.parse(
  readFileSync(
    `${PROJECT}/.mboss/workflows/timer_then_answer.workflow.json`,
    'utf8',
  ),
) as { name: string; nodes: Node[]; edges: Edge[] };

const nodeOf = (id: string): Node | undefined =>
  ir.nodes.find((node) => node.id === id);

describe('the timer-then-answer fixture', () => {
  test('is the workflow the spec runs by name', () => {
    expect(ir.name).toBe('timer_then_answer');
  });

  /**
   * A wait with something after it. Cancelling a
   * run that is only waiting proves nothing about
   * resuming one: the step behind the timer is
   * what has to still be unrun when the resume
   * happens and run once when it lands.
   */
  test('starts by hand, waits, then answers', () => {
    expect(ir.nodes.map((node) => node.kind)).toEqual([
      'trigger',
      'durableWait',
      'step',
    ]);
  });

  /**
   * A spec starts this run itself, so the trigger
   * has to be the one a person presses.
   */
  test('waits to be started by a person', () => {
    expect(nodeOf('started_by_hand')?.config).toEqual({ mode: 'manual' });
  });

  /**
   * Sixty seconds: long enough that a spec can
   * cancel the run while it is still asleep and
   * resume it before the clock is out, short
   * enough that waiting the rest of it out for the
   * answer stays inside one test.
   */
  test('sleeps on a clock nobody has to answer', () => {
    expect(nodeOf('let_it_wait')?.config).toEqual({
      source: { kind: 'timer', seconds: 60 },
      onTimeout: 'abort',
    });
  });

  /**
   * The value flows through the wait: it names no
   * type of its own, and the edge out of it
   * carries the same type as the edge in.
   */
  test('carries its value through the wait', () => {
    const wait = nodeOf('let_it_wait') as Record<string, unknown>;

    expect(wait.in).toBeUndefined();
    expect(wait.out).toBeUndefined();
    expect(ir.edges.map((edge) => edge.type)).toEqual(['Enquiry', 'Enquiry']);
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

    expect(named).toEqual(['answerIt']);

    for (const exported of named) {
      expect(
        existsSync(`${PROJECT}/lib/${exported}.ts`),
        `lib/${exported}.ts`,
      ).toBe(true);
    }
  });
});

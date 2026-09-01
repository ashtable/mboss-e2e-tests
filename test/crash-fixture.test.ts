import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * The document `generated-app-durability` drives,
 * checked for still being the shape that spec
 * needs.
 *
 * Structural only, and deliberately so: this runs
 * in the hermetic job, on a checkout with no
 * submodules, so there is no `@mboss/core` here to
 * validate against and nothing may import one.
 * Whether the document is *legal* is answered by
 * `workflow_validate` through the bundle, which the
 * spec calls before it installs anything — the real
 * validator, and the first thing that runs.
 *
 * What is worth catching here is different and
 * cannot be caught there: an edit that leaves the
 * fixture perfectly valid and no longer a crash
 * test. A document with no transaction, or with the
 * wait moved before the email, would apply and
 * build and then prove nothing, twenty minutes into
 * a run.
 */

const PROJECT = fileURLToPath(
  new URL('../fixtures/projects/crash-fixture', import.meta.url),
);

type Node = {
  id: string;
  kind: string;
  handler?: { export: string };
  config: Record<string, unknown>;
};

type Edge = { id: string; from: { node: string }; to: { node: string } };

const ir = JSON.parse(
  readFileSync(`${PROJECT}/crash_fixture.workflow.json`, 'utf8'),
) as { name: string; nodes: Node[]; edges: Edge[] };

const nodeOf = (id: string): Node | undefined =>
  ir.nodes.find((node) => node.id === id);

describe('the crash fixture', () => {
  test('is the workflow the spec applies by name', () => {
    expect(ir.name).toBe('crash_fixture');
  });

  /**
   * Every kind the crash path needs, in the order
   * it needs them. The step and the email before
   * the wait are what the restored-not-re-run
   * assertion is made of; the transaction after it
   * is what the exactly-once assertion is made of.
   */
  test('runs a step and an email, waits, then steps and commits', () => {
    expect(ir.nodes.map((node) => node.kind)).toEqual([
      'trigger',
      'step',
      'emailSend',
      'durableWait',
      'step',
      'transaction',
    ]);
  });

  /**
   * The spec posts this event and reads the address
   * back out of the mail it produced, so all three
   * of these are its own inputs.
   */
  test('starts on an event that names the requester', () => {
    expect(nodeOf('claim_filed')?.config).toEqual({
      mode: 'event',
      topic: 'claim.filed',
      idempotencyKeyPath: 'claimId',
      requesterEmailPath: 'contact.email',
    });
  });

  /**
   * The link the spec follows comes out of this
   * email, and the run parks on the wait that names
   * it. A wait pointed at some other email would
   * leave the form link opening nothing.
   */
  test('waits on the form its own email carries', () => {
    const email = nodeOf('ask_details')?.config as {
      to: string;
      attach: { type: string; form: { fields: { id: string }[] } };
    };

    expect(email.to).toBe('requestingUser');
    expect(email.attach.type).toBe('form');
    expect(email.attach.form.fields.map((field) => field.id)).toEqual([
      'note',
      'urgent',
    ]);

    expect(nodeOf('await_details')?.config).toMatchObject({
      source: { kind: 'form', email: 'ask_details' },
    });
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
   * The handlers travel with the document. A block
   * naming an export nobody wrote compiles to an
   * import of nothing, and the failure arrives from
   * `tsc` inside a scaffolded project rather than
   * from here.
   */
  test('ships the code behind every block that names one', () => {
    const named = ir.nodes
      .map((node) => node.handler?.export)
      .filter((exported) => exported !== undefined);

    expect(named).toEqual(['openCase', 'settleCase', 'recordSettlement']);

    for (const exported of named) {
      expect(
        existsSync(`${PROJECT}/lib/${exported}.ts`),
        `lib/${exported}.ts`,
      ).toBe(true);
    }
  });
});

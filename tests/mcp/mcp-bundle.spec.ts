import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import {
  connectToBundle,
  errorCodeOf,
  outputOf,
  textOf,
  type McpSession,
} from '../../helpers/mcp.js';
import { copyFixtureProject, discardProject } from '../../helpers/project.js';

/**
 * The shipped bundle, driven end to end the way an
 * agent drives it.
 *
 * Everything asserted here is also asserted
 * in-process inside `mboss-mcp-server`, and that is
 * the point: this run adds the packaging. The
 * server is one 18MB file with no `node_modules`
 * beside it, spawned by the host's own Node in a
 * project it has never seen, and the whole compiler
 * — ts-morph included — has to have survived the
 * bundling. A tool tree-shaken away, an import that
 * only resolved next to its own repository, a
 * template read from a path that no longer exists:
 * none of those are visible to a test that imports
 * the source.
 */

const WORKFLOW = 'greeting';

/**
 * A trigger and one step with code behind it. Small
 * on purpose: what is under test is the bundle, and
 * a wider graph would only make a failure harder to
 * read.
 */
const SPEC = {
  title: 'Greeting',
  nodes: [
    {
      id: 'arrival',
      kind: 'trigger',
      title: 'Visitor arrives',
      config: { mode: 'manual' },
      out: 'Visitor',
    },
    {
      id: 'compose',
      kind: 'step',
      title: 'Compose greeting',
      handler: { export: 'composeGreeting' },
      in: 'Visitor',
      out: 'Greeting',
      config: {},
    },
  ],
  edges: [
    {
      id: 'e1',
      from: { node: 'arrival', port: 'out' },
      to: { node: 'compose' },
      type: 'Visitor',
    },
  ],
};

type CreateOutput = { name: string; path: string; revision: number };

type ApplyOutput = {
  valid: boolean;
  errors: unknown[];
  warnings: unknown[];
  summary: { nodesAdded: number; edgesAdded: number };
  proposalId?: string;
  applied: boolean;
  revision?: number;
};

type GetOutput = {
  name: string;
  revision: number;
  ir: { nodes: { id: string }[]; edges: { to: { node: string } }[] };
  diagnostics: unknown[];
};

type RenameOutput = {
  applied: true;
  revision: number;
  updatedReferences: number;
};

type ScaffoldOutput = {
  created: { path: string; export: string; signature: string }[];
};

type BuildOutput = {
  ok: boolean;
  codegenMs: number;
  diagnostics: unknown[];
  unsupported: string[];
  tscErrors: string[];
};

let project = '';
let session: McpSession;

test.beforeEach(async () => {
  project = await copyFixtureProject('minimal');
  session = await connectToBundle(project, 'mcp-bundle spec');
});

test.afterEach(async () => {
  await session.close();
  await discardProject(project);
});

test.describe('the shipped bundle', () => {
  test('creates, previews, applies, renames, scaffolds and builds', async () => {
    // ts-morph scans `lib/` and type-checks the
    // whole project twice over in here, from a
    // cold 18MB module graph.
    test.setTimeout(180_000);

    const { client } = session;

    const created = outputOf<CreateOutput>(
      await client.callTool({
        name: 'workflow_create',
        arguments: { name: WORKFLOW, title: 'Greeting' },
      }),
    );
    expect(created).toMatchObject({ name: WORKFLOW, revision: 1 });
    expect(existsSync(created.path)).toBe(true);

    // A dry run writes the whole proposed document
    // down and changes nothing. This is what a
    // running canvas watches for.
    const previewed = outputOf<ApplyOutput>(
      await client.callTool({
        name: 'workflow_apply_spec',
        arguments: {
          name: WORKFLOW,
          spec: SPEC,
          dryRun: true,
          baseRevision: 1,
        },
      }),
    );
    expect(previewed.applied).toBe(false);
    expect(previewed.errors).toEqual([]);
    expect(previewed.summary).toMatchObject({ nodesAdded: 2, edgesAdded: 1 });

    const proposalId = previewed.proposalId ?? '';
    const proposalFile = join(
      project,
      '.mboss',
      'proposals',
      `${proposalId}.proposal.json`,
    );
    expect(JSON.parse(await readFile(proposalFile, 'utf8'))).toMatchObject({
      id: proposalId,
      workflow: WORKFLOW,
      baseRevision: 1,
      status: 'proposed',
      proposedBy: 'mcp-bundle spec',
    });

    const applied = outputOf<ApplyOutput>(
      await client.callTool({
        name: 'workflow_apply_spec',
        arguments: { name: WORKFLOW, spec: SPEC, dryRun: false, proposalId },
      }),
    );
    expect(applied).toMatchObject({ applied: true, revision: 2 });
    expect(JSON.parse(await readFile(proposalFile, 'utf8'))).toMatchObject({
      status: 'applied',
    });

    const read = outputOf<GetOutput>(
      await client.callTool({
        name: 'workflow_get',
        arguments: { name: WORKFLOW },
      }),
    );
    expect(read.revision).toBe(2);
    expect(read.ir.nodes.map((node) => node.id)).toEqual([
      'arrival',
      'compose',
    ]);

    // The edge's endpoint is the reference that has
    // to move with the name. `updatedReferences` is
    // the tool's whole observable output, so it is
    // asserted as a number rather than as "not
    // zero".
    const renamed = outputOf<RenameOutput>(
      await client.callTool({
        name: 'workflow_rename_node',
        arguments: { workflow: WORKFLOW, nodeId: 'compose', newId: 'welcome' },
      }),
    );
    expect(renamed).toMatchObject({
      applied: true,
      revision: 3,
      updatedReferences: 1,
    });

    const afterRename = outputOf<GetOutput>(
      await client.callTool({
        name: 'workflow_get',
        arguments: { name: WORKFLOW },
      }),
    );
    expect(afterRename.ir.nodes.map((node) => node.id)).toEqual([
      'arrival',
      'welcome',
    ]);
    expect(afterRename.ir.edges.map((edge) => edge.to.node)).toEqual([
      'welcome',
    ]);

    // The signature is the assertion: it is typed
    // from the block's own `in`/`out` and the scan
    // of the project's `lib/`, and both of those
    // run inside the bundle.
    const scaffolded = outputOf<ScaffoldOutput>(
      await client.callTool({
        name: 'workflow_scaffold_step',
        arguments: { workflow: WORKFLOW, nodeId: 'welcome' },
      }),
    );
    expect(scaffolded.created.map((file) => file.path)).toEqual([
      join(project, 'lib', 'composeGreeting.ts'),
      join(project, 'lib', 'composeGreeting.test.ts'),
    ]);
    expect(scaffolded.created[0]?.signature).toBe(
      'export async function composeGreeting(input: Visitor): Promise<Greeting>',
    );

    const handler = await readFile(
      join(project, 'lib', 'composeGreeting.ts'),
      'utf8',
    );
    expect(handler).toContain(
      "import type { Greeting, Visitor } from './types.js';",
    );

    const built = outputOf<BuildOutput>(
      await client.callTool({ name: 'project_build', arguments: {} }),
    );
    expect(built.diagnostics).toEqual([]);
    expect(built.unsupported).toEqual([]);
    expect(built.codegenMs).toBeGreaterThanOrEqual(0);
    // Every complaint the gate made, and only
    // these two. The files name themselves, which
    // is what proves the check really read what
    // was just scaffolded and just generated; the
    // reason both complain is that this fixture
    // installs nothing, so the two real packages
    // they import have no declarations to resolve
    // against. A third complaint would be a
    // genuine type error — a scaffolded signature
    // that does not match its block, generated
    // code calling a handler that is not there —
    // and catching one of those is why the build
    // is in this sequence at all.
    expect(built.ok).toBe(false);
    expect(built.tscErrors.map(withoutLineNumber)).toEqual([
      "lib/composeGreeting.test.ts Cannot find module 'vitest' or " +
        'its corresponding type declarations.',
      'src/workflows/greeting.workflow.ts Cannot find module ' +
        "'@dbos-inc/dbos-sdk' or its corresponding type declarations.",
    ]);

    const generated = await readFile(
      join(project, 'src', 'workflows', `${WORKFLOW}.workflow.ts`),
      'utf8',
    );
    expect(generated).toContain('GENERATED BY MBOSS — DO NOT EDIT.');
    expect(generated).toContain("from '../../lib/composeGreeting.js'");
  });

  test('reads every resource', async () => {
    const { client } = session;

    await client.callTool({
      name: 'workflow_create',
      arguments: { name: WORKFLOW },
    });

    const catalog = textOf(
      await client.readResource({ uri: 'mboss://node-catalog' }),
    );
    expect(catalog.mimeType).toBe('application/json');
    expect(JSON.parse(catalog.text)).toHaveProperty('kinds');

    const schema = textOf(
      await client.readResource({ uri: 'mboss://workflow-schema' }),
    );
    expect(schema.mimeType).toBe('application/json');
    expect(JSON.parse(schema.text)).toHaveProperty('properties');

    const current = textOf(
      await client.readResource({ uri: 'mboss://current-workflow' }),
    );
    expect(current.mimeType).toBe('application/json');
    expect(JSON.parse(current.text)).toMatchObject({
      name: WORKFLOW,
      revision: 1,
    });

    const diagnostics = textOf(
      await client.readResource({ uri: 'mboss://diagnostics' }),
    );
    expect(diagnostics.mimeType).toBe('application/json');
    expect(JSON.parse(diagnostics.text)).toHaveProperty('workflows');

    const conventions = textOf(
      await client.readResource({ uri: 'mboss://conventions' }),
    );
    expect(conventions.mimeType).toBe('text/markdown');
    expect(conventions.text).toContain('Handlers live in `lib/`');
  });

  /**
   * Every coded failure, over the wire. The codes
   * are product surface an agent matches on, and a
   * client that dropped the structured channel
   * would turn each of these into an opaque
   * failure — which is exactly what an in-process
   * test cannot see.
   */
  test('reports every structured failure by its code', async () => {
    const { client } = session;

    expect(
      errorCodeOf(
        await client.callTool({
          name: 'workflow_get',
          arguments: { name: 'nope' },
        }),
      ),
    ).toBe('WORKFLOW_NOT_FOUND');

    // No workflows at all, and no name given.
    expect(
      errorCodeOf(
        await client.callTool({ name: 'workflow_get', arguments: {} }),
      ),
    ).toBe('NO_CURRENT_WORKFLOW');

    await client.callTool({
      name: 'workflow_create',
      arguments: { name: WORKFLOW },
    });

    expect(
      errorCodeOf(
        await client.callTool({
          name: 'workflow_apply_spec',
          arguments: {
            name: WORKFLOW,
            spec: SPEC,
            dryRun: false,
            baseRevision: 99,
          },
        }),
      ),
    ).toBe('REVISION_CONFLICT');

    expect(
      errorCodeOf(
        await client.callTool({
          name: 'workflow_apply_spec',
          arguments: {
            name: WORKFLOW,
            spec: TWO_TRIGGERS,
            dryRun: true,
            baseRevision: 1,
          },
        }),
      ),
    ).toBe('VALIDATION_FAILED');

    expect(
      errorCodeOf(
        await client.callTool({
          name: 'workflow_apply_spec',
          arguments: {
            name: WORKFLOW,
            spec: SPEC,
            dryRun: false,
            proposalId: 'prop_0_00000000',
          },
        }),
      ),
    ).toBe('PROPOSAL_NOT_FOUND');

    // A preview, then a change underneath it. The
    // approval was for a document that has moved
    // on, so it is refused rather than replayed.
    const previewed = outputOf<ApplyOutput>(
      await client.callTool({
        name: 'workflow_apply_spec',
        arguments: {
          name: WORKFLOW,
          spec: SPEC,
          dryRun: true,
          baseRevision: 1,
        },
      }),
    );
    await client.callTool({
      name: 'workflow_apply_spec',
      arguments: {
        name: WORKFLOW,
        spec: SPEC,
        dryRun: false,
        baseRevision: 1,
      },
    });

    const stale = await client.callTool({
      name: 'workflow_apply_spec',
      arguments: {
        name: WORKFLOW,
        spec: SPEC,
        dryRun: false,
        proposalId: previewed.proposalId,
      },
    });
    expect(errorCodeOf(stale)).toBe('PROPOSAL_STALE');
    expect(stale.structuredContent).toMatchObject({
      baseRevision: 1,
      currentRevision: 2,
    });
  });

  /**
   * A server started somewhere that is not a
   * project. The bundle walks up looking for
   * `.mboss/` and finds none, which is a refusal
   * rather than a crash — an agent scaffolding a
   * new project starts one here on purpose.
   */
  test('refuses to work outside a project', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'mboss-e2e-bare-'));
    const outside = await connectToBundle(bare, 'mcp-bundle spec');

    try {
      expect(
        errorCodeOf(
          await outside.client.callTool({
            name: 'workflow_get',
            arguments: { name: WORKFLOW },
          }),
        ),
      ).toBe('NOT_AN_MBOSS_PROJECT');
    } finally {
      await outside.close();
      await discardProject(bare);
    }
  });
});

/** A document saying something that cannot be true. */
const TWO_TRIGGERS = {
  title: 'Two ways in',
  nodes: [
    {
      id: 'arrival',
      kind: 'trigger',
      title: 'Visitor arrives',
      config: { mode: 'manual' },
      out: 'Visitor',
    },
    {
      id: 'other',
      kind: 'trigger',
      title: 'Also arrives',
      config: { mode: 'manual' },
      out: 'Visitor',
    },
  ],
  edges: [],
};

/**
 * A type problem without the line it is on: the
 * file and the message are the assertion, and the
 * line moves whenever the generated preamble
 * does.
 */
function withoutLineNumber(problem: string): string {
  return problem.replace(/:\d+ /, ' ');
}

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  loadScenario,
  loadScenarios,
  SCENARIOS_DIR,
} from '../fixtures/fake-acp-agent/index.js';

/**
 * The scenario loader, which is what makes a
 * scripted agent worth having.
 *
 * A scenario is the whole of what the fake agent
 * will do, so a typo in one has to fail here, in
 * seconds, rather than as a VS Code session that
 * sits there doing nothing. Every error names the
 * file it came from and what was wrong with it.
 */

const SERMON_HELPER = join(SCENARIOS_DIR, 'sermon-helper.scenario.json');

let scratch = '';

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'mboss-scenario-'));
});

afterEach(() => {
  scratch = '';
});

/** Writes a scenario file and answers with its path. */
async function scenarioFile(name: string, body: unknown): Promise<string> {
  const path = join(scratch, name);
  await writeFile(
    path,
    typeof body === 'string' ? body : JSON.stringify(body),
    'utf8',
  );

  return path;
}

describe('the shipped scenarios', () => {
  test('every one of them loads, with a prompt of its own', async () => {
    const scenarios = await loadScenarios();

    expect(scenarios.length).toBeGreaterThanOrEqual(4);

    const prompts = scenarios.map((scenario) => scenario.prompt);
    expect(new Set(prompts).size).toBe(prompts.length);
    expect(prompts.every((prompt) => prompt.length > 0)).toBe(true);
  });

  test('the sermon helper reads both catalogs and dry-runs a spec', async () => {
    const scenario = await loadScenario(SERMON_HELPER);

    expect(
      scenario.steps
        .filter((step) => step.kind === 'readResource')
        .map((step) => step.uri),
    ).toEqual(['mboss://node-catalog', 'mboss://workflow-schema']);

    const calls = scenario.steps.filter((step) => step.kind === 'toolCall');
    expect(calls.map((call) => call.tool)).toEqual(['workflow_apply_spec']);
    expect(calls[0]?.args).toMatchObject({
      name: 'sermon_helper',
      dryRun: true,
    });

    expect(scenario.steps.at(-1)).toEqual({
      kind: 'stopTurn',
      stopReason: 'end_turn',
    });
  });

  /**
   * The preview banner the canvas draws reads
   * `+16 nodes +18 edges`, and the counts come from
   * this spec by way of the MCP server's own diff.
   * Pinning them here is what keeps the fixture and
   * the assertion in the extension suite talking
   * about the same graph.
   */
  test('the referenced spec is the sixteen-node graph', async () => {
    const scenario = await loadScenario(SERMON_HELPER);
    const [call] = scenario.steps.filter((step) => step.kind === 'toolCall');

    const spec = call?.args.spec as { nodes: unknown[]; edges: unknown[] };

    expect(spec.nodes).toHaveLength(16);
    expect(spec.edges).toHaveLength(18);
  });
});

describe('a scenario that will not do', () => {
  test('a file that is not there names the file', async () => {
    const missing = join(scratch, 'nope.scenario.json');

    await expect(loadScenario(missing)).rejects.toThrow(missing);
  });

  test('text that is not JSON names the file', async () => {
    const path = await scenarioFile('broken.scenario.json', '{ nope');

    await expect(loadScenario(path)).rejects.toThrow(path);
  });

  test('a missing prompt is named as the missing field', async () => {
    const path = await scenarioFile('unprompted.scenario.json', { steps: [] });

    await expect(loadScenario(path)).rejects.toThrow(/prompt/);
  });

  test('an unknown step kind names the step and the kind', async () => {
    const path = await scenarioFile('typo.scenario.json', {
      prompt: 'do the thing',
      steps: [{ kind: 'toolcall', tool: 'workflow_get' }],
    });

    await expect(loadScenario(path)).rejects.toThrow(/step 1.*toolcall/s);
  });

  test('a step missing a required field says which one', async () => {
    const path = await scenarioFile('untexted.scenario.json', {
      prompt: 'do the thing',
      steps: [{ kind: 'update', sessionUpdate: 'agent_message_chunk' }],
    });

    await expect(loadScenario(path)).rejects.toThrow(/step 1.*text/s);
  });

  test('a file reference that resolves to nothing names the path', async () => {
    const path = await scenarioFile('dangling.scenario.json', {
      prompt: 'do the thing',
      steps: [
        {
          kind: 'toolCall',
          tool: 'workflow_apply_spec',
          args: { spec: { $file: './specs/gone.json' } },
        },
      ],
    });

    await expect(loadScenario(path)).rejects.toThrow(
      join(scratch, 'specs', 'gone.json'),
    );
  });

  test('a file reference resolves against the scenario, not the cwd', async () => {
    await writeFile(
      join(scratch, 'payload.json'),
      JSON.stringify({ nodes: [] }),
      'utf8',
    );

    const path = await scenarioFile('referring.scenario.json', {
      prompt: 'do the thing',
      steps: [
        {
          kind: 'toolCall',
          tool: 'workflow_apply_spec',
          args: { spec: { $file: './payload.json' } },
        },
      ],
    });

    const scenario = await loadScenario(path);
    const [step] = scenario.steps;

    expect(step?.kind).toBe('toolCall');
    if (step?.kind !== 'toolCall') return;

    expect(step.args.spec).toEqual({ nodes: [] });
  });
});

describe('where the scenarios live', () => {
  test('beside the module that plays them', () => {
    expect(SCENARIOS_DIR).toBe(
      fileURLToPath(
        new URL('../fixtures/fake-acp-agent/scenarios', import.meta.url),
      ),
    );
  });
});

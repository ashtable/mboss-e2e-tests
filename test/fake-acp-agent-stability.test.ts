import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, test } from 'vitest';

import {
  createFakeAcpAgent,
  loadScenario,
  SCENARIOS_DIR,
  TRANSCRIPT_ENV,
  transcriptFrom,
  type McpConnector,
  type Scenario,
} from '../fixtures/fake-acp-agent/index.js';
import { drive } from './support/acp-client.js';

/**
 * The same conversation, twice, byte for byte.
 *
 * This is the assertion the whole fixture is
 * shaped around. A transcript that carried a
 * clock, a random id or a counter that survived
 * between runs would differ here, and the extension
 * suite would then be asserting against a moving
 * target it could only match loosely.
 *
 * So nothing incidental is recorded: the ids the
 * player mints count from one per agent, the lines
 * carry no timestamp, and what is written down is
 * the requests either side sent — never the
 * responses, whose contents belong to a real
 * server, a real editor and a real temporary
 * directory rather than to the scenario.
 */

const PROJECT = '/tmp/sermon-project';

/** An MCP side that answers yes and remembers nothing. */
const connect: McpConnector = () =>
  Promise.resolve({
    callTool: () => Promise.resolve({ ok: true as const }),
    readResource: () => Promise.resolve({ ok: true as const }),
    close: () => Promise.resolve(),
  });

let scratch = '';
let sermonHelper: Scenario;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'mboss-stability-'));
  sermonHelper = await loadScenario(
    join(SCENARIOS_DIR, 'sermon-helper.scenario.json'),
  );
});

/**
 * One whole conversation, from a fresh agent, into
 * a transcript of its own. Fresh matters: an agent
 * that carried a counter over from the last run
 * would be the exact drift this asserts against.
 */
async function run(name: string): Promise<string> {
  const path = join(scratch, name);

  const peer = drive(
    createFakeAcpAgent({
      scenarios: [sermonHelper],
      connect,
      transcript: transcriptFrom({ [TRANSCRIPT_ENV]: path }),
    }),
  );

  await peer.initialize();
  const sessionId = await peer.open({
    cwd: PROJECT,
    mcpServers: [
      {
        name: 'mboss',
        command: 'node',
        args: [join(PROJECT, '.mboss', 'mcp', 'server.js')],
        env: [],
      },
    ],
  });

  await peer.prompt(sessionId, sermonHelper.prompt);
  peer.close();

  return await readFile(path, 'utf8');
}

describe('two runs of one scenario', () => {
  test('write the same bytes', async () => {
    const first = await run('first.jsonl');
    const second = await run('second.jsonl');

    expect(second).toBe(first);
  });

  test('and the bytes are a whole conversation, not an empty file', async () => {
    const lines = (await run('only.jsonl')).split('\n').filter(Boolean);

    expect(lines.length).toBeGreaterThan(10);
    expect(lines.every((line) => JSON.parse(line) !== null)).toBe(true);
  });

  /**
   * The two failures a byte comparison would catch
   * but not explain. Naming them separately is what
   * turns a red diff into a diagnosis.
   */
  test('carrying no clock and no id nobody chose', async () => {
    const transcript = await run('inspected.jsonl');

    expect(transcript).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(transcript).not.toMatch(/\b1[6-9]\d{11}\b/);
    expect(transcript).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    );
    expect(transcript).toContain('"session-1"');
  });
});

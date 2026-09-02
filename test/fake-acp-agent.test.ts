import { join } from 'node:path';

import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { beforeEach, describe, expect, test } from 'vitest';

import {
  createFakeAcpAgent,
  loadScenario,
  loadScenarios,
  SCENARIOS_DIR,
  type McpConnector,
  type McpServerDescriptor,
  type Scenario,
} from '../fixtures/fake-acp-agent/index.js';
import { drive, STUB_FILE_CONTENT, type Peer } from './support/acp-client.js';

/**
 * The fake agent against the protocol, driven by a
 * client app joined straight to it.
 *
 * There is no process here and no pipe: what is
 * under test is whether the player answers what
 * the protocol asks for and replays what the
 * scenario says, and neither of those is about
 * framing. The extension suite spawns the same
 * module for real, and that is where the pipe gets
 * its say.
 */

const PROJECT = '/tmp/sermon-project';

const MBOSS_SERVER: McpServerDescriptor = {
  name: 'mboss',
  command: 'node',
  args: [join(PROJECT, '.mboss', 'mcp', 'server.js')],
  env: [],
};

/** One MCP call the agent made. */
type Call = { server: string; name: string; args: Record<string, unknown> };

/** One MCP resource the agent read. */
type Read = { server: string; uri: string };

/**
 * An MCP side that records instead of spawning.
 *
 * The real connector is the same `Client` +
 * `StdioClientTransport` pair `helpers/mcp.ts`
 * uses, and the extension suite drives it against
 * the bundle a project vendored. Here the question
 * is only whether the player opens one peer per
 * descriptor and calls what the scenario named.
 */
function recordingMcp(): {
  connect: McpConnector;
  opened: McpServerDescriptor[];
  calls: Call[];
  reads: Read[];
  closed: string[];
} {
  const opened: McpServerDescriptor[] = [];
  const calls: Call[] = [];
  const reads: Read[] = [];
  const closed: string[] = [];

  const connect: McpConnector = (server) => {
    opened.push(server);

    return Promise.resolve({
      callTool: (name: string, args: Record<string, unknown>) => {
        calls.push({ server: server.name, name, args });

        return Promise.resolve({ ok: true as const });
      },
      readResource: (uri: string) => {
        reads.push({ server: server.name, uri });

        return Promise.resolve({ ok: true as const });
      },
      close: () => {
        closed.push(server.name);

        return Promise.resolve();
      },
    });
  };

  return { connect, opened, calls, reads, closed };
}

let sermonHelper: Scenario;
let permission: Scenario;
let fsRead: Scenario;

beforeEach(async () => {
  [sermonHelper, permission, fsRead] = await Promise.all([
    loadScenario(join(SCENARIOS_DIR, 'sermon-helper.scenario.json')),
    loadScenario(join(SCENARIOS_DIR, 'permission.scenario.json')),
    loadScenario(join(SCENARIOS_DIR, 'fs-read.scenario.json')),
  ]);
});

/** A started session, and the peer that started it. */
async function opened(
  scenarios: readonly Scenario[],
  connect?: McpConnector,
  servers: McpServerDescriptor[] = [],
): Promise<{ peer: Peer; sessionId: string }> {
  const peer = drive(createFakeAcpAgent({ scenarios, connect }));

  await peer.initialize();
  const sessionId = await peer.open({ cwd: PROJECT, mcpServers: servers });

  return { peer, sessionId };
}

describe('the handshake', () => {
  test('answers the version it was asked for', async () => {
    const peer = drive(createFakeAcpAgent({ scenarios: [] }));

    const initialized = await peer.initialize();

    expect(initialized.protocolVersion).toBe(PROTOCOL_VERSION);
    peer.close();
  });

  /**
   * The extension offers no terminal, so an agent
   * that used one would be conformant to nothing it
   * will ever be plugged into. The absence is a
   * decision twice over: nothing is advertised
   * here, and no scenario step exists that could
   * ask for one.
   */
  test('claims no terminal, and cannot be scripted into one', async () => {
    const peer = drive(createFakeAcpAgent({ scenarios: [] }));

    const initialized = await peer.initialize();

    expect(JSON.stringify(initialized.agentCapabilities)).not.toContain(
      'terminal',
    );

    const kinds = new Set(
      (await loadScenarios()).flatMap((scenario) =>
        scenario.steps.map((step) => step.kind),
      ),
    );
    expect([...kinds].some((kind) => kind.includes('terminal'))).toBe(false);

    peer.close();
  });
});

describe('session/new', () => {
  test('opens one MCP client for every server it was passed', async () => {
    const mcp = recordingMcp();
    const second: McpServerDescriptor = {
      name: 'notes',
      command: 'node',
      args: ['/tmp/notes.js'],
      env: [{ name: 'NOTES_HOME', value: '/tmp/notes' }],
    };

    const { peer } = await opened([], mcp.connect, [MBOSS_SERVER, second]);

    expect(mcp.opened).toEqual([MBOSS_SERVER, second]);
    peer.close();
  });

  /**
   * `cwd` is not readable from outside, so it is
   * asserted where it is used: a scenario naming a
   * project-relative file has to reach the editor
   * as an absolute path under the session's own
   * directory, which is what ACP requires.
   */
  test('remembers the project it was opened in', async () => {
    const { peer, sessionId } = await opened([fsRead]);

    await peer.prompt(sessionId, fsRead.prompt);

    expect(peer.reads.map((read) => read.path)).toEqual([
      join(PROJECT, 'lib', 'types.ts'),
    ]);
    peer.close();
  });
});

describe('the sermon helper scenario', () => {
  test('replays its steps in the order they are written', async () => {
    const mcp = recordingMcp();
    const { peer, sessionId } = await opened([sermonHelper], mcp.connect, [
      MBOSS_SERVER,
    ]);

    const stopReason = await peer.prompt(sessionId, sermonHelper.prompt);

    expect(stopReason).toBe('end_turn');
    expect(peer.updates.map((update) => update.sessionUpdate)).toEqual([
      'agent_message_chunk',
      'agent_message_chunk',
      'agent_message_chunk',
      'agent_thought_chunk',
      'tool_call',
      'tool_call_update',
      'agent_message_chunk',
      'agent_message_chunk',
      'plan',
    ]);

    peer.close();
  });

  test('reads both catalogs and dry-runs the spec through MCP', async () => {
    const mcp = recordingMcp();
    const { peer, sessionId } = await opened([sermonHelper], mcp.connect, [
      MBOSS_SERVER,
    ]);

    await peer.prompt(sessionId, sermonHelper.prompt);

    expect(mcp.reads).toEqual([
      { server: 'mboss', uri: 'mboss://node-catalog' },
      { server: 'mboss', uri: 'mboss://workflow-schema' },
    ]);

    expect(mcp.calls).toHaveLength(1);
    expect(mcp.calls[0]?.name).toBe('workflow_apply_spec');
    expect(mcp.calls[0]?.args).toMatchObject({
      name: 'sermon_helper',
      dryRun: true,
    });

    // The `$file` reference was resolved before it
    // ever reached the wire.
    const spec = mcp.calls[0]?.args.spec as { nodes: unknown[] };
    expect(spec.nodes).toHaveLength(16);

    peer.close();
  });

  test('the tool call goes pending, then completed, under one id', async () => {
    const mcp = recordingMcp();
    const { peer, sessionId } = await opened([sermonHelper], mcp.connect, [
      MBOSS_SERVER,
    ]);

    await peer.prompt(sessionId, sermonHelper.prompt);

    const started = peer.updates.find(
      (update) => update.sessionUpdate === 'tool_call',
    );
    const finished = peer.updates.find(
      (update) => update.sessionUpdate === 'tool_call_update',
    );

    expect(started).toMatchObject({ status: 'pending', kind: 'edit' });
    expect(finished).toMatchObject({ status: 'completed' });
    expect(finished?.toolCallId).toBe(started?.toolCallId);

    expect(finished?.content?.[0]).toMatchObject({
      type: 'diff',
      path: join(PROJECT, '.mboss', 'workflows', 'sermon_helper.workflow.json'),
    });

    peer.close();
  });

  test('a failing MCP call fails the tool card and the turn', async () => {
    const connect: McpConnector = () =>
      Promise.resolve({
        callTool: () =>
          Promise.resolve({ ok: false as const, detail: 'VALIDATION_FAILED' }),
        readResource: () => Promise.resolve({ ok: true as const }),
        close: () => Promise.resolve(),
      });

    const { peer, sessionId } = await opened([sermonHelper], connect, [
      MBOSS_SERVER,
    ]);

    await expect(peer.prompt(sessionId, sermonHelper.prompt)).rejects.toThrow(
      /VALIDATION_FAILED/,
    );

    expect(
      peer.updates.filter(
        (update) => update.sessionUpdate === 'tool_call_update',
      ),
    ).toMatchObject([{ status: 'failed' }]);

    peer.close();
  });
});

describe('a prompt with no scenario behind it', () => {
  test('fails naming the prompt, and says nothing else at all', async () => {
    const { peer, sessionId } = await opened([sermonHelper]);

    await expect(peer.prompt(sessionId, 'improvise something')).rejects.toThrow(
      /improvise something/,
    );

    expect(peer.updates).toEqual([]);
    peer.close();
  });

  test('lists what it does know, so a typo is obvious', async () => {
    const { peer, sessionId } = await opened([fsRead]);

    await expect(peer.prompt(sessionId, 'nearly right')).rejects.toThrow(
      fsRead.prompt,
    );

    peer.close();
  });
});

describe('the permission scenario', () => {
  test('asks once, with the options the scenario wrote', async () => {
    const { peer, sessionId } = await opened([permission]);

    await peer.prompt(sessionId, permission.prompt);

    expect(peer.questions).toHaveLength(1);
    expect(peer.questions[0]?.options.map((option) => option.kind)).toEqual([
      'allow_once',
      'allow_always',
      'reject_once',
    ]);
    expect(peer.questions[0]?.sessionId).toBe(sessionId);

    peer.close();
  });

  test('waits for the answer before it goes on', async () => {
    let release: (() => void) | undefined;
    const answered = new Promise<void>((resolve) => {
      release = resolve;
    });

    const peer = drive(createFakeAcpAgent({ scenarios: [permission] }), {
      answerPermission: async (request) => {
        await answered;
        const [first] = request.options;

        return {
          outcome: { outcome: 'selected', optionId: first?.optionId ?? '' },
        };
      },
    });

    await peer.initialize();
    const sessionId = await peer.open({ cwd: PROJECT, mcpServers: [] });

    let settled = false;
    const turn = peer.prompt(sessionId, permission.prompt).then((stop) => {
      settled = true;

      return stop;
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(peer.questions).toHaveLength(1);

    release?.();
    expect(await turn).toBe('end_turn');
    expect(settled).toBe(true);

    peer.close();
  });

  test('a refusal fails the tool call rather than the turn', async () => {
    const peer = drive(createFakeAcpAgent({ scenarios: [permission] }), {
      answerPermission: (request) => {
        const refusal = request.options.find(
          (option) => option.kind === 'reject_once',
        );

        return Promise.resolve({
          outcome: { outcome: 'selected', optionId: refusal?.optionId ?? '' },
        });
      },
    });

    await peer.initialize();
    const sessionId = await peer.open({ cwd: PROJECT, mcpServers: [] });

    expect(await peer.prompt(sessionId, permission.prompt)).toBe('end_turn');
    expect(
      peer.updates.filter(
        (update) => update.sessionUpdate === 'tool_call_update',
      ),
    ).toMatchObject([{ status: 'failed' }]);

    peer.close();
  });
});

describe('cancelling a turn', () => {
  /**
   * The cancel is sent from inside the editor's
   * answer to a request the agent is waiting on,
   * which is the only way to land it mid-replay
   * without a timer deciding the outcome.
   */
  test('stops the replay where it stood and ends the turn', async () => {
    let sessionId = '';

    const peer = drive(createFakeAcpAgent({ scenarios: [fsRead] }), {
      answerRead: async (_request, self) => {
        await self.cancel(sessionId);

        return { content: STUB_FILE_CONTENT };
      },
    });

    await peer.initialize();
    sessionId = await peer.open({ cwd: PROJECT, mcpServers: [] });

    expect(await peer.prompt(sessionId, fsRead.prompt)).toBe('cancelled');

    // The chunk before the read arrived; the one
    // after it never did.
    expect(peer.updates).toHaveLength(1);
    expect(peer.reads).toHaveLength(1);

    peer.close();
  });

  test('a cancelled permission ends the turn too', async () => {
    let sessionId = '';

    const peer = drive(createFakeAcpAgent({ scenarios: [permission] }), {
      answerPermission: async (_request, self) => {
        await self.cancel(sessionId);

        return { outcome: { outcome: 'cancelled' } };
      },
    });

    await peer.initialize();
    sessionId = await peer.open({ cwd: PROJECT, mcpServers: [] });

    expect(await peer.prompt(sessionId, permission.prompt)).toBe('cancelled');
    expect(
      peer.updates.filter(
        (update) => update.sessionUpdate === 'tool_call_update',
      ),
    ).toMatchObject([{ status: 'failed' }]);

    peer.close();
  });
});

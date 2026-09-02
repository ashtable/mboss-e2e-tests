import { appendFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  PROTOCOL_VERSION,
  RequestError,
  agent,
  ndJsonStream,
  type AgentApp,
  type AgentContext,
  type ContentBlock,
  type McpServer,
  type PermissionOption,
  type RequestPermissionResponse,
  type SessionUpdate,
  type StopReason,
  type ToolCallContent,
  type ToolCallUpdate,
  type ToolKind,
} from '@agentclientprotocol/sdk';
import { Client } from '@modelcontextprotocol/client';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/client/stdio';

/**
 * A coding agent that does exactly what it was
 * told, and does it the same way twice.
 *
 * The extension's sidebar is an ACP client, and
 * every real peer for it costs tokens and answers
 * differently each time. So this is a peer that
 * speaks the protocol for real — the same SDK, the
 * same framing, a real MCP client opened against
 * the server it is handed — while the words come
 * from a scenario file keyed by the exact prompt
 * that asks for them. An unrecognised prompt is an
 * error, never an improvisation: a player that
 * guessed would be a peer nobody could assert
 * against.
 *
 * One exported factory, the way the mail sink and
 * the identity mock are built here. `main()` wires
 * it to stdin and stdout for the extension to
 * spawn, and the conformance suite joins a client
 * app straight to the same object — so the thing
 * the tests drive is the thing that runs.
 *
 * It registers through the extension's `custom`
 * agent slot, like any other program somebody
 * points that setting at. Nothing in the extension
 * knows this file exists.
 */

/** What this agent calls itself on the wire. */
const AGENT_NAME = 'fake-acp-agent';

/** The environment variable naming the transcript. */
export const TRANSCRIPT_ENV = 'MBOSS_FAKE_AGENT_TRANSCRIPT';

/** The scenarios shipped beside this module. */
export const SCENARIOS_DIR = fileURLToPath(
  new URL('./scenarios', import.meta.url),
);

/**
 * A file the agent claims a tool touched. Paths are
 * written relative to the project and resolved
 * against the session's own directory, because ACP
 * carries absolute paths and a scenario cannot know
 * where the project will be.
 */
export type ScenarioDiff = {
  path: string;

  oldText?: string;

  newText: string;
};

/**
 * One thing the agent does during a turn.
 *
 * Parsing fills in every optional field, so the
 * player never has to ask what a step left out.
 * There is deliberately no step for a terminal:
 * the extension offers no terminal capability, and
 * a scenario able to ask for one would exercise a
 * path that does not exist.
 */
export type ScenarioStep =
  | {
      kind: 'update';
      sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk';
      text: string;
    }
  | { kind: 'update'; sessionUpdate: 'plan'; entries: string[] }
  | { kind: 'readResource'; server: string; uri: string }
  | {
      kind: 'toolCall';
      server: string;
      tool: string;
      title: string;
      toolKind: ToolKind;
      args: Record<string, unknown>;
      diffs: ScenarioDiff[];
    }
  | {
      kind: 'requestPermission';
      title: string;
      toolKind: ToolKind;
      options: PermissionOption[];
    }
  | { kind: 'readTextFile'; path: string }
  | { kind: 'stopTurn'; stopReason: StopReason };

/** A prompt, and everything it makes the agent do. */
export type Scenario = { prompt: string; steps: ScenarioStep[] };

/**
 * One line of the transcript.
 *
 * Requests and notifications only, in both
 * directions — never a response. A response carries
 * whatever a real MCP server, a real editor and a
 * real temporary directory had to say, none of
 * which the scenario chose, and a transcript
 * holding those could not be compared between two
 * runs.
 */
export type TranscriptLine = {
  from: 'client' | 'agent';

  method: string;

  params: unknown;
};

/** Where what crossed the wire is written down. */
export type Transcript = { record(line: TranscriptLine): void };

/** An MCP server the session was handed, over stdio. */
export type McpServerDescriptor = {
  name: string;

  command: string;

  args: string[];

  env: { name: string; value: string }[];
};

/**
 * Whether an MCP call worked. The payload is left
 * behind on purpose: the player is scripted, so it
 * has no use for what came back, and a transcript
 * carrying it would stop being comparable.
 */
export type McpOutcome = { ok: true } | { ok: false; detail: string };

/** The MCP half of a session, one per server. */
export type McpPeer = {
  callTool(name: string, args: Record<string, unknown>): Promise<McpOutcome>;

  readResource(uri: string): Promise<McpOutcome>;

  close(): Promise<void>;
};

/**
 * How a descriptor becomes a live peer. The default
 * spawns the server for real; the conformance suite
 * passes one that records instead, which is what
 * lets those tests run with nothing built.
 */
export type McpConnector = (
  server: McpServerDescriptor,
  cwd: string,
) => Promise<McpPeer>;

export type FakeAgentOptions = {
  scenarios: readonly Scenario[];

  transcript?: Transcript;

  connect?: McpConnector;
};

/**
 * A transcript writer, or one that discards.
 *
 * Lines are appended synchronously. Buffering would
 * buy nothing a fixture can notice and would put
 * "did it flush?" between a failing assertion and
 * the truth, so there is nothing left to flush when
 * the process ends — however it ends.
 */
export function transcriptFrom(
  env: Record<string, string | undefined>,
): Transcript {
  const path = env[TRANSCRIPT_ENV];

  if (path === undefined || path === '') return { record: () => {} };

  return {
    record: (line) => {
      appendFileSync(path, `${JSON.stringify(line)}\n`);
    },
  };
}

/**
 * Every scenario in a directory, in name order.
 *
 * Sorted because the player's error message lists
 * what it knows, and a list whose order came from
 * the filesystem would read differently on two
 * machines.
 */
export async function loadScenarios(
  dir: string = SCENARIOS_DIR,
): Promise<Scenario[]> {
  const names = (await readdir(dir))
    .filter((name) => name.endsWith('.scenario.json'))
    .sort();

  return await Promise.all(
    names.map((name) => loadScenario(resolve(dir, name))),
  );
}

/**
 * One scenario, with its `$file` references read in.
 *
 * Every failure names the file, and a bad step also
 * names which step it was. That is the whole point
 * of the loader: a scenario typo fails here, in
 * seconds, rather than as a VS Code session sitting
 * there doing nothing.
 */
export async function loadScenario(file: string): Promise<Scenario> {
  const text = await readFile(file, 'utf8').catch((cause: unknown) => {
    throw new Error(`${file}: cannot be read`, { cause });
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`${file}: is not JSON`, { cause });
  }

  const document = fields(file, parsed, 'a scenario');
  const prompt = textOf(file, document, 'prompt');
  const steps = listOf(file, document, 'steps');

  return {
    prompt,
    steps: await Promise.all(
      steps.map((step, index) =>
        parseStep(`${file}: step ${index + 1}`, dirname(file), step),
      ),
    ),
  };
}

export function createFakeAcpAgent(options: FakeAgentOptions): AgentApp {
  const transcript = options.transcript ?? { record: () => {} };
  const connect = options.connect ?? connectOverStdio;
  const byPrompt = new Map(
    options.scenarios.map((scenario) => [scenario.prompt, scenario]),
  );

  const sessions = new Map<string, Session>();
  let opened = 0;

  function heard(method: string, params: unknown): void {
    transcript.record({ from: 'client', method, params });
  }

  function said(method: string, params: unknown): void {
    transcript.record({ from: 'agent', method, params });
  }

  /** Sends one update, and writes it down first. */
  async function send(
    client: AgentContext,
    sessionId: string,
    update: SessionUpdate,
  ): Promise<void> {
    said('session/update', { sessionId, update });
    await client.notify('session/update', { sessionId, update });
  }

  /**
   * Plays one step. Answers with a stop reason only
   * where the step is the end of the turn.
   */
  async function play(
    step: ScenarioStep,
    session: Session,
    sessionId: string,
    client: AgentContext,
  ): Promise<StopReason | undefined> {
    switch (step.kind) {
      case 'update':
        await send(client, sessionId, updateFrom(step));

        return undefined;

      case 'readResource': {
        said('mcp/resources/read', { server: step.server, uri: step.uri });

        const outcome = await peerFor(session, step.server).readResource(
          step.uri,
        );

        if (!outcome.ok) {
          throw RequestError.internalError(
            undefined,
            `reading \`${step.uri}\` from \`${step.server}\` failed: ` +
              outcome.detail,
          );
        }

        return undefined;
      }

      case 'toolCall': {
        const toolCallId = nextToolCallId(session);

        await send(client, sessionId, {
          sessionUpdate: 'tool_call',
          toolCallId,
          title: step.title,
          kind: step.toolKind,
          status: 'pending',
          rawInput: step.args,
        });

        said('mcp/tools/call', {
          server: step.server,
          name: step.tool,
          arguments: step.args,
        });

        const outcome = await peerFor(session, step.server).callTool(
          step.tool,
          step.args,
        );

        if (!outcome.ok) {
          await send(client, sessionId, {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'failed',
          });

          throw RequestError.internalError(
            undefined,
            `\`${step.tool}\` failed: ${outcome.detail}`,
          );
        }

        await send(client, sessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'completed',
          content: diffContent(session.cwd, step.diffs),
        });

        return undefined;
      }

      case 'requestPermission': {
        const toolCallId = nextToolCallId(session);

        await send(client, sessionId, {
          sessionUpdate: 'tool_call',
          toolCallId,
          title: step.title,
          kind: step.toolKind,
          status: 'pending',
        });

        // The question names the call it is about.
        // `ToolCall` and `ToolCallUpdate` overlap
        // but are not the same shape — a title is
        // required of one and optional on the other
        // — so the card and the question are built
        // separately rather than spread from one.
        const toolCall: ToolCallUpdate = {
          toolCallId,
          title: step.title,
          kind: step.toolKind,
          status: 'pending',
        };

        said('session/request_permission', {
          sessionId,
          toolCall,
          options: step.options,
        });

        const answer = await client.request('session/request_permission', {
          sessionId,
          toolCall,
          options: step.options,
        });

        await send(client, sessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: allowed(step.options, answer) ? 'completed' : 'failed',
        });

        return undefined;
      }

      case 'readTextFile': {
        const path = resolve(session.cwd, step.path);

        said('fs/read_text_file', { sessionId, path });
        await client.request('fs/read_text_file', { sessionId, path });

        return undefined;
      }

      case 'stopTurn':
        return step.stopReason;
    }
  }

  /**
   * Runs a scenario to its end, or to wherever a
   * cancel caught it.
   *
   * The check sits at the top of each step rather
   * than inside them: a cancel arrives while the
   * agent is waiting on the editor for something —
   * a permission answer, a file — and stopping
   * before the next step is what "abort the replay"
   * means with nothing else in flight.
   */
  async function replay(
    scenario: Scenario,
    session: Session,
    sessionId: string,
    client: AgentContext,
  ): Promise<StopReason> {
    for (const step of scenario.steps) {
      if (session.cancelled) return 'cancelled';

      const stop = await play(step, session, sessionId, client);
      if (stop !== undefined) return stop;
    }

    return session.cancelled ? 'cancelled' : 'end_turn';
  }

  return agent({ name: AGENT_NAME })
    .onConnect((connection) => {
      // An MCP server this agent started has nothing
      // left to serve once the editor has gone, and
      // it is a whole bundled compiler sitting in
      // memory. Both outcomes are the same clean-up,
      // so both are handled.
      const done = (): void => {
        for (const session of sessions.values()) {
          for (const peer of session.peers.values()) void peer.close();
        }

        sessions.clear();
      };

      connection.closed.then(done, done);
    })
    .onRequest('initialize', ({ params }) => {
      heard('initialize', params);

      // Nothing beyond the version is claimed. This
      // agent loads no session, and it has no use
      // for a terminal the extension does not offer.
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false },
        agentInfo: { name: AGENT_NAME, version: '1' },
      };
    })
    .onRequest('session/new', async ({ params }) => {
      heard('session/new', params);

      opened += 1;
      const sessionId = `session-${opened}`;
      const peers = new Map<string, McpPeer>();

      for (const server of params.mcpServers) {
        const descriptor = stdioDescriptor(server);

        said('mcp/connect', descriptor);
        peers.set(descriptor.name, await connect(descriptor, params.cwd));
      }

      sessions.set(sessionId, {
        cwd: params.cwd,
        peers,
        cancelled: false,
        toolCalls: 0,
      });

      return { sessionId };
    })
    .onRequest('session/prompt', async ({ params, client }) => {
      heard('session/prompt', params);

      const session = sessions.get(params.sessionId);
      if (session === undefined) {
        throw RequestError.invalidParams(
          undefined,
          `there is no session called \`${params.sessionId}\``,
        );
      }

      const asked = promptText(params.prompt);
      const scenario = byPrompt.get(asked);
      if (scenario === undefined) {
        throw RequestError.invalidParams(
          undefined,
          nothingScripted(asked, [...byPrompt.keys()]),
        );
      }

      session.cancelled = false;

      return {
        stopReason: await replay(scenario, session, params.sessionId, client),
      };
    })
    .onNotification('session/cancel', ({ params }) => {
      heard('session/cancel', params);

      const session = sessions.get(params.sessionId);
      if (session !== undefined) session.cancelled = true;
    });
}

/** One open session and what it is in the middle of. */
type Session = {
  cwd: string;

  peers: Map<string, McpPeer>;

  cancelled: boolean;

  toolCalls: number;
};

/**
 * Tool call ids count from one, per session.
 *
 * A random id would be the shortest route to a
 * transcript that differs between two identical
 * runs, which is the one thing this fixture may not
 * do.
 */
function nextToolCallId(session: Session): string {
  session.toolCalls += 1;

  return `tool-${session.toolCalls}`;
}

function peerFor(session: Session, name: string): McpPeer {
  const peer = session.peers.get(name);

  if (peer === undefined) {
    throw RequestError.internalError(
      undefined,
      `this session was given no MCP server called \`${name}\``,
    );
  }

  return peer;
}

/**
 * The stdio member of the server union.
 *
 * Every other transport carries a `type`
 * discriminant and the bare object is stdio, which
 * is what the extension sends and all this agent
 * knows how to start.
 */
function stdioDescriptor(server: McpServer): McpServerDescriptor {
  if (!('command' in server)) {
    throw RequestError.invalidParams(
      undefined,
      `\`${server.name}\` is not a stdio MCP server, and this agent starts ` +
        `nothing else`,
    );
  }

  return {
    name: server.name,
    command: server.command,
    args: [...server.args],
    env: server.env.map(({ name, value }) => ({ name, value })),
  };
}

/**
 * The real MCP client, spawning the server the
 * session was handed.
 *
 * `cwd` is the session's project: the mBoss server
 * resolves which project it is serving by walking
 * up from its own working directory, so starting it
 * anywhere else would point it at nothing.
 *
 * An empty environment list means "add nothing",
 * not "run with nothing" — a server started with a
 * stripped environment cannot find its own
 * interpreter.
 */
async function connectOverStdio(
  server: McpServerDescriptor,
  cwd: string,
): Promise<McpPeer> {
  const client = new Client({ name: AGENT_NAME, version: '1' });

  await client.connect(
    new StdioClientTransport({
      command: server.command,
      args: server.args,
      cwd,
      env: {
        ...getDefaultEnvironment(),
        ...Object.fromEntries(
          server.env.map(({ name, value }) => [name, value]),
        ),
      },
    }),
  );

  return {
    callTool: async (name, args) => {
      const result = await client.callTool({ name, arguments: args });

      return result.isError === true
        ? {
            ok: false,
            detail: JSON.stringify(result.structuredContent ?? result.content),
          }
        : { ok: true };
    },

    readResource: async (uri) => {
      try {
        await client.readResource({ uri });

        return { ok: true };
      } catch (cause) {
        return { ok: false, detail: String(cause) };
      }
    },

    close: () => client.close(),
  };
}

function updateFrom(
  step: Extract<ScenarioStep, { kind: 'update' }>,
): SessionUpdate {
  if (step.sessionUpdate === 'plan') {
    return {
      sessionUpdate: 'plan',
      entries: step.entries.map((content) => ({
        content,
        priority: 'medium',
        status: 'pending',
      })),
    };
  }

  return {
    sessionUpdate: step.sessionUpdate,
    content: { type: 'text', text: step.text },
  };
}

function diffContent(cwd: string, diffs: ScenarioDiff[]): ToolCallContent[] {
  return diffs.map((diff) => ({
    type: 'diff',
    path: resolve(cwd, diff.path),
    ...(diff.oldText === undefined ? {} : { oldText: diff.oldText }),
    newText: diff.newText,
  }));
}

/**
 * Whether the answer was a yes.
 *
 * The option's own `kind` decides it, never the
 * `optionId`: ids are the agent's to invent, and
 * here the agent invented them, so reading the kind
 * is the only version of this that would still be
 * right against a different set.
 */
function allowed(
  options: PermissionOption[],
  answer: RequestPermissionResponse,
): boolean {
  const outcome = answer.outcome;
  if (outcome.outcome !== 'selected') return false;

  const chosen = options.find((option) => option.optionId === outcome.optionId);

  return chosen?.kind === 'allow_once' || chosen?.kind === 'allow_always';
}

/** What the user typed, out of the blocks it arrived in. */
function promptText(blocks: ContentBlock[]): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function nothingScripted(asked: string, known: readonly string[]): string {
  return (
    `no scenario answers this prompt: ${asked}\n` +
    `the scenarios loaded answer:\n${known.map((prompt) => `  ${prompt}`).join('\n')}`
  );
}

/** A value that has to be an object, or a named failure. */
function fields(
  where: string,
  value: unknown,
  what: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where}: is not ${what}`);
  }

  return value as Record<string, unknown>;
}

function textOf(
  where: string,
  source: Record<string, unknown>,
  field: string,
): string {
  const value = source[field];

  if (typeof value !== 'string' || value === '') {
    throw new Error(`${where}: \`${field}\` has to be a non-empty string`);
  }

  return value;
}

function listOf(
  where: string,
  source: Record<string, unknown>,
  field: string,
): unknown[] {
  const value = source[field];

  if (!Array.isArray(value)) {
    throw new Error(`${where}: \`${field}\` has to be an array`);
  }

  return value;
}

/** A field that may be absent, with what to use then. */
function textOrElse(
  where: string,
  source: Record<string, unknown>,
  field: string,
  fallback: string,
): string {
  return source[field] === undefined ? fallback : textOf(where, source, field);
}

const TOOL_KINDS = new Set<string>([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
]);

const STOP_REASONS = new Set<string>([
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
]);

const PERMISSION_KINDS = new Set<string>([
  'allow_once',
  'allow_always',
  'reject_once',
  'reject_always',
]);

async function parseStep(
  where: string,
  base: string,
  raw: unknown,
): Promise<ScenarioStep> {
  const step = fields(where, raw, 'a step');
  const kind = textOf(where, step, 'kind');

  switch (kind) {
    case 'update':
      return parseUpdate(where, step);

    case 'readResource':
      return {
        kind: 'readResource',
        server: textOrElse(where, step, 'server', 'mboss'),
        uri: textOf(where, step, 'uri'),
      };

    case 'toolCall': {
      const tool = textOf(where, step, 'tool');

      return {
        kind: 'toolCall',
        server: textOrElse(where, step, 'server', 'mboss'),
        tool,
        title: textOrElse(where, step, 'title', tool),
        toolKind: parseToolKind(where, step),
        args: fields(
          where,
          await readReferences(where, base, step.args ?? {}),
          'an object of arguments',
        ),
        diffs: parseDiffs(where, step),
      };
    }

    case 'requestPermission':
      return {
        kind: 'requestPermission',
        title: textOf(where, step, 'title'),
        toolKind: parseToolKind(where, step),
        options: parseOptions(where, step),
      };

    case 'readTextFile':
      return { kind: 'readTextFile', path: textOf(where, step, 'path') };

    case 'stopTurn': {
      const stopReason = textOrElse(where, step, 'stopReason', 'end_turn');

      if (!STOP_REASONS.has(stopReason)) {
        throw new Error(`${where}: \`${stopReason}\` is not a stop reason`);
      }

      return { kind: 'stopTurn', stopReason: stopReason as StopReason };
    }

    default:
      throw new Error(`${where}: unknown step kind \`${kind}\``);
  }
}

function parseUpdate(
  where: string,
  step: Record<string, unknown>,
): ScenarioStep {
  const sessionUpdate = textOf(where, step, 'sessionUpdate');

  if (sessionUpdate === 'plan') {
    return {
      kind: 'update',
      sessionUpdate: 'plan',
      entries: listOf(where, step, 'entries').map((entry, index) => {
        if (typeof entry !== 'string' || entry === '') {
          throw new Error(`${where}: plan entry ${index + 1} is not text`);
        }

        return entry;
      }),
    };
  }

  if (
    sessionUpdate !== 'agent_message_chunk' &&
    sessionUpdate !== 'agent_thought_chunk'
  ) {
    throw new Error(
      `${where}: \`${sessionUpdate}\` is not an update this agent sends`,
    );
  }

  return { kind: 'update', sessionUpdate, text: textOf(where, step, 'text') };
}

function parseToolKind(where: string, step: Record<string, unknown>): ToolKind {
  const toolKind = textOrElse(where, step, 'toolKind', 'other');

  if (!TOOL_KINDS.has(toolKind)) {
    throw new Error(`${where}: \`${toolKind}\` is not a tool kind`);
  }

  return toolKind as ToolKind;
}

function parseDiffs(
  where: string,
  step: Record<string, unknown>,
): ScenarioDiff[] {
  if (step.diffs === undefined) return [];

  return listOf(where, step, 'diffs').map((raw, index) => {
    const diff = fields(`${where}: diff ${index + 1}`, raw, 'a diff');
    const at = `${where}: diff ${index + 1}`;

    return {
      path: textOf(at, diff, 'path'),
      ...(diff.oldText === undefined
        ? {}
        : { oldText: textOf(at, diff, 'oldText') }),
      newText: textOf(at, diff, 'newText'),
    };
  });
}

function parseOptions(
  where: string,
  step: Record<string, unknown>,
): PermissionOption[] {
  return listOf(where, step, 'options').map((raw, index) => {
    const at = `${where}: option ${index + 1}`;
    const option = fields(at, raw, 'a permission option');
    const kind = textOf(at, option, 'kind');

    if (!PERMISSION_KINDS.has(kind)) {
      throw new Error(`${at}: \`${kind}\` is not a permission option kind`);
    }

    return {
      optionId: textOf(at, option, 'optionId'),
      name: textOf(at, option, 'name'),
      kind: kind as PermissionOption['kind'],
    };
  });
}

/**
 * Reads in every `{ "$file": "…" }` a value
 * contains.
 *
 * References resolve against the file that wrote
 * them, not the working directory, so a scenario
 * says where its spec is relative to itself and
 * keeps saying it from wherever the agent is
 * started.
 */
async function readReferences(
  where: string,
  base: string,
  value: unknown,
): Promise<unknown> {
  if (Array.isArray(value)) {
    return await Promise.all(
      value.map((each) => readReferences(where, base, each)),
    );
  }

  if (typeof value !== 'object' || value === null) return value;

  const source = value as Record<string, unknown>;
  const reference = source.$file;

  if (typeof reference === 'string') {
    const path = resolve(base, reference);
    const text = await readFile(path, 'utf8').catch((cause: unknown) => {
      throw new Error(`${where}: cannot read ${path}`, { cause });
    });

    try {
      return await readReferences(where, dirname(path), JSON.parse(text));
    } catch (cause) {
      throw new Error(`${where}: ${path} is not JSON`, { cause });
    }
  }

  const read: Record<string, unknown> = {};
  for (const [key, each] of Object.entries(source)) {
    read[key] = await readReferences(where, base, each);
  }

  return read;
}

async function main(): Promise<void> {
  const app = createFakeAcpAgent({
    scenarios: await loadScenarios(),
    transcript: transcriptFrom(process.env),
  });

  const connection = app.connect(
    ndJsonStream(
      Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    ),
  );

  await connection.closed;
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  import.meta.url === pathToFileURL(entryPoint).href
)
  await main();

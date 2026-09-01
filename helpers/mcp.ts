import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import type {
  CallToolResult,
  ReadResourceResult,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

/**
 * Talking to the shipped MCP bundle the way an
 * agent does.
 *
 * The artifact under test is the single file
 * `mboss-mcp-server` builds and a project vendors —
 * not its source. So this spawns it with the
 * host's own Node and speaks the protocol over
 * stdio with the official SDK's client, which is
 * the only arrangement that can catch a tool
 * tree-shaken out of the bundle or a handler that
 * only resolves next to its own repository.
 *
 * Nothing here imports `mboss-mcp-server`'s
 * TypeScript. The nested checkout is a build
 * context, the same as the three service repos —
 * a harness that imported the server's own
 * `errorCodeOf` would stop testing that the code
 * survives the wire.
 */

/**
 * The bundle the specs drive. Env-overridable like
 * every other address here, so a build somewhere
 * else can be pointed at without editing a spec.
 */
export const E2E_MCP_BUNDLE =
  process.env.E2E_MCP_BUNDLE ??
  fileURLToPath(new URL('../mboss-mcp-server/dist/server.js', import.meta.url));

/**
 * The one line beside it. A scaffolded project gets
 * both, at `.mboss/mcp/`, which is how the
 * extension will later tell a vendored copy from
 * the current build.
 */
export const E2E_MCP_VERSION = join(dirname(E2E_MCP_BUNDLE), 'VERSION');

/** What builds it, named in the failure that wants it. */
export const MCP_BUILD_COMMAND = 'npm run mcp:build';

/**
 * Proves the bundle is there before any spec talks
 * to it.
 *
 * Building it here instead would bury an `npm ci`
 * and an esbuild run behind Playwright's reporter,
 * which is the same reason global setup does not
 * bring the compose stack up either. A missing
 * artifact is one sentence naming the command that
 * makes it.
 */
export async function assertBundleBuilt(): Promise<void> {
  try {
    await access(E2E_MCP_BUNDLE);
  } catch (cause) {
    throw new Error(
      `the MCP bundle is not built at ${E2E_MCP_BUNDLE} — ` +
        `run \`${MCP_BUILD_COMMAND}\``,
      { cause },
    );
  }
}

/** A connected client and the child process behind it. */
export type McpSession = {
  client: Client;
  close(): Promise<void>;
};

/**
 * A server process rooted at `cwd`, and a client
 * talking to it.
 *
 * The bundle resolves the project from its own
 * working directory — an agent starts it inside the
 * project it works on — so `cwd` is how a spec says
 * which project this session is about.
 *
 * `agent` is the client's own name. The server
 * records it on a proposal as who proposed the
 * edit, so a spec that cares can name itself.
 *
 * `server` is which copy of the bundle to run. It
 * defaults to the build, and the durability spec
 * passes the copy vendored into the project it
 * scaffolded — the file at the path a real project
 * runs it from, which is a stronger thing to have
 * driven than the build directory.
 */
export async function connectToBundle(
  cwd: string,
  agent = 'the e2e suite',
  server = E2E_MCP_BUNDLE,
): Promise<McpSession> {
  const client = new Client({ name: agent, version: '0.0.0' });

  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [server],
      cwd,
    }),
  );

  return { client, close: () => client.close() };
}

/** A tool call that failed, named by its code. */
export class McpToolError extends Error {
  readonly code: string;
  readonly result: CallToolResult;

  constructor(code: string, result: CallToolResult) {
    super(`the tool call failed: ${JSON.stringify(result.structuredContent)}`);
    this.name = 'McpToolError';
    this.code = code;
    this.result = result;
  }
}

/**
 * The code carried by a failed tool result, or
 * `undefined` when the call succeeded.
 *
 * The server puts the code in both channels
 * deliberately, so both are read: a client that
 * dropped the structured half would otherwise make
 * every error assertion here vacuous.
 *
 * Not every failure has a code. A handler that
 * throws arrives as the sentence it was thrown
 * with and nothing else, which is an answer of
 * `undefined` rather than something to fail on —
 * this runs on whatever a spec got back, including
 * the results nobody planned for.
 */
export function errorCodeOf(result: CallToolResult): string | undefined {
  if (result.isError !== true) return undefined;

  const structured = codeOf(result.structuredContent);
  if (structured !== undefined) return structured;

  const [block] = result.content ?? [];

  return block?.type === 'text' ? codeOf(parsed(block.text)) : undefined;
}

/** JSON, or nothing when the text was never JSON. */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The structured output of a call that was meant to
 * succeed.
 *
 * A failure throws naming its code, so a spec fails
 * on the call that went wrong rather than two
 * assertions later on a field that is undefined.
 */
export function outputOf<T>(result: CallToolResult): T {
  const code = errorCodeOf(result);
  if (code !== undefined) throw new McpToolError(code, result);

  if (result.isError === true) {
    throw new Error(
      `the tool call failed with no code: ${JSON.stringify(result.content)}`,
    );
  }

  return result.structuredContent as T;
}

/**
 * The body of a resource read, with the media
 * type it declared.
 */
export function textOf(read: ReadResourceResult): {
  mimeType?: string;
  text: string;
} {
  const [body] = read.contents;
  if (body === undefined || !('text' in body)) {
    throw new Error('the read came back with no text');
  }

  return { mimeType: body.mimeType, text: body.text };
}

function codeOf(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;

  const { code } = value as { code?: unknown };

  return typeof code === 'string' ? code : undefined;
}

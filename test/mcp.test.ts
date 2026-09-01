import type { CallToolResult } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';

import {
  E2E_MCP_BUNDLE,
  McpToolError,
  errorCodeOf,
  outputOf,
  textOf,
} from '../helpers/mcp.js';

/**
 * The parts of the MCP helper that need no server:
 * reading a coded failure back out of a tool
 * result, and reading a resource's body out of a
 * read.
 *
 * These run in the hermetic job, on a checkout with
 * no submodules — so nothing here may touch the
 * bundle, only name where it will be.
 */

/** A failure as sent: the code in both channels. */
function failed(code: string, detail: object = {}): CallToolResult {
  const error = { code, ...detail };

  return {
    isError: true,
    structuredContent: { ...error },
    content: [{ type: 'text', text: JSON.stringify(error) }],
  };
}

function succeeded(value: object): CallToolResult {
  return {
    structuredContent: { ...value },
    content: [{ type: 'text', text: JSON.stringify(value) }],
  };
}

describe('errorCodeOf', () => {
  it('reads the code out of the structured channel', () => {
    expect(errorCodeOf(failed('WORKFLOW_NOT_FOUND', { name: 'nope' }))).toBe(
      'WORKFLOW_NOT_FOUND',
    );
  });

  /**
   * The two channels carry the same code so that a
   * client dropping either one still yields it. A
   * helper that only read the structured half would
   * make that redundancy untested.
   */
  it('falls back to the text block', () => {
    const only = {
      isError: true,
      content: [
        { type: 'text' as const, text: '{"code":"REVISION_CONFLICT"}' },
      ],
    };

    expect(errorCodeOf(only)).toBe('REVISION_CONFLICT');
  });

  it('says nothing about a result that succeeded', () => {
    expect(errorCodeOf(succeeded({ revision: 2 }))).toBeUndefined();
  });

  /**
   * Plenty of the server's failures carry no code:
   * a handler that throws comes back through the
   * SDK as the one sentence it was thrown with and
   * no structured half at all. Every spec here runs
   * this on whatever it gets back, so it has to
   * answer "no code" rather than throw a
   * SyntaxError from under the assertion that was
   * asking what went wrong.
   */
  it('says nothing about a failure that is a plain sentence', () => {
    const thrown = {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: 'Give exactly one of `name` or `spec`.',
        },
      ],
    };

    expect(errorCodeOf(thrown)).toBeUndefined();
  });
});

describe('outputOf', () => {
  it('hands back the structured output', () => {
    expect(outputOf(succeeded({ revision: 2 }))).toEqual({ revision: 2 });
  });

  /**
   * A spec that meant to succeed and did not should
   * fail naming the code, not two assertions later
   * on an undefined field.
   */
  it('throws the code when the call failed', () => {
    expect(() => outputOf(failed('REVISION_CONFLICT', { actual: 3 }))).toThrow(
      McpToolError,
    );
    expect(() => outputOf(failed('REVISION_CONFLICT', { actual: 3 }))).toThrow(
      /REVISION_CONFLICT/,
    );
  });

  it('carries the code on the thrown error', () => {
    try {
      outputOf(failed('PROPOSAL_STALE', { currentRevision: 4 }));
      expect.unreachable('outputOf did not throw');
    } catch (error) {
      expect(error).toBeInstanceOf(McpToolError);
      expect((error as McpToolError).code).toBe('PROPOSAL_STALE');
    }
  });
});

describe('textOf', () => {
  it('reads a resource body and its media type', () => {
    expect(
      textOf({
        contents: [
          {
            uri: 'mboss://conventions',
            mimeType: 'text/markdown',
            text: '# Conventions\n',
          },
        ],
      }),
    ).toEqual({ mimeType: 'text/markdown', text: '# Conventions\n' });
  });

  it('refuses a read that came back with no text', () => {
    expect(() => textOf({ contents: [] })).toThrow(/no text/);
  });
});

describe('E2E_MCP_BUNDLE', () => {
  it('names the bundle inside the nested checkout', () => {
    expect(E2E_MCP_BUNDLE).toMatch(/mboss-mcp-server\/dist\/server\.js$/);
  });
});

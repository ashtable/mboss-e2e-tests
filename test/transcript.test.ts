import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, test } from 'vitest';

import type { TranscriptLine } from '../fixtures/fake-acp-agent/index.js';
import {
  promptBlocksSent,
  promptsSent,
  transcriptLines,
} from '../helpers/transcript.js';

/**
 * The two readers over a transcript, on lines
 * written by hand.
 *
 * Hand-written on purpose: what is under test is
 * how a spec reads a prompt back, and driving the
 * agent to produce one would make this a test of
 * the agent instead — which it already has.
 *
 * The two prompts here are the two shapes the
 * extension can send. One is a sentence on its own.
 * The other carries the evidence for what it is
 * asking about as its own block beside the words,
 * which is what an agent that said it takes
 * embedded context gets.
 */

const EVIDENCE = {
  type: 'resource',
  resource: {
    uri: 'mboss://run-evidence/abc',
    mimeType: 'application/json',
    text: '{"workflowId":"abc"}',
  },
};

const LINES: TranscriptLine[] = [
  {
    from: 'client',
    method: 'session/new',
    params: { cwd: '/tmp/project', mcpServers: [] },
  },
  {
    from: 'client',
    method: 'session/prompt',
    params: {
      sessionId: 'session-1',
      prompt: [{ type: 'text', text: 'what went wrong here?' }],
    },
  },
  {
    from: 'agent',
    method: 'session/update',
    params: { sessionId: 'session-1' },
  },
  {
    from: 'client',
    method: 'session/prompt',
    params: {
      sessionId: 'session-1',
      prompt: [{ type: 'text', text: 'and this run?' }, EVIDENCE],
    },
  },
];

let path = '';

beforeEach(async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'mboss-transcript-read-'));
  path = join(scratch, 'agent.jsonl');
  await writeFile(
    path,
    `${LINES.map((line) => JSON.stringify(line)).join('\n')}\n`,
  );
});

describe('reading prompts back', () => {
  /**
   * The words, which is what a spec asserting the
   * sentence the extension composed asks for. An
   * attachment is not words and does not appear.
   */
  test('gives the text of every prompt, in order', async () => {
    const lines = await transcriptLines(path);

    expect(promptsSent(lines)).toEqual([
      'what went wrong here?',
      'and this run?',
    ]);
  });

  /**
   * The shape, which is the question the words
   * cannot answer: whether anything rode beside
   * them, and what it was.
   */
  test('gives the blocks of every prompt, unflattened', async () => {
    const lines = await transcriptLines(path);

    expect(promptBlocksSent(lines)).toEqual([
      [{ type: 'text', text: 'what went wrong here?' }],
      [{ type: 'text', text: 'and this run?' }, EVIDENCE],
    ]);
  });

  /**
   * A line that is not a prompt the editor sent is
   * not a prompt, however it is read. Both readers
   * agree about which lines they are over, so a
   * spec can pair them up by position.
   */
  test('reads the same lines in both shapes', async () => {
    const lines = await transcriptLines(path);

    expect(promptBlocksSent(lines)).toHaveLength(promptsSent(lines).length);
  });
});

import { readFile } from 'node:fs/promises';

import type { TranscriptLine } from '../fixtures/fake-acp-agent/index.js';

/**
 * What the fake agent wrote down, read back.
 *
 * The transcript is the only record of what the
 * extension actually said over ACP, and it is the
 * only place a spec can see the half of the
 * conversation the extension starts on its own —
 * the approval prompt, which no webview draws and
 * no file records.
 *
 * It holds requests and never responses, which is
 * what makes it stable enough to assert on: every
 * response carries a minted proposal id or an
 * absolute temporary path. So a spec asks about
 * `from`, `method` and `params`, and there is no
 * `result` to ask about.
 */

/**
 * Every line, oldest first.
 *
 * A transcript the agent has not written yet is no
 * lines rather than an error: the agent starts on
 * the first thing somebody types, so a spec
 * polling for a turn to finish asks before the file
 * exists.
 */
export async function transcriptLines(path: string): Promise<TranscriptLine[]> {
  let text: string;

  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }

  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as TranscriptLine);
}

/**
 * Everything the editor sent as a prompt, in order,
 * flattened to the text a person would read.
 *
 * An ACP prompt is a list of content blocks and the
 * words are only some of them. Joining the text
 * ones and dropping the rest is what a spec about
 * the sentence wants; a spec about what rode beside
 * it reads `promptBlocksSent` instead.
 */
export function promptsSent(lines: readonly TranscriptLine[]): string[] {
  return lines
    .filter(
      (line) => line.from === 'client' && line.method === 'session/prompt',
    )
    .map((line) => textOf(line.params));
}

/**
 * The blocks of every prompt the editor sent, in
 * order and unflattened.
 *
 * `promptsSent` reads the words; this reads the
 * shape. An evidence attachment rides beside the
 * words as its own block, and a spec asking whether
 * it was attached at all has nothing to read in the
 * joined text.
 */
export function promptBlocksSent(
  lines: readonly TranscriptLine[],
): unknown[][] {
  return lines
    .filter(
      (line) => line.from === 'client' && line.method === 'session/prompt',
    )
    .map((line) => blocksOf(line.params));
}

function textOf(params: unknown): string {
  if (params === null || typeof params !== 'object') return '';

  const { prompt } = params as { prompt?: unknown };
  if (!Array.isArray(prompt)) return '';

  return prompt
    .map((block: unknown) =>
      block !== null && typeof block === 'object' && 'text' in block
        ? String((block as { text: unknown }).text)
        : '',
    )
    .join('');
}

/**
 * The blocks of one prompt, or none when the line
 * carried something else. Never a throw: a spec
 * reading a transcript is usually mid-poll, and a
 * malformed line should fail the assertion it is
 * about rather than the read.
 */
function blocksOf(params: unknown): unknown[] {
  if (params === null || typeof params !== 'object') return [];

  const { prompt } = params as { prompt?: unknown };

  return Array.isArray(prompt) ? prompt : [];
}

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
 * An ACP prompt is a list of content blocks; the
 * extension only ever sends one text block, and
 * joining them keeps that an observation rather
 * than an assumption a spec would break on.
 */
export function promptsSent(lines: readonly TranscriptLine[]): string[] {
  return lines
    .filter(
      (line) => line.from === 'client' && line.method === 'session/prompt',
    )
    .map((line) => textOf(line.params));
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

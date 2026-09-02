import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, test } from 'vitest';

import {
  createFakeAcpAgent,
  loadScenario,
  SCENARIOS_DIR,
  TRANSCRIPT_ENV,
  transcriptFrom,
  type TranscriptLine,
} from '../fixtures/fake-acp-agent/index.js';
import { drive } from './support/acp-client.js';

/**
 * The transcript, which is the only channel the
 * extension suite has for what the agent side of a
 * conversation did.
 *
 * One JSON object per line, written the moment it
 * happens. Buffering would buy nothing a fixture
 * can notice and would put "did it flush?" between
 * a failing assertion and the truth, so the writer
 * appends synchronously and there is nothing left
 * to flush at exit.
 */

let scratch = '';

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'mboss-transcript-'));
});

function linesOf(text: string): TranscriptLine[] {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as TranscriptLine);
}

describe('the writer', () => {
  test('appends one JSON object per line', async () => {
    const path = join(scratch, 'agent.jsonl');
    const transcript = transcriptFrom({ [TRANSCRIPT_ENV]: path });

    transcript.record({ from: 'client', method: 'initialize', params: {} });
    transcript.record({
      from: 'agent',
      method: 'session/update',
      params: { sessionId: 'session-1' },
    });

    const text = await readFile(path, 'utf8');

    expect(text.endsWith('\n')).toBe(true);
    expect(linesOf(text)).toEqual([
      { from: 'client', method: 'initialize', params: {} },
      {
        from: 'agent',
        method: 'session/update',
        params: { sessionId: 'session-1' },
      },
    ]);
  });

  test('a line is on disk before the next one is written', async () => {
    const path = join(scratch, 'agent.jsonl');
    const transcript = transcriptFrom({ [TRANSCRIPT_ENV]: path });

    transcript.record({ from: 'client', method: 'initialize', params: {} });
    expect(linesOf(await readFile(path, 'utf8'))).toHaveLength(1);

    transcript.record({ from: 'client', method: 'session/new', params: {} });
    expect(linesOf(await readFile(path, 'utf8'))).toHaveLength(2);
  });

  test('keeps what an earlier run wrote to the same file', async () => {
    const path = join(scratch, 'agent.jsonl');
    await writeFile(path, '{"from":"client","method":"initialize"}\n', 'utf8');

    transcriptFrom({ [TRANSCRIPT_ENV]: path }).record({
      from: 'agent',
      method: 'session/update',
      params: {},
    });

    expect(linesOf(await readFile(path, 'utf8'))).toHaveLength(2);
  });

  test('writes nothing at all with the variable unset', async () => {
    const transcript = transcriptFrom({});

    transcript.record({ from: 'client', method: 'initialize', params: {} });

    expect(await readdir(scratch)).toEqual([]);
  });

  test('writes nothing at all with the variable empty', async () => {
    const transcript = transcriptFrom({ [TRANSCRIPT_ENV]: '' });

    transcript.record({ from: 'client', method: 'initialize', params: {} });

    expect(await readdir(scratch)).toEqual([]);
  });
});

describe('what the agent records', () => {
  test('both halves of a whole conversation, in order', async () => {
    const path = join(scratch, 'agent.jsonl');
    const scenario = await loadScenario(
      join(SCENARIOS_DIR, 'fs-read.scenario.json'),
    );

    const peer = drive(
      createFakeAcpAgent({
        scenarios: [scenario],
        transcript: transcriptFrom({ [TRANSCRIPT_ENV]: path }),
      }),
    );

    await peer.initialize();
    const sessionId = await peer.open({ cwd: '/tmp/project', mcpServers: [] });
    await peer.prompt(sessionId, scenario.prompt);
    peer.close();

    const lines = linesOf(await readFile(path, 'utf8'));

    expect(lines.map((line) => `${line.from} ${line.method}`)).toEqual([
      'client initialize',
      'client session/new',
      'client session/prompt',
      'agent session/update',
      'agent fs/read_text_file',
      'agent session/update',
    ]);
  });

  test('nothing is written when no transcript was asked for', async () => {
    const scenario = await loadScenario(
      join(SCENARIOS_DIR, 'fs-read.scenario.json'),
    );

    const peer = drive(createFakeAcpAgent({ scenarios: [scenario] }));

    await peer.initialize();
    const sessionId = await peer.open({ cwd: '/tmp/project', mcpServers: [] });
    await peer.prompt(sessionId, scenario.prompt);
    peer.close();

    expect(existsSync(join(scratch, 'agent.jsonl'))).toBe(false);
  });
});

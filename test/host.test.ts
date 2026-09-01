import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, test } from 'vitest';

import { startHostProcess, waitForAnswer } from '../helpers/host.js';

/**
 * The half of the durability spec that has nothing
 * to do with mBoss: starting something on this
 * machine, waiting for it to answer, and taking it
 * away without warning.
 *
 * All of it runs against `node -e` scripts, so it
 * belongs in the hermetic job — and it needs to be
 * there, because the one thing the spec cannot
 * check about its own kill is that the kill worked.
 * A helper that left the app alive would show up as
 * a durability test that passed without ever
 * crashing anything.
 */

/** Whether a pid is still a live process. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;

  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await delay(20);
  }

  return !alive(pid);
}

function node(script: string) {
  return startHostProcess({
    command: process.execPath,
    args: ['-e', script],
    cwd: process.cwd(),
  });
}

describe('startHostProcess', () => {
  test('collects everything the process printed', async () => {
    const started = node(
      'console.log("out"); console.error("err"); process.exit(0)',
    );

    await started.exited;

    expect(started.output()).toContain('out');
    expect(started.output()).toContain('err');
  });

  /**
   * A polite stop is not what this spec does. The
   * app installs a SIGTERM handler that closes the
   * listener and shuts DBOS down cleanly — which is
   * exactly the shutdown a durability test must not
   * perform, so the kill has to be one nothing can
   * catch.
   */
  test('kills a process that ignores every polite signal', async () => {
    const started = node(
      'process.on("SIGTERM", () => {}); process.on("SIGINT", () => {}); ' +
        'setInterval(() => {}, 1000)',
    );

    await started.kill();

    expect(alive(started.pid)).toBe(false);
  });

  /**
   * The generated app runs under a launcher that
   * spawns the process doing the work, so killing
   * only what was started here would leave the app
   * itself running and the crash imaginary. The
   * process gets its own group and the group is
   * what is killed.
   */
  test('takes the processes it started with it', async () => {
    const started = node(
      'const { spawn } = require("node:child_process"); ' +
        'const child = spawn(process.execPath, ' +
        '["-e", "setInterval(() => {}, 1000)"]); ' +
        'console.log(child.pid); setInterval(() => {}, 1000)',
    );

    const deadline = Date.now() + 10_000;
    while (started.output().trim() === '' && Date.now() < deadline) {
      await delay(20);
    }
    const child = Number(started.output().trim());
    expect(child).toBeGreaterThan(0);

    await started.kill();

    expect(await goneWithin(child, 5_000)).toBe(true);
  });

  test('says nothing about a kill of something already gone', async () => {
    const started = node('process.exit(0)');
    await started.exited;

    await expect(started.kill()).resolves.toBeUndefined();
  });
});

describe('waitForAnswer', () => {
  test('returns once the process answers', async () => {
    const started = node(
      'require("node:http").createServer((_, res) => res.end("ok"))' +
        '.listen(38431, "127.0.0.1")',
    );

    try {
      await waitForAnswer(started, 'http://127.0.0.1:38431/', 'the probe', {
        timeoutMs: 10_000,
      });
    } finally {
      await started.kill();
    }
  });

  /**
   * A process that dies on start-up has already
   * said why, on its own stderr. Waiting out the
   * timeout and reporting a bare "never answered"
   * would throw that away — and it is the sentence
   * that explains the whole failure.
   */
  test('fails with what the process printed when it dies first', async () => {
    const started = node(
      'console.error("invalid environment: EVENTS_SECRET"); process.exit(1)',
    );

    await expect(
      waitForAnswer(started, 'http://127.0.0.1:38432/', 'the probe', {
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow(/EVENTS_SECRET/);
  });

  test('names what it was waiting for when nothing answers', async () => {
    const started = node('setInterval(() => {}, 1000)');

    try {
      await expect(
        waitForAnswer(started, 'http://127.0.0.1:38433/', 'the probe', {
          timeoutMs: 300,
        }),
      ).rejects.toThrow(/the probe/);
    } finally {
      await started.kill();
    }
  });
});

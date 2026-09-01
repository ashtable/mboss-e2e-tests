import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Long-running processes on this machine, rather
 * than in a container.
 *
 * The durability spec runs the generated app as a
 * host process on purpose: `kill -9` against a
 * container is a message to a daemon, and what has
 * to be proved is that a run survives the operating
 * system taking the process away mid-flight. The
 * mail sink runs the same way, so both reach each
 * other on loopback and neither is a compose
 * service.
 *
 * Everything here is about the mechanism and knows
 * nothing about what is being run.
 */

export type HostProcess = {
  readonly pid: number;
  /** Everything it has written to either stream,
   *  in arrival order. */
  output(): string;
  /**
   * SIGKILL to the whole process group, resolving
   * once it is gone. Killing a process that has
   * already exited is not an error.
   */
  kill(): Promise<void>;
  /** Resolves with the exit code when it stops on
   *  its own. */
  exited: Promise<number | null>;
};

export type StartOptions = {
  command: string;
  args: string[];
  cwd: string;
  /** Added to this process's environment. */
  env?: Record<string, string>;
};

/**
 * Starts a process in a group of its own.
 *
 * `detached` is not about outliving this process —
 * it is what makes the child a group leader, so
 * that one signal reaches it *and* whatever it
 * started. Node run through a launcher is two
 * processes, and killing only the first leaves the
 * second serving requests.
 */
export function startHostProcess(options: StartOptions): HostProcess {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let captured = '';
  const collect = (chunk: Buffer): void => {
    captured += chunk.toString('utf8');
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => {
      resolve(code);
    });
  });

  // Nothing here treats a spawn failure as fatal on
  // its own: what the caller is really waiting for
  // is the process answering, and `waitForAnswer`
  // reports the failure with the output beside it.
  child.on('error', collect);

  const pid = child.pid ?? -1;

  return {
    pid,
    output: () => captured,
    exited,
    async kill() {
      try {
        // The negative pid is the group. Reachable
        // because `detached` made this process its
        // leader.
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Already gone, or never started. Either
        // way there is nothing to kill and the
        // caller wanted it dead.
      }

      await exited;
    },
  };
}

export type WaitOptions = {
  timeoutMs?: number;
  /** Between attempts. */
  intervalMs?: number;
};

/**
 * Waits for a process to answer an address.
 *
 * A poll rather than a sleep, and it watches the
 * process as well as the socket: a generated app
 * that refuses to boot has already printed the
 * reason, and reporting a bare timeout instead of
 * that sentence turns a two-second diagnosis into
 * an afternoon.
 */
export async function waitForAnswer(
  running: HostProcess,
  url: string,
  what: string,
  options: WaitOptions = {},
): Promise<void> {
  const { timeoutMs = 60_000, intervalMs = 250 } = options;
  const deadline = Date.now() + timeoutMs;
  let dead = false;
  void running.exited.then(() => {
    dead = true;
  });

  for (;;) {
    try {
      const response = await fetch(url);
      await response.arrayBuffer();
      if (response.ok) return;
    } catch {
      // Not up yet. The deadline below is what
      // decides when that stops being acceptable.
    }

    if (dead) {
      throw new Error(
        `${what} exited before it answered at ${url}:\n${running.output()}`,
      );
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `${what} never answered at ${url} within ${timeoutMs}ms:\n` +
          running.output(),
      );
    }

    await delay(intervalMs);
  }
}

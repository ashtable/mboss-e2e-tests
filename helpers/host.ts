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
 *
 * The process is watched on the way *out* too. A
 * server a previous run left behind answers the
 * port just as well as the one started here, so
 * asking only the socket would report success while
 * handing back a process that died on EADDRINUSE —
 * and the spec would then spend its run talking to
 * the previous run's server, under the previous
 * run's credentials.
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
      if (response.ok && !dead) return;
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

/**
 * Starts a process and waits for it to answer,
 * taking it away again if it never does.
 *
 * The wait is what decides whether a start
 * succeeded, so it is also what has to clean up
 * when it did not. A process that never answered
 * is still a process: `detached` made it a group
 * leader, and a caller that only ever got an
 * exception has no handle to kill it with. Left
 * alone it keeps the port, and the next run finds
 * something already answering there.
 *
 * Which is why the address is checked before
 * anything is started. Once two processes are in
 * play there is no telling them apart from out
 * here — the leftover answers the same address, and
 * the one just started is still on its way to dying
 * on EADDRINUSE when the first probe goes out, so
 * the wait would report success and hand back a
 * corpse. Refusing up front is the only answer that
 * is certain, and it names the real problem instead
 * of surfacing an hour later as an empty inbox.
 */
export async function startAndWait(
  options: StartOptions,
  url: string,
  what: string,
  wait: WaitOptions = {},
): Promise<HostProcess> {
  if (await answered(url)) {
    throw new Error(
      `${url} is already answering, so ${what} was not started: ` +
        'something from an earlier run still holds the port.',
    );
  }

  const running = startHostProcess(options);

  try {
    await waitForAnswer(running, url, what, wait);
  } catch (failure) {
    await running.kill();
    throw failure;
  }

  return running;
}

/** Whether anything at all serves an address. */
async function answered(url: string): Promise<boolean> {
  try {
    const response = await fetch(url);
    await response.arrayBuffer();

    return response.ok;
  } catch {
    return false;
  }
}

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * Driving the e2e stack from a spec.
 *
 * One spec kills the worker mid-broadcast and
 * starts it again, which is the whole reason this
 * exists: proving a crashed run resumes needs a
 * real crash, and a real crash needs docker.
 */

export const COMPOSE_FILE = 'docker-compose.e2e.yml';

/**
 * The project name is declared in the compose file
 * too. Passing it explicitly means a spec addresses
 * the same stack whatever the checkout directory is
 * called — compose would otherwise name the project
 * after the directory.
 */
export const COMPOSE_PROJECT = 'mboss-e2e';

/** The repo root: compose runs relative to it. */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const run = promisify(execFile);

export function composeArgs(command: string, ...rest: string[]): string[] {
  return [
    'compose',
    '-f',
    COMPOSE_FILE,
    '-p',
    COMPOSE_PROJECT,
    command,
    ...rest,
  ];
}

/**
 * SIGKILL, keeping the container. Nothing gets a
 * chance to shut down cleanly, which is the point:
 * a graceful stop would let the worker finish what
 * it was doing.
 */
export async function kill(service: string): Promise<void> {
  await docker(composeArgs('kill', service));
}

/**
 * A stopped container has no process to resume, so
 * `start` re-runs the entrypoint from scratch. The
 * container is the same one, so its executor id is
 * unchanged and DBOS recovers the workflows the
 * kill left PENDING.
 */
export async function start(service: string): Promise<void> {
  await docker(composeArgs('start', service));
}

export async function up(): Promise<void> {
  await docker(composeArgs('up', '--build', '--wait'));
}

export async function down(): Promise<void> {
  await docker(composeArgs('down', '-v'));
}

async function docker(args: string[]): Promise<string> {
  const { stdout } = await run('docker', args, { cwd: REPO_ROOT });

  return stdout;
}

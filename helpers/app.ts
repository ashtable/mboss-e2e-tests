import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { startAndWait, type HostProcess } from './host.js';

/**
 * Creating a project the way the extension will,
 * and running it the way a person does.
 *
 * The app runs as a host process rather than in its
 * own container, and that is the point of the whole
 * spec: `kill -9` against a container is a request
 * to a daemon, while against a process it is the
 * operating system taking the work away mid-flight,
 * which is the failure durable execution claims to
 * survive. Only its Postgres is a container, out of
 * the project's own compose file.
 *
 * Nothing here imports `mboss-core`. The nested
 * checkouts are build contexts — `lint-unit` runs
 * `tsc` on a tree that has none of them — so the
 * scaffold is reached through
 * `scaffolder/scaffold-project.mjs`, a plain Node
 * script, across a process boundary.
 */

const execute = promisify(execFile);

/**
 * A build or install step, given room to be slow
 * and noisy.
 *
 * `execFile`'s default buffer is a megabyte, which
 * an `npm install` of Prisma and the DBOS SDK
 * passes on its way to failing with a truncation
 * error instead of the reason it failed.
 */
function run(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string }> {
  return execute(command, args, {
    cwd: options.cwd,
    timeout: options.timeoutMs ?? 600_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * A third fixed offset, because there are three
 * stacks on this machine. The root dev stack
 * publishes Postgres on 5432 and its web on 3000;
 * this repo's own compose stack uses 5433 and 3100.
 * A generated app under test has to miss both, or
 * the suite only runs on a machine with nothing
 * else up — which is a suite people stop running.
 */
export const POSTGRES_PORT = 5434;
export const APP_PORT = 3200;
export const MAILSINK_PORT = 8125;

/**
 * Compose merges `ports` by concatenating, so a
 * file that just named the new mapping would
 * publish the emitted 5432 as well and collide with
 * the dev stack. `!override` replaces the list.
 *
 * Written as `docker-compose.override.yml`, which
 * compose picks up beside its own file with no
 * flag — the same file a person would add for the
 * same reason.
 */
export const COMPOSE_OVERRIDE = `# Written by the e2e suite, not by the scaffold.
#
# Two other stacks on this machine already publish
# 5432. Compose concatenates \`ports\` when it
# merges, so this replaces the list rather than
# adding to it.

services:
  postgres:
    ports: !override ['127.0.0.1:${POSTGRES_PORT}:5432']
`;

/**
 * A fourth offset, for the one journey that brings
 * a scaffolded project's whole stack up rather than
 * only its database.
 *
 * The extension's Runs panel runs
 * `docker compose up --build --wait` over the
 * compose file the scaffold wrote, which publishes
 * Postgres on 5432 and the app on 3000 — both of
 * them the dev stack's. A bind conflict there
 * surfaces inside the panel as a stack that would
 * not start, which is indistinguishable from the
 * regression that spec exists to catch, so the
 * project is moved off every port anything else on
 * this machine uses before the editor is ever
 * opened on it.
 */
export const EXTENSION_POSTGRES_PORT = 5435;
export const EXTENSION_APP_PORT = 3300;

/**
 * The moved database, as the project's own `.env`
 * has to name it.
 *
 * The extension reads that file to find the ledger
 * it draws the Runs panel from, and it reads it
 * from this machine rather than from inside a
 * container — so the name here is the published
 * port, while the app's own connection string is
 * compose's `postgres:5432` and stays that way.
 */
export const EXTENSION_DATABASE_URL = onLoopback(EXTENSION_POSTGRES_PORT);

/** The scaffold's database, as it is reached from
 *  this machine once its port has been moved. */
function onLoopback(port: number): string {
  return `postgres://app:app@127.0.0.1:${port}/app`;
}

/**
 * The same replacement as above, for both services.
 *
 * The app's mapping is here and not in the
 * durability spec's override because that spec
 * never starts the app in a container — it runs it
 * as a host process, so the emitted `3000:3000` is
 * never bound. This journey does start it.
 */
export const EXTENSION_COMPOSE_OVERRIDE = `# Written by the e2e suite.
#
# This project's stack is brought up by the
# extension while three other stacks may be up on
# this machine. Compose concatenates \`ports\` when
# it merges, so each of these replaces a list
# rather than adding to it.

services:
  postgres:
    ports: !override ['127.0.0.1:${EXTENSION_POSTGRES_PORT}:5432']

  app:
    ports: !override ['127.0.0.1:${EXTENSION_APP_PORT}:3000']
`;

/** The scaffolder, run by plain Node. */
const SCAFFOLDER = fileURLToPath(
  new URL('../scaffolder/scaffold-project.mjs', import.meta.url),
);

export type ScaffoldRequest = {
  dir: string;
  /** Also the compose project name. */
  name: string;
  /** The built bundle and its VERSION, which land
   *  in the project at `.mboss/mcp/`. */
  bundle: string;
  version: string;
};

/**
 * Writes a new project into `dir`, carrying the
 * MCP bundle at the path a real project vendors it
 * to.
 */
export async function scaffoldApp(request: ScaffoldRequest): Promise<void> {
  await run(process.execPath, [SCAFFOLDER, JSON.stringify(request)], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
  });
}

/**
 * The values a `.env` sets, ignoring its comments
 * and its quoting.
 *
 * Small enough to write out, and a dependency that
 * read it would be one more thing between the
 * suite and the file the scaffold actually wrote.
 */
export function parseEnv(contents: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const raw of contents.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    const at = line.indexOf('=');
    if (at === -1) continue;

    values[line.slice(0, at).trim()] = unquote(line.slice(at + 1).trim());
  }

  return values;
}

/**
 * The same file with some values changed, and every
 * comment where it was.
 *
 * A name the file does not already set is refused
 * rather than appended: the point of the rewrite is
 * to move a value the app will read, and a variable
 * the scaffold has renamed would otherwise leave
 * the old line winning and the app on a port
 * something else holds.
 */
export function withEnv(
  contents: string,
  overrides: Record<string, string>,
): string {
  const present = parseEnv(contents);
  for (const name of Object.keys(overrides)) {
    if (!(name in present)) {
      throw new Error(`the .env sets no ${name}, so there is none to replace`);
    }
  }

  return contents
    .split('\n')
    .map((raw) => {
      const at = raw.indexOf('=');
      if (raw.trim().startsWith('#') || at === -1) return raw;

      const name = raw.slice(0, at).trim();
      const replacement = overrides[name];

      return replacement === undefined ? raw : `${name}="${replacement}"`;
    })
    .join('\n');
}

/** Reads a project's `.env`. */
export async function readEnv(dir: string): Promise<Record<string, string>> {
  return parseEnv(await readFile(join(dir, '.env'), 'utf8'));
}

/** Rewrites a project's `.env` in place. */
export async function rewriteEnv(
  dir: string,
  overrides: Record<string, string>,
): Promise<void> {
  const path = join(dir, '.env');

  await writeFile(path, withEnv(await readFile(path, 'utf8'), overrides));
}

/**
 * Brings one service of the project's own compose
 * file up.
 *
 * `--wait` is the assertion: it exits non-zero
 * unless the service's own healthcheck goes green,
 * so a Postgres that never accepts connections
 * fails here rather than as a migration timing out.
 */
export async function composeUp(dir: string, service: string): Promise<void> {
  await run('docker', ['compose', 'up', '-d', '--wait', service], { cwd: dir });
}

/** Takes it down, volume included. */
export async function composeDown(dir: string): Promise<void> {
  await run('docker', ['compose', 'down', '-v'], { cwd: dir });
}

/**
 * Installs the project's dependencies.
 *
 * Slow, and unavoidable: the app has to actually
 * run, and the type-check gate has to resolve the
 * real DBOS SDK rather than report it missing. It
 * also leaves a `package-lock.json`, which the
 * emitted Dockerfile copies — so a project that has
 * never been installed cannot be imaged either.
 */
export async function installDependencies(dir: string): Promise<void> {
  await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir });
}

/**
 * Creates the runtime's own table, the way the
 * container's entrypoint does at start. Running the
 * app on this host means running its migrations
 * here too.
 */
export async function migrate(dir: string): Promise<void> {
  await run(
    join(dir, 'node_modules', '.bin', 'prisma'),
    ['migrate', 'deploy'],
    {
      cwd: dir,
    },
  );
}

/**
 * Builds the image the scaffold emitted.
 *
 * A packaging assertion and nothing more — the
 * image is never run. What the durability path
 * needs is a host process, and what this needs is
 * the answer to whether the Dockerfile somebody
 * deploys with still works.
 */
export async function buildImage(dir: string, tag: string): Promise<string> {
  const { stdout, stderr } = await run('docker', ['build', '--tag', tag, '.'], {
    cwd: dir,
  });

  return stdout + stderr;
}

/** Best effort: an image left behind is litter,
 *  not a failure. */
export async function removeImage(tag: string): Promise<void> {
  try {
    await run('docker', ['image', 'rm', '--force', tag], {
      cwd: process.cwd(),
    });
  } catch {
    // Never built, or already gone.
  }
}

/**
 * Starts the app and waits for it to serve.
 *
 * This is the project's own `start` script:
 * `tsx src/app/main.ts`, named directly rather than
 * through `npm start`, which would put an npm
 * process in front of the one doing the work. The
 * launcher still spawns a child of its own, which
 * is why the kill goes to the whole group.
 *
 * `start` reads no `.env` — it is written for the
 * container, where compose's `env_file` supplies
 * one — so the project's own file is handed over
 * here in the same way, rather than left to
 * whatever this shell happens to be carrying.
 */
export async function startApp(
  dir: string,
  baseUrl: string,
): Promise<HostProcess> {
  return await startAndWait(
    {
      command: join(dir, 'node_modules', '.bin', 'tsx'),
      args: [join('src', 'app', 'main.ts')],
      cwd: dir,
      env: await readEnv(dir),
    },
    `${baseUrl}/healthz`,
    'the generated app',
    { timeoutMs: 120_000 },
  );
}

function unquote(value: string): string {
  const quoted =
    value.length >= 2 &&
    (value.startsWith('"') || value.startsWith("'")) &&
    value.endsWith(value[0] ?? '');

  return quoted ? value.slice(1, -1) : value;
}

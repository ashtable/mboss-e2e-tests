import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { expect, test } from '@playwright/test';
import type pg from 'pg';

import {
  APP_PORT,
  COMPOSE_OVERRIDE,
  MAILSINK_PORT,
  POSTGRES_PORT,
  buildImage,
  composeDown,
  composeUp,
  installDependencies,
  migrate,
  readEnv,
  removeImage,
  rewriteEnv,
  scaffoldApp,
  startApp,
} from '../../helpers/app.js';
import {
  TERMINAL,
  expectStatus,
  parksOf,
  poolFor,
  reRun,
  runOf,
  stepsOf,
  type StepRow,
} from '../../helpers/dbos.js';
import type { HostProcess } from '../../helpers/host.js';
import { formUrlFrom } from '../../helpers/links.js';
import {
  messages,
  startMailsink,
  waitForMessage,
  type Mailsink,
} from '../../helpers/mail.js';
import {
  E2E_MCP_BUNDLE,
  E2E_MCP_VERSION,
  connectToBundle,
  outputOf,
  type McpSession,
} from '../../helpers/mcp.js';
import { discardProject } from '../../helpers/project.js';

/**
 * The promise, tested as one system.
 *
 * A project is created by the scaffold, given a
 * workflow through the shipped MCP bundle, built,
 * installed and started as a real process on this
 * machine. Then the process is killed with a signal
 * nothing can catch, while a run sits parked on a
 * form nobody has filled in yet — and after a
 * restart the link in that person's inbox still
 * opens, the run finishes, and the ledger shows the
 * work before the crash was read back rather than
 * done twice.
 *
 * Every piece of that is somebody's code under
 * test: the scaffold's file set, the compiler's
 * output, the runtime's boot order, the event
 * ingress, the signed link, and DBOS's own
 * recovery. This is the first place any of them run
 * together, and the only place they run at all —
 * everything before this proved a project
 * type-checks.
 *
 * Three rules it follows, all from elsewhere in
 * this suite. Nothing is minted: the form link is
 * read out of the mail the app sent. Nothing is
 * slept on: every wait is a bounded poll on a row
 * or a socket. And the crash is proved to have been
 * mid-flight before it happens — a run that had
 * already finished would make the whole thing pass
 * for the wrong reason.
 *
 * Watched failing first, with the kill taken out:
 * everything else still passed, and the run's
 * recovery count stayed at one. That is the
 * assertion which makes this a crash test rather
 * than a long way of running a workflow.
 */

const NAME = 'crash-fixture';
const WORKFLOW = 'crash_fixture';
const TOPIC = 'claim.filed';
const IMAGE = 'mboss-crash-fixture:e2e';

const APP_URL = `http://127.0.0.1:${APP_PORT}`;
const DATABASE_URL = `postgres://app:app@127.0.0.1:${POSTGRES_PORT}/app`;

const FIXTURE = fileURLToPath(
  new URL('../../fixtures/projects/crash-fixture', import.meta.url),
);

type ApplyOutput = { applied: boolean; revision?: number; errors: unknown[] };
type ValidateOutput = { valid: boolean; errors: unknown[] };
type BuildOutput = {
  ok: boolean;
  diagnostics: unknown[];
  unsupported: string[];
  tscErrors: string[];
};
type DebugOutput = {
  runs: {
    workflowId: string;
    name: string;
    status: string;
    recoveryAttempts: number;
    startedAt: string;
    durationMs?: number;
    steps?: Record<string, unknown>[];
  }[];
};

let project = '';
let session: McpSession;
let sink: Mailsink;
let pool: pg.Pool;
let app: HostProcess | undefined;
let eventsSecret = '';

test.beforeAll(async () => {
  // A scaffold, a full `npm install` and a Postgres
  // image. None of it is this spec's subject; all
  // of it has to be real.
  test.setTimeout(900_000);

  project = await mkdtemp(join(tmpdir(), 'mboss-e2e-crash-'));

  // The bundle travels into the project at the path
  // a real one vendors it to, so what the rest of
  // this spec drives is a copy that arrived through
  // the scaffold rather than the build directory.
  await scaffoldApp({
    dir: project,
    name: NAME,
    bundle: E2E_MCP_BUNDLE,
    version: E2E_MCP_VERSION,
  });

  // The fixture holds inputs only: the code behind
  // the blocks. Everything else in this project was
  // written by the scaffold a moment ago.
  await cp(join(FIXTURE, 'lib'), join(project, 'lib'), { recursive: true });

  // Three stacks, one machine. The ports move; the
  // minted secrets do not, so the run exercises the
  // key ring and the events secret the scaffold
  // chose.
  await rewriteEnv(project, {
    DATABASE_URL,
    DBOS_SYSTEM_DATABASE_URL: DATABASE_URL,
    APP_BASE_URL: APP_URL,
    PORT: String(APP_PORT),
    TWILIO_EMAIL_BASE_URL: `http://127.0.0.1:${MAILSINK_PORT}`,
  });
  await writeFile(
    join(project, 'docker-compose.override.yml'),
    COMPOSE_OVERRIDE,
  );

  const env = await readEnv(project);
  eventsSecret = env['EVENTS_SECRET'] ?? '';
  expect(eventsSecret, 'the scaffold minted no EVENTS_SECRET').not.toBe('');

  await installDependencies(project);

  // A previous run that died before its teardown
  // would otherwise leave this project's containers
  // and its volume behind, and the new run would
  // inherit yesterday's rows.
  await composeDown(project);
  await composeUp(project, 'postgres');
  await migrate(project);

  pool = poolFor(DATABASE_URL);
  sink = await startMailsink({
    port: MAILSINK_PORT,
    apiKey: env['TWILIO_API_KEY'] ?? '',
    apiSecret: env['TWILIO_API_SECRET'] ?? '',
  });

  session = await connectToBundle(
    project,
    'generated-app-durability spec',
    join(project, '.mboss', 'mcp', 'server.js'),
  );
});

test.afterAll(async () => {
  test.setTimeout(180_000);

  await app?.kill();
  await sink?.process.kill();
  await session?.close();
  await pool?.end();
  await removeImage(IMAGE);
  if (project !== '') {
    await composeDown(project);
    await discardProject(project);
  }
});

test.describe('a generated app', () => {
  test('survives being killed while a run waits on a form', async () => {
    // A scaffold, a compile, an install, a container
    // and two host processes, plus a durable run
    // across a crash.
    test.setTimeout(900_000);

    const { client } = session;

    // The document, straight off disk, minus its
    // envelope: `$schema`, `version` and `revision`
    // are the server's to set, and `name` comes
    // from the tool call — a spec carrying its own
    // would be free to disagree with it.
    const document = JSON.parse(
      await readFile(join(FIXTURE, `${WORKFLOW}.workflow.json`), 'utf8'),
    ) as Record<string, unknown>;
    const { title, nodes, edges } = document;
    const spec = { title, nodes, edges };

    // The real validator on the document about to
    // be applied, which is what names the
    // diagnostics if the fixture has stopped being
    // a legal one. Its shape is guarded separately
    // and hermetically, by `test/crash-fixture`.
    const checked = outputOf<ValidateOutput>(
      await client.callTool({
        name: 'workflow_validate',
        arguments: { spec },
      }),
    );
    expect(checked.errors).toEqual([]);
    expect(checked.valid).toBe(true);

    await client.callTool({
      name: 'workflow_create',
      arguments: { name: WORKFLOW, title: 'Crash fixture' },
    });
    const applied = outputOf<ApplyOutput>(
      await client.callTool({
        name: 'workflow_apply_spec',
        arguments: {
          name: WORKFLOW,
          spec,
          dryRun: false,
          baseRevision: 1,
        },
      }),
    );
    expect(applied).toMatchObject({ applied: true, revision: 2 });

    // The generated code, type-checked against the
    // real SDK for the first time anywhere. The
    // fixture the other MCP specs drive installs
    // nothing, so `tscErrors` there is a list of
    // modules it could not resolve; here it has to
    // be empty.
    const built = outputOf<BuildOutput>(
      await client.callTool({ name: 'project_build', arguments: {} }),
    );
    expect(built.diagnostics).toEqual([]);
    expect(built.unsupported).toEqual([]);
    expect(built.tscErrors).toEqual([]);
    expect(built.ok).toBe(true);

    const generated = join(
      project,
      'src',
      'workflows',
      `${WORKFLOW}.workflow.ts`,
    );
    expect(existsSync(generated)).toBe(true);
    expect(await readFile(generated, 'utf8')).toContain(
      'GENERATED BY MBOSS — DO NOT EDIT.',
    );

    app = await startApp(project, APP_URL);

    // The ingress derives the run's id from the
    // topic, the workflow and the declared
    // idempotency path, so the spec knows it without
    // asking — and a redelivered claim would land on
    // this same run rather than starting a second.
    const claimId = randomUUID();
    const claimant = `claimant-${claimId.slice(0, 8)}@crash.test`;
    const runId = `${TOPIC}:${WORKFLOW}:${claimId}`;

    const accepted = await fetch(`${APP_URL}/events/${TOPIC}`, {
      method: 'POST',
      headers: {
        'x-mboss-events-secret': eventsSecret,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ claimId, contact: { email: claimant } }),
    });
    expect(accepted.status).toBe(202);

    // The link is read out of the mail the app sent.
    // A suite that minted its own would verify
    // whatever it had just signed.
    const asking = await waitForMessage({ to: claimant }, 60_000, sink.url);
    expect(asking.subject).toBe('One more thing about your claim');

    const formUrl = formUrlFrom(asking.html);
    const before = await fetch(formUrl);
    expect(before.status).toBe(200);
    const page = await before.text();
    expect(page).toContain(claimant);
    expect(page).toContain(runId);

    // The crash has to happen mid-flight. This row
    // is written just before the run sleeps and
    // deleted the moment it wakes, so it is the
    // difference between killing a parked run and
    // killing nothing.
    await expectParked(runId, 'await_details');
    const beforeCrash = await stepsOf(pool, runId);
    const beforeRun = await runOf(pool, runId);
    expect(beforeRun?.status).toBe('PENDING');
    expect(finished(beforeCrash).map((step) => step.name)).toEqual(
      expect.arrayContaining(['open_case', 'ask_details']),
    );

    await app.kill();
    await expectRefused(`${APP_URL}/healthz`);

    app = await startApp(project, APP_URL);

    // Same link, same token, a different process.
    // Nothing was re-minted, and nothing about the
    // run was in the memory that just went away.
    const after = await fetch(formUrl);
    expect(after.status).toBe(200);
    expect(await after.text()).toContain(runId);

    const submitted = await fetch(formUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ note: 'a tree fell on it', urgent: 'yes' }),
    });
    expect(submitted.status).toBe(200);

    expect(await expectStatus(pool, runId, TERMINAL, 120_000)).toBe('SUCCESS');

    // The headline. Every step that had finished
    // before the kill carries the finish time it had
    // then — recovery read its checkpoint back
    // rather than calling the handler a second time.
    // A second `ask_details` would have been a
    // second email with a second link. The
    // assertion above the kill is what keeps this
    // one from being vacuous: there were finished
    // steps to restore.
    const afterCrash = await stepsOf(pool, runId);
    expect(reRun(beforeCrash, afterCrash)).toEqual([]);

    // And the commit at the end of the run happened
    // once, which is the property the block kind
    // exists for.
    expect(
      afterCrash.filter((step) => step.name === 'record_settlement'),
    ).toHaveLength(1);

    // One email, not two: the same proof from the
    // other side, and the one somebody would notice.
    expect(await messages({ to: claimant }, sink.url)).toHaveLength(1);

    // The recovery really was a recovery. DBOS
    // counts them per run, and comparing against
    // what it read before the kill beats asserting a
    // number this spec would have to know.
    const afterRun = await runOf(pool, runId);
    expect(afterRun?.recoveryAttempts).toBeGreaterThan(
      beforeRun?.recoveryAttempts ?? 0,
    );

    // Last, the tool whose SQL names DBOS's columns
    // by hand, asked for the first time against a
    // schema DBOS itself created. Every field it
    // maps has to come back filled in — nothing
    // else anywhere checks that mapping against a
    // real database.
    const debugged = outputOf<DebugOutput>(
      await session.client.callTool({
        name: 'project_debug',
        arguments: { runId },
      }),
    );
    const [run] = debugged.runs;
    expect(run).toMatchObject({
      workflowId: runId,
      name: WORKFLOW,
      status: 'SUCCESS',
    });
    expect(run?.recoveryAttempts).toBe(afterRun?.recoveryAttempts);
    expect(Date.parse(run?.startedAt ?? '')).not.toBeNaN();
    expect(run?.durationMs).toBeGreaterThan(0);

    const step = run?.steps?.find((each) => each['name'] === 'open_case');
    expect(Object.keys(step ?? {}).sort()).toEqual([
      'completedAtEpochMs',
      'functionID',
      'name',
      'startedAtEpochMs',
    ]);
  });

  /**
   * A packaging assertion, and only that. The image
   * is never run: what the durability path needs is
   * a process this spec can kill, and what this
   * needs is the answer to whether the Dockerfile
   * somebody deploys with still builds.
   */
  test('builds the image it was scaffolded with', async () => {
    test.setTimeout(600_000);

    const output = await buildImage(project, IMAGE);

    expect(output).toContain(IMAGE);
  });
});

/** The steps that had a completion time. */
function finished(steps: StepRow[]): StepRow[] {
  return steps.filter((step) => step.completedAtEpochMs !== null);
}

/**
 * Waits for the run to be asleep on a node, not
 * merely unfinished.
 */
async function expectParked(runId: string, nodeId: string): Promise<void> {
  const deadline = Date.now() + 60_000;

  for (;;) {
    const parked = await parksOf(pool, runId);
    if (parked.includes(nodeId)) return;

    if (Date.now() >= deadline) {
      throw new Error(
        `run ${runId} never parked on ${nodeId} — it is on ` +
          `${parked.join(', ') || 'nothing'}, so killing now would prove ` +
          'nothing about a run in flight',
      );
    }

    await delay(250);
  }
}

/**
 * The kill has to have landed. A socket that goes
 * on answering would mean the process this spec
 * killed was not the one doing the work.
 */
async function expectRefused(url: string): Promise<void> {
  const deadline = Date.now() + 15_000;

  for (;;) {
    try {
      const response = await fetch(url);
      await response.arrayBuffer();
    } catch {
      return;
    }

    if (Date.now() >= deadline) {
      throw new Error(`${url} is still answering after the kill`);
    }

    await delay(100);
  }
}

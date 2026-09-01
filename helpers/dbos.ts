import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

/**
 * A generated app's own Postgres, read from
 * outside.
 *
 * Deliberately not `helpers/db.ts`. That module's
 * pool is a module-level singleton pointed at the
 * cloud stack's database, and the app the
 * durability spec starts has a different one, on a
 * different port, created by a scaffold minutes
 * earlier. Two databases through one singleton is a
 * bug waiting for a quiet afternoon, so this takes
 * the pool it is given.
 *
 * Raw `pg` and read-only, for the same reason the
 * rest of this suite uses it: the point of looking
 * in the database is to see what the app really
 * wrote, and going back through its own ORM would
 * fold one observation into the other.
 */

/** One row of `dbos.operation_outputs`. */
export type StepRow = {
  functionId: number;
  name: string;
  /** Null while the step is still running — DBOS
   *  writes the row when a step starts. */
  completedAtEpochMs: number | null;
};

/** One row of `dbos.workflow_status`. */
export type RunRow = { status: string; recoveryAttempts: number };

/** A workflow that will never move again. */
export const TERMINAL = [
  'SUCCESS',
  'ERROR',
  'CANCELLED',
  'MAX_RECOVERY_ATTEMPTS_EXCEEDED',
];

export const RUN_SQL =
  'SELECT status, recovery_attempts AS "recoveryAttempts" ' +
  'FROM dbos.workflow_status WHERE workflow_uuid = $1';

export const STEPS_SQL =
  'SELECT function_id AS "functionId", function_name AS "name", ' +
  'completed_at_epoch_ms AS "completedAtEpochMs" ' +
  'FROM dbos.operation_outputs WHERE workflow_uuid = $1 ORDER BY function_id';

/**
 * The runtime's own correlation table. A row here
 * is written just before a run goes to sleep on a
 * node and deleted the moment it wakes, so it is
 * the one thing that says a run is *waiting*
 * rather than merely unfinished — which is what
 * has to be true before the process is killed, or
 * the crash proves nothing.
 */
export const PARKS_SQL =
  'SELECT "nodeId" FROM mboss_wait_correlations WHERE "runId" = $1';

/** A pool for one database, closed by its caller. */
export function poolFor(url: string): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 4 });
}

export async function runOf(
  pool: pg.Pool,
  runId: string,
): Promise<RunRow | undefined> {
  // `recovery_attempts` is a bigint, which `pg`
  // hands over as text. It counts restarts, so it
  // fits a number.
  const { rows } = await pool.query<{
    status: string;
    recoveryAttempts: string | number;
  }>(RUN_SQL, [runId]);
  const [row] = rows;

  return (
    row && {
      status: row.status,
      recoveryAttempts: Number(row.recoveryAttempts),
    }
  );
}

export async function stepsOf(
  pool: pg.Pool,
  runId: string,
): Promise<StepRow[]> {
  const { rows } = await pool.query<{
    functionId: number;
    name: string;
    completedAtEpochMs: string | number | null;
  }>(STEPS_SQL, [runId]);

  return rows.map((row) => ({
    functionId: Number(row.functionId),
    name: row.name,
    completedAtEpochMs:
      row.completedAtEpochMs === null ? null : Number(row.completedAtEpochMs),
  }));
}

/** The nodes this run is asleep on, if any. */
export async function parksOf(pool: pg.Pool, runId: string): Promise<string[]> {
  const { rows } = await pool.query<{ nodeId: string }>(PARKS_SQL, [runId]);

  return rows.map((row) => row.nodeId);
}

/**
 * Waits for a run to reach one of the states named
 * and answers with the one it reached.
 *
 * A bounded poll on the ledger, not a sleep: the
 * run advances when a durable workflow gets to it,
 * and the honest thing to wait on is the row.
 */
export async function expectStatus(
  pool: pg.Pool,
  runId: string,
  wanted: readonly string[],
  timeoutMs = 60_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const row = await runOf(pool, runId);
    if (row !== undefined && wanted.includes(row.status)) return row.status;

    if (Date.now() >= deadline) {
      throw new Error(
        `run ${runId} was ${row?.status ?? 'never started'} rather than ` +
          `${wanted.join(' or ')} after ${timeoutMs}ms`,
      );
    }

    await delay(250);
  }
}

/**
 * The steps that were re-run rather than restored.
 *
 * A step that had already finished carries its
 * finish time in the ledger for good: recovery
 * reads that checkpoint back instead of calling the
 * function again, so the timestamp is what tells
 * the two apart — "the step exists" is true either
 * way and proves nothing.
 *
 * Steps that had not finished when the process died
 * are skipped. They have no checkpoint to restore,
 * so completing them afterwards is the run
 * resuming, which is the behaviour under test
 * rather than a violation of it.
 */
export function reRun(
  before: readonly StepRow[],
  after: readonly StepRow[],
): StepRow[] {
  const now = new Map(after.map((row) => [row.functionId, row]));

  return before.filter(
    (row) =>
      row.completedAtEpochMs !== null &&
      now.get(row.functionId)?.completedAtEpochMs !== row.completedAtEpochMs,
  );
}

import { describe, expect, test } from 'vitest';

import {
  PARKS_SQL,
  RUN_SQL,
  STEPS_SQL,
  reRun,
  type StepRow,
} from '../helpers/dbos.js';

/**
 * The reads the durability spec makes of a
 * generated app's own Postgres, and the one piece
 * of judgement among them.
 *
 * `reRun` is where "restored, not re-run" is
 * actually decided, so it is tested here against
 * literal rows rather than only through a run that
 * takes twenty minutes to produce three of them. A
 * comparison that answered "nothing was re-run"
 * for every input would make the headline assertion
 * of this whole suite vacuous, and nothing in the
 * spec itself could tell.
 */

function step(
  functionId: number,
  name: string,
  completedAtEpochMs: number | null,
): StepRow {
  return { functionId, name, completedAtEpochMs };
}

describe('reRun', () => {
  const before = [
    step(0, 'open_case', 1_700_000_000_100),
    step(1, 'ask_details', 1_700_000_000_200),
  ];

  test('says nothing when every finished step kept its time', () => {
    expect(reRun(before, [...before, step(2, 'settle_case', 1)])).toEqual([]);
  });

  /**
   * The failure this whole spec exists to catch: a
   * recovery that replayed a step instead of
   * reading its checkpoint back. The second run of
   * `ask_details` would have sent a second email
   * with a second link.
   */
  test('names a step whose finish time moved', () => {
    const after = [before[0]!, step(1, 'ask_details', 1_700_000_009_999)];

    expect(reRun(before, after).map((row) => row.name)).toEqual([
      'ask_details',
    ]);
  });

  test('names a step whose row is gone', () => {
    expect(reRun(before, [before[0]!]).map((row) => row.name)).toEqual([
      'ask_details',
    ]);
  });

  /**
   * A step that was still running when the process
   * died has no checkpoint to restore, so finishing
   * it after the restart is the run resuming rather
   * than repeating.
   */
  test('ignores a step that had not finished yet', () => {
    const midway = [...before, step(2, 'await_details.register', null)];
    const after = [...before, step(2, 'await_details.register', 1_700_000_001)];

    expect(reRun(midway, after)).toEqual([]);
  });
});

/**
 * These three run against the app's own database
 * while it is serving. Reading is the whole
 * contract; a helper that wrote would be changing
 * the thing it is watching.
 */
describe('the reads', () => {
  const WRITES = /\b(insert|update|delete|drop|alter|truncate|create)\b/i;

  test('only ever select', () => {
    for (const sql of [RUN_SQL, STEPS_SQL, PARKS_SQL]) {
      expect(sql).toMatch(/^\s*SELECT\b/);
      expect(sql).not.toMatch(WRITES);
    }
  });

  test('name the tables they read', () => {
    expect(RUN_SQL).toContain('dbos.workflow_status');
    expect(STEPS_SQL).toContain('dbos.operation_outputs');
    expect(PARKS_SQL).toContain('mboss_wait_correlations');
  });

  test('take the run id as a parameter', () => {
    for (const sql of [RUN_SQL, STEPS_SQL, PARKS_SQL])
      expect(sql).toContain('$1');
  });
});

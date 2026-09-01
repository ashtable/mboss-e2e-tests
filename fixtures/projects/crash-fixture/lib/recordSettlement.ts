import type { Settlement } from './types.js';

/**
 * The commit at the end of the run.
 *
 * It writes nothing, and that is deliberate. What
 * this fixture is about is the checkpoint DBOS
 * records *around* the call — the block compiles to
 * `appDb.runTransaction(...)`, so the datasource
 * has to have been registered before launch and
 * initialised by it, and the run has to reach here
 * exactly once across a kill and a restart. A
 * handler that wrote through `appDb.client` would
 * have to import a runtime module that exists only
 * once a project has been scaffolded, which would
 * put a file in this repository that cannot
 * type-check in it.
 */
export async function recordSettlement(input: Settlement): Promise<Settlement> {
  return input;
}

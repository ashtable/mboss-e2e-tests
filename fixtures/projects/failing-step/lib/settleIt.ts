import type { Claim, Settlement } from './types.js';

/**
 * The bug this fixture exists to have.
 *
 * A claim marked to fail is refused instead of
 * settled. The line below is the one a spec
 * rewrites while a run is on screen, so the replay
 * it then asks for runs new code over an input
 * already recorded. It is deliberately one
 * statement on one line, and the only line in the
 * file that refuses anything.
 */
export async function settleIt(claim: Claim): Promise<Settlement> {
  if (claim.fail) throw new Error('the ledger refused this claim');

  return { note: 'settled the claim' };
}

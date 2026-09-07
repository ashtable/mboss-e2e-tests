import type { Claim } from './types.js';

/**
 * The row a replay carries over.
 *
 * A fork copies every durable row recorded below
 * the point it starts from, so a workflow whose
 * failing step is its first one has nothing to
 * copy and its replay is indistinguishable from a
 * second run. This block is what gives the fork
 * something to inherit.
 *
 * It hands the claim back untouched, deliberately.
 * The refusal this fixture exists to have belongs
 * to `settleIt.ts`, and the input the mended step
 * is replayed over has to be the one the person
 * typed.
 */
export async function loadClaim(claim: Claim): Promise<Claim> {
  return claim;
}

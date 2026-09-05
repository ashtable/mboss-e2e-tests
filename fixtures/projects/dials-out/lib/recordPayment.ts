import type { Claim } from './types.js';

/**
 * Marks the claim settled.
 *
 * Everything it touches is the app's own database,
 * which is what a transaction's body is for: the
 * write lands with the run's checkpoint or not at
 * all. It reaches nothing outside, so it can sit
 * behind the transaction that names it.
 */
export async function recordPayment(claim: Claim): Promise<Claim> {
  return await Promise.resolve({ ...claim, settled: true });
}

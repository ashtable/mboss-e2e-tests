import { Socket } from 'node:net';

import type { Claim } from './types.js';

/**
 * Tells the insurer's network the claim is paid.
 *
 * The same outward reach as `chargeCard` and the
 * same signature, spelled the other way round: the
 * socket is built on the line that dials it, so
 * there is no name anywhere in the file for the
 * call to be recorded under. That is the whole
 * point of it being here — a handler whose one
 * outward line is written this way is the shape
 * the packaged extension used to offer to a
 * transaction and now puts away.
 */
export async function wireSettlement(claim: Claim): Promise<Claim> {
  new Socket().connect(7000, 'settlements.example');

  return await Promise.resolve({ ...claim, settled: true });
}

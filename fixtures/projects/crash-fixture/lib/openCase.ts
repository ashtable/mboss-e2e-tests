import type { Case, Claim } from './types.js';

/**
 * The step that runs before the crash.
 *
 * Its output is checkpointed on the way out, which
 * is the whole point of it being here: after the
 * process is killed and started again, the run
 * reads this value back rather than calling this
 * function a second time.
 */
export async function openCase(input: Claim): Promise<Case> {
  return { caseId: `case-${input.claimId}`, filedBy: input.contact.email };
}

import type { Details, Settlement } from './types.js';

/**
 * The step that runs after the crash, on the
 * answers a person typed into the form.
 */
export async function settleCase(input: Details): Promise<Settlement> {
  return { note: input.note ?? '', urgent: input.urgent === true };
}

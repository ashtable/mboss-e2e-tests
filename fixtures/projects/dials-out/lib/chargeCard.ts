import type { Claim } from './types.js';

/**
 * Charges the card through the payment service.
 *
 * The signature of the handler beside it, and one
 * line that neither the run's checkpoint nor its
 * rollback can reach. Which line that is matters:
 * the refusal a person reads names it, and the
 * spec finds it here rather than counting on a
 * constant.
 */
export async function chargeCard(claim: Claim): Promise<Claim> {
  await fetch('https://payments.example/charges', {
    method: 'POST',
    body: JSON.stringify(claim),
  });

  return { ...claim, settled: true };
}

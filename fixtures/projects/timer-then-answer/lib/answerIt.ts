import type { Answer, Enquiry } from './types.js';

/**
 * The code behind this project's one step.
 *
 * It answers by quoting the question back, which is
 * the least a handler can do and still be a real
 * one: a signature core can match against the block
 * that names it, and a return value a run can
 * finish on.
 */
export async function answerIt(enquiry: Enquiry): Promise<Answer> {
  return { text: `You asked: ${enquiry.question}` };
}

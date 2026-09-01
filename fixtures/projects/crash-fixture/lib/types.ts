// The code-behind's own types.
//
// Every one of these crosses a durable checkpoint —
// out of one block and back into the next through
// the workflow database — so they are plain data
// and nothing else.

/** What the `claim.filed` event carries. The two
 *  paths the trigger declares, `claimId` and
 *  `contact.email`, are read off this. */
export type Claim = { claimId: string; contact: { email: string } };

export type Case = { caseId: string; filedBy: string };

/** The form's answers. Both are optional because a
 *  form is filled in by a person: `required` makes
 *  the browser insist, not the type. */
export type Details = { note?: string; urgent?: boolean };

export type Settlement = { note: string; urgent: boolean };

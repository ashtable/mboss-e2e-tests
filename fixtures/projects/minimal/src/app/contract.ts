// Copied from the scaffold's own contract module,
// which is what a real project gets. It is here
// verbatim rather than trimmed to what this
// fixture happens to need, because it is the one
// file the generated code type-checks against and
// a hand-cut version of it would make a compiler
// change look like a fixture bug.
//
// The shapes the generated workflow registry
// satisfies and the runtime consumes.
//
// This file declares types and nothing else, and
// imports nothing at all: it is the one place the
// compiler-owned code under src/workflows and the
// hand-editable runtime under src/app have to
// agree, and a shared type with no dependencies is
// the cheapest agreement there is.

export type TriggerDescriptor =
  | { mode: 'manual' }
  | {
      mode: 'event';
      topic: string;
      idempotencyKeyPath?: string;
      requesterEmailPath?: string;
    }
  | { mode: 'schedule' };

/**
 * What a trigger's payload check answers. The
 * compiler generates the check, because it knows
 * the declared type and the runtime does not.
 */
export type PayloadCheck =
  | { ok: true; key: string | undefined; requesterEmail: string | undefined }
  | { ok: false; problem: string };

export type ScheduleEntry = {
  scheduleName: string;
  workflowFn: (scheduledTime: Date, context: unknown) => Promise<void>;
  schedule: string;
  cronTimezone: string;
  automaticBackfill: boolean;
};

/**
 * A queue's rate limit, on the queue as a whole or
 * within each partition of it.
 *
 * Local to this file on purpose: an exported type
 * may name a local one, and nothing outside needs
 * to say this shape's name.
 */
type QueueRateLimit = {
  limitPerPeriod: number;
  periodSec: number;
};

/**
 * One queue, as the boot registers it.
 *
 * The options are the SDK's registration
 * parameters, minus the three it has deprecated
 * and the two the deployment owns. Every one of
 * them is optional: a queue with no limits at all
 * is a legal queue, and it is the ordinary one.
 */
export type QueueEntry = {
  name: string;
  options: {
    globalConcurrency?: number;
    workerConcurrency?: number;
    rateLimit?: QueueRateLimit;
    partitionConcurrency?: number;
    partitionWorkerConcurrency?: number;
    partitionRateLimit?: QueueRateLimit;
    minPollingIntervalMs?: number;
    onConflict?: 'update_if_latest_version' | 'always_update' | 'never_update';
  };
};

export type EmailFormField = {
  id: string;
  label: string;
  type: 'text' | 'textarea' | 'fileUpload' | 'yesNo';
  /** Both are optional in the IR and required
   *  here: the page and the email bullet each need
   *  an answer, and `?? false` at one point in the
   *  compiler beats an `?? false` at every point
   *  that reads them. */
  required: boolean;
  multiple: boolean;
  /**
   * Which earlier answer this field depends on.
   * The IR carries it; the page shows the field
   * only when the condition holds, so a form that
   * asks a follow-up question keeps working.
   */
  showIf?: FieldCondition;
};

/**
 * The compiled form of a field's `showIf`. The
 * page evaluates it in the browser against the
 * answers already filled in, so it is flattened to
 * the three things a browser check needs and never
 * carries a dot-path the page cannot resolve.
 *
 * The operator set is the IR predicate's, whole:
 * narrowing it would refuse a legal draft for no
 * reason a person could act on.
 */
export type FieldCondition = {
  fieldId: string;
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists' | 'nonempty';
  value?: string | number | boolean;
};

export type WaitDescriptor = {
  nodeId: string;
  title: string;
  /**
   * Which page /f/<token> serves. The token cannot
   * carry this: an approval mints an ordinary form
   * token, which is the whole point of reusing the
   * form machinery for it.
   */
  page: 'form' | 'approval';
  fields: readonly EmailFormField[];
  /**
   * Titles of the blocks that run after this wait,
   * in the order they run. The page shown after a
   * submit lists them, so a person can see what
   * they just woke up.
   */
  downstream: readonly string[];
};

/**
 * What the approval page sends into the run when
 * somebody answers it.
 *
 * The one message the runtime composes for a
 * workflow rather than passing along: a form's
 * answers are the shape that form's author
 * declared, but an approval asks one question and
 * this is the answer to it. The compiler writes
 * the receive against this type, so the two ends
 * of that message are one declaration rather than
 * a shape spelled the same way twice.
 */
export type ApprovalReply = { approved: boolean };

export type EventWait = {
  nodeId: string;
  topic: string;
  correlationPath: string;
};

export type WorkflowEntry = {
  name: string;
  title: string;
  /**
   * `never` in the parameters is what lets one
   * array hold workflows that each take their own
   * input type. The rest form is not decoration: a
   * scheduled workflow takes two arguments, and a
   * two-argument function is not assignable to a
   * one-argument type, so `(input: never) => …`
   * would make the registry's own cast an error.
   * The ingress casts once, at the point a checked
   * payload crosses in.
   */
  workflowFn: (...args: never[]) => Promise<unknown>;
  trigger: TriggerDescriptor;
  checkPayload: (payload: unknown) => PayloadCheck;
  /** Every wait this workflow can sleep on, by id. */
  waits: Readonly<Record<string, WaitDescriptor>>;
  /** Event-source waits, for the ingress lookup. */
  eventWaits: readonly EventWait[];
};

export type NodeEmailAttach =
  | { kind: 'none' }
  | {
      kind: 'form';
      nodeId: string;
      fields: readonly EmailFormField[];
      expiresInSeconds: number;
    }
  | { kind: 'approval'; nodeId: string; expiresInSeconds: number }
  | { kind: 'artifact'; key: string; expiresInSeconds: number };

export type NodeEmail = {
  runId: string;
  workflowTitle: string;
  nodeId: string;
  to: string;
  subject: string;
  bodyMarkdown: string;
  attach: NodeEmailAttach;
  downstream: readonly string[];
};

export type WaitRegistration = {
  runId: string;
  nodeId: string;
  topic: string;
  key: string;
};

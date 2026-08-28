import { randomUUID } from 'node:crypto';
import pg from 'pg';

/**
 * The suite's window onto Postgres.
 *
 * Raw `pg`, no Prisma client. The point of a
 * database assertion here is to see what the
 * services really wrote; going back through the
 * same ORM layer they wrote it with would fold one
 * of the two observations into the other. It also
 * keeps this repo out of the generate-a-client
 * business entirely.
 */

export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  'postgres://postgres:mboss@127.0.0.1:5433/mboss';

export type SubscriberStatus =
  'subscribed' | 'paused' | 'unsubscribed' | 'bounced';

export type SubscriberRow = {
  id: string;
  email: string;
  status: SubscriberStatus;
  source: 'email' | 'admin';
  tokenVersion: number;
  confirmationEmailSentAt: Date | null;
  pausedAt: Date | null;
  unsubscribedAt: Date | null;
  bouncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SubscriberSeed = {
  email: string;
  status?: SubscriberStatus;
  /**
   * Set this and the signup path will not enqueue
   * a confirmation for the row, which is how a
   * spec builds an audience without also sending
   * it a dozen emails.
   */
  confirmationEmailSentAt?: Date | null;
};

/**
 * A row the app could actually have produced.
 *
 * `id` and `updatedAt` are supplied here because
 * the database has no default for either —
 * `@default(cuid())` and `@updatedAt` are
 * Prisma-client-side, and only `createdAt` carries
 * a `CURRENT_TIMESTAMP` default in the migration.
 * The nullable timestamps follow the status one
 * for one, the way every state transition in the
 * app writes them.
 */
export function subscriberSeed(seed: SubscriberSeed): SubscriberRow {
  const status = seed.status ?? 'subscribed';
  const now = new Date();

  return {
    id: randomUUID(),
    email: seed.email,
    status,
    source: 'email',
    tokenVersion: 1,
    confirmationEmailSentAt: seed.confirmationEmailSentAt ?? null,
    pausedAt: status === 'paused' ? now : null,
    unsubscribedAt: status === 'unsubscribed' ? now : null,
    bouncedAt: status === 'bounced' ? now : null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * The between-specs reset.
 *
 * `public` only. Terminal workflow rows in the
 * `dbos` schema are inert, and clearing them would
 * break DBOS's own bookkeeping — the confirmation
 * workflow ids are the app's idempotency key, and
 * forgetting them would make a resend look
 * eligible when it is not.
 */
export const TRUNCATE_PUBLIC_SQL =
  'TRUNCATE TABLE "BroadcastDelivery", "Broadcast", "Subscriber" ' +
  'RESTART IDENTITY CASCADE';

/** A workflow that will never move again. */
export const TERMINAL_WORKFLOW_STATUSES = [
  'SUCCESS',
  'ERROR',
  'CANCELLED',
  'MAX_RECOVERY_ATTEMPTS_EXCEEDED',
];

export type WorkflowStatusRow = {
  workflowId: string;
  status: string;
};

export type DeliveryRow = {
  id: string;
  broadcastId: string;
  subscriberId: string;
  status: 'pending' | 'sent' | 'failed' | 'skipped';
  error: string | null;
};

let shared: pg.Pool | undefined;

/** One pool for the run; `closePool` in teardown. */
export function pool(): pg.Pool {
  shared ??= new pg.Pool({ connectionString: E2E_DATABASE_URL, max: 4 });

  return shared;
}

export async function closePool(): Promise<void> {
  await shared?.end();
  shared = undefined;
}

export async function truncatePublic(): Promise<void> {
  await pool().query(TRUNCATE_PUBLIC_SQL);
}

export async function seedSubscribers(
  seeds: SubscriberSeed[],
): Promise<SubscriberRow[]> {
  const rows = seeds.map(subscriberSeed);

  for (const row of rows)
    await pool().query(
      `INSERT INTO "Subscriber" (
         id, email, status, source, "tokenVersion",
         "confirmationEmailSentAt", "pausedAt", "unsubscribedAt",
         "bouncedAt", "createdAt", "updatedAt"
       ) VALUES ($1, $2, $3::"SubscriberStatus", $4::"SubscriberSource",
         $5, $6, $7, $8, $9, $10, $11)`,
      [
        row.id,
        row.email,
        row.status,
        row.source,
        row.tokenVersion,
        row.confirmationEmailSentAt,
        row.pausedAt,
        row.unsubscribedAt,
        row.bouncedAt,
        row.createdAt,
        row.updatedAt,
      ],
    );

  return rows;
}

export async function subscriberByEmail(
  email: string,
): Promise<SubscriberRow | undefined> {
  const { rows } = await pool().query<SubscriberRow>(
    'SELECT * FROM "Subscriber" WHERE email = $1',
    [email],
  );

  return rows[0];
}

export type BroadcastRow = {
  id: string;
  subject: string;
  status: 'draft' | 'sending' | 'sent' | 'failed';
  recipientCount: number | null;
  createdBy: string;
};

/**
 * The broadcast a spec just composed. Subjects
 * carry the run id, so this is a lookup rather than
 * a guess — and it is how a spec gets the id it
 * needs for the delivery rows and the workflow.
 */
export async function broadcastBySubject(
  subject: string,
): Promise<BroadcastRow | undefined> {
  const { rows } = await pool().query<BroadcastRow>(
    `SELECT id, subject, status, "recipientCount", "createdBy"
       FROM "Broadcast" WHERE subject = $1`,
    [subject],
  );

  return rows[0];
}

/**
 * Waits for a broadcast to stop moving: `sending`
 * gone and no delivery row left pending.
 *
 * Both halves, because they settle separately — the
 * worker flips the last delivery row and then calls
 * complete, so a poll on the broadcast alone can
 * catch it before its own rows agree. The timeout
 * message counts what was still pending, which is
 * the first thing anyone would ask.
 */
export async function waitForBroadcastComplete(
  broadcastId: string,
  timeoutMs = 60_000,
): Promise<BroadcastRow> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const { rows } = await pool().query<BroadcastRow>(
      `SELECT id, subject, status, "recipientCount", "createdBy"
         FROM "Broadcast" WHERE id = $1`,
      [broadcastId],
    );
    const broadcast = rows[0];
    const deliveries = await deliveriesFor(broadcastId);
    const pending = deliveries.filter(
      (delivery) => delivery.status === 'pending',
    );

    if (
      broadcast !== undefined &&
      broadcast.status !== 'sending' &&
      broadcast.status !== 'draft' &&
      pending.length === 0
    )
      return broadcast;

    if (Date.now() >= deadline)
      throw new Error(
        `broadcast ${broadcastId} was ${broadcast?.status ?? 'missing'} ` +
          `with ${pending.length}/${deliveries.length} deliveries pending ` +
          `after ${timeoutMs}ms`,
      );

    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export async function deliveriesFor(
  broadcastId: string,
): Promise<DeliveryRow[]> {
  const { rows } = await pool().query<DeliveryRow>(
    `SELECT id, "broadcastId", "subscriberId", status, error
       FROM "BroadcastDelivery" WHERE "broadcastId" = $1`,
    [broadcastId],
  );

  return rows;
}

/**
 * The workflows whose ids match a LIKE pattern, in
 * the order they were created. mBoss names every
 * workflow deterministically — `confirm:<id>:<n>`,
 * `broadcast:<id>`, `bounce-scan:<parent>` — so a
 * pattern is a question about what the app decided
 * to run, and a *count* of matches is an assertion
 * that needs no waiting at all.
 */
export async function workflowStatuses(
  likePattern: string,
): Promise<WorkflowStatusRow[]> {
  const { rows } = await pool().query<WorkflowStatusRow>(
    `SELECT workflow_uuid AS "workflowId", status
       FROM dbos.workflow_status
      WHERE workflow_uuid LIKE $1
      ORDER BY created_at`,
    [likePattern],
  );

  return rows;
}

/**
 * Waits for one workflow to stop moving and
 * answers with where it stopped.
 *
 * This is the anchor a negative assertion hangs
 * off: "no second email was sent" only means
 * something once the workflow that would have sent
 * it has finished. Bounded, so a worker that never
 * ran fails with a message rather than a hang.
 */
export async function expectTerminalWorkflow(
  workflowId: string,
  timeoutMs = 30_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const [row] = await workflowStatuses(workflowId);
    if (row !== undefined && TERMINAL_WORKFLOW_STATUSES.includes(row.status))
      return row.status;

    if (Date.now() >= deadline)
      throw new Error(
        `workflow ${workflowId} was ${row?.status ?? 'never enqueued'} ` +
          `after ${timeoutMs}ms`,
      );

    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Moves a subscriber's last confirmation into the
 * past. The 24-hour resend window is read off the
 * clock, so the honest way to test the far side of
 * it is to rewrite the timestamp — not to mock
 * time inside a service the suite is meant to be
 * observing from outside.
 */
export async function backdateConfirmationSentAt(
  email: string,
  interval: string,
): Promise<void> {
  await pool().query(
    `UPDATE "Subscriber"
        SET "confirmationEmailSentAt" = now() - $2::interval
      WHERE email = $1`,
    [email, interval],
  );
}

/**
 * The sendKey the API will derive for this
 * subscriber's next confirmation — the whole-second
 * epoch of their last one, or 0 when they have never
 * been mailed.
 *
 * Computed in Postgres rather than from the `Date`
 * on the row, and that is not fussiness. The column
 * is `timestamp without time zone`, so `pg` parses
 * it in the *client's* zone; the services all run
 * with the container's UTC, while a developer's
 * laptop does not. Reading the epoch off a
 * JavaScript Date would therefore name a workflow
 * that exists only in one time zone, and the spec
 * would fail on a machine and pass in CI for a
 * reason nothing on screen mentions.
 */
export async function confirmationSendKey(email: string): Promise<number> {
  const { rows } = await pool().query<{ sendKey: string | null }>(
    `SELECT floor(
              extract(epoch from "confirmationEmailSentAt")
            )::bigint::text AS "sendKey"
       FROM "Subscriber" WHERE email = $1`,
    [email],
  );

  const [row] = rows;
  if (row === undefined) throw new Error(`no subscriber for ${email}`);

  return row.sendKey === null ? 0 : Number(row.sendKey);
}

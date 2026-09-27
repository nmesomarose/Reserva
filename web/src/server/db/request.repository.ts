/**
 * Prisma implementation of the attendee-request persistence port.
 *
 * Four methods, and three of them are about concurrency rather than mapping:
 *
 *   - `createAttendeeRequest` resolves the FR-23a double-submit race **inside one
 *     statement**, with `ON CONFLICT (idempotency_key) DO NOTHING … RETURNING *`. A
 *     pre-flight "does this key exist?" read would be the check-then-act shape rule 07
 *     forbids, and catching `P2002` around a plain `create` would poison any enclosing
 *     transaction before the stored row could be read back. `ON CONFLICT` does neither:
 *     the unique index is the arbiter, exactly one row ever results, and a replay is
 *     answered by a statement that *succeeded* rather than by an error to unpick.
 *   - `recordAttendeeRequestResolution` is a **conditional** `UPDATE` that re-asserts the
 *     event scope and the `open` precondition in its own `WHERE`, so two organisers
 *     acting at once cannot both believe they resolved the request. The guard is the
 *     lock; there is no `FOR UPDATE` round trip because there is nothing to decide
 *     first.
 *   - `listAttendeeRequests` scopes by `event_id` inside the query rather than filtering
 *     a cross-event page afterwards, so another event's request is never countable and
 *     never visible.
 *
 * ## Why these reads are raw SQL
 *
 * Both read paths need the registration's contact columns and status *in the same row
 * as the request*, because that is also what establishes event scope. Prisma expresses
 * that as an `include` — but `include` cannot filter the **parent** by event, so scope
 * would have to become a post-filter, and a post-filter is precisely the leak the
 * `WHERE` above prevents. The list's `total` needs a second statement over the same
 * predicate, and a builder would either duplicate that predicate in two places (where it
 * could drift) or compute it from the page (which is not the filtered count).
 */

import "server-only";

import { Prisma } from "@/generated/prisma/client";

import type { PagedResult } from "@/domain/events/event";
import type { RegistrationStatus } from "@/domain/registrations/registration";
import type { AttendeeRequestListRow, AttendeeRequestRecord, AttendeeRequestStatus } from "@/domain/requests/request";
import type {
  AttendeeRequestCreation,
  AttendeeRequestRepository,
  CreateAttendeeRequestInput,
  ListAttendeeRequestsQuery,
  RecordAttendeeRequestResolutionInput,
  RecordAttendeeRequestResolutionOutcome,
} from "@/domain/requests/request.repository";

/** One `attendee_requests` row, as `RETURNING *` and the `SELECT`s hand it back. */
interface AttendeeRequestRow {
  readonly id: string;
  readonly registration_id: string;
  readonly message: string;
  readonly status: AttendeeRequestStatus;
  readonly resolution_notes: string | null;
  readonly idempotency_key: string;
  readonly created_at: Date;
  readonly resolved_at: Date | null;
}

/** A request plus the registration facts the organiser queue projects. */
interface AttendeeRequestListRowSql extends AttendeeRequestRow {
  readonly registration_status: RegistrationStatus;
  readonly attendee_name: string;
  readonly attendee_email: string;
  readonly attendee_phone: string;
}

function toAttendeeRequestRecord(row: AttendeeRequestRow): AttendeeRequestRecord {
  return {
    id: row.id,
    registrationId: row.registration_id,
    message: row.message,
    status: row.status,
    resolutionNotes: row.resolution_notes,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function toAttendeeRequestListRow(row: AttendeeRequestListRowSql): AttendeeRequestListRow {
  return {
    ...toAttendeeRequestRecord(row),
    registrationStatus: row.registration_status,
    attendeeName: row.attendee_name,
    attendeeEmail: row.attendee_email,
    attendeePhone: row.attendee_phone,
  };
}

/**
 * The columns every list-shaped read selects.
 *
 * Written once because the page, the count, and the single-row detail must agree on
 * *which rows are in scope*; a copy-paste divergence here would show an organiser a
 * request the `total` did not count, or resolve a request the detail read could not see.
 */
const REQUEST_COLUMNS = Prisma.sql`
  ar.id,
  ar.registration_id,
  ar.message,
  ar.status,
  ar.resolution_notes,
  ar.idempotency_key,
  ar.created_at,
  ar.resolved_at,
  r.status      AS registration_status,
  r.attendee_name,
  r.attendee_email,
  r.attendee_phone
`;

/**
 * `attendee_requests` joined to its registration — the only way a request is ever
 * reached. Every event-scoped read goes through it, so "is this request mine" is
 * answered by the same predicate everywhere.
 */
const REQUEST_SOURCE_SQL = Prisma.sql`
  FROM attendee_requests ar
  JOIN registrations r ON r.id = ar.registration_id
`;

/** The optional `status` filter, or an empty fragment when the whole queue is wanted. */
function statusFilter(status: AttendeeRequestStatus | null): Prisma.Sql {
  return status === null
    ? Prisma.sql``
    : Prisma.sql`AND ar.status = ${status}::attendee_request_status`;
}

export class PrismaAttendeeRequestRepository implements AttendeeRequestRepository {
  /**
   * Typed as the transaction client so the same class serves the pool-backed handle and
   * a transaction-scoped one (the convention every adapter in this directory follows,
   * which is what makes `transact` a one-liner that cannot drift).
   */
  constructor(private readonly prisma: Prisma.TransactionClient) {}

  async transact<T>(
    work: (repository: AttendeeRequestRepository) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction((tx) => work(new PrismaAttendeeRequestRepository(tx)));
  }

  /**
   * Create an `open` request, or hand back the one this key already made.
   *
   * `ON CONFLICT (idempotency_key) DO NOTHING` names the one index whose collision is a
   * replay. Every other violation still raises, which is deliberate: a
   * `registration_id` that does not exist is a bug or a tampered path, not a replay, and
   * must not be answered with some other attendee's request.
   *
   * `created_at` is left to the column default (`now()`) rather than passed in, so the
   * queue's ordering comes from the database clock — the same clock that stamped the
   * row the loser of a race reads back.
   */
  async createAttendeeRequest(input: CreateAttendeeRequestInput): Promise<AttendeeRequestCreation> {
    const inserted = await this.prisma.$queryRaw<AttendeeRequestRow[]>`
      INSERT INTO attendee_requests (registration_id, message, status, resolution_notes, idempotency_key)
      VALUES (${input.registrationId}::uuid, ${input.message}, 'open', NULL, ${input.idempotencyKey})
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id, registration_id, message, status, resolution_notes, idempotency_key, created_at, resolved_at
    `;

    const row = inserted[0];

    if (row !== undefined) {
      return { outcome: "created", request: toAttendeeRequestRecord(row) };
    }

    const existing = await this.findAttendeeRequestByIdempotencyKey(input.idempotencyKey);

    if (existing === null) {
      // The insert lost to a request that is no longer readable. §14 retains requests
      // forever and the row is deleted by nobody, so this means the database is in a
      // state the product forbids; failing loudly beats reporting a replay with no row.
      throw new Error(
        "The idempotency key was reported as already used but no stored request could be read.",
      );
    }

    return { outcome: "replayed", request: existing };
  }

  async findAttendeeRequestByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<AttendeeRequestRecord | null> {
    const rows = await this.prisma.$queryRaw<AttendeeRequestRow[]>`
      SELECT id, registration_id, message, status, resolution_notes, idempotency_key, created_at, resolved_at
      FROM attendee_requests
      WHERE idempotency_key = ${idempotencyKey}
    `;

    const row = rows[0];

    return row === undefined ? null : toAttendeeRequestRecord(row);
  }

  /**
   * One request, **only** if it belongs to `eventId`.
   *
   * Scoped in the `WHERE` rather than fetched and compared in the service, so a request
   * id from another event is indistinguishable from one that does not exist — the same
   * anti-enumeration discipline rule 08 applies to attendee-facing refusals, applied
   * here to organiser surfaces so a queue cannot be used to probe another tenant.
   */
  async findAttendeeRequestForEvent(
    eventId: string,
    requestId: string,
  ): Promise<AttendeeRequestListRow | null> {
    const rows = await this.prisma.$queryRaw<AttendeeRequestListRowSql[]>`
      SELECT ${REQUEST_COLUMNS}
      ${REQUEST_SOURCE_SQL}
      WHERE r.event_id = ${eventId}::uuid
        AND ar.id = ${requestId}::uuid
    `;

    const row = rows[0];

    return row === undefined ? null : toAttendeeRequestListRow(row);
  }

  /**
   * The organiser's queue: newest first, `id` as the tiebreak.
   *
   * The `total` is a second statement over the *same predicate*, not a window-function
   * column and not a count of the page — the skill's integrity check is that `total` is
   * the filtered count. Both statements run inside one `REPEATABLE READ` transaction so
   * a request created between them cannot make the page and the count disagree; that is
   * the same zero-discrepancy requirement the dashboard carries.
   */
  async listAttendeeRequests(
    query: ListAttendeeRequestsQuery,
  ): Promise<PagedResult<AttendeeRequestListRow>> {
    const offset = (query.page - 1) * query.pageSize;
    const filter = statusFilter(query.status);

    return this.prisma.$transaction(
      async (tx) => {
        const items = await tx.$queryRaw<AttendeeRequestListRowSql[]>`
          SELECT ${REQUEST_COLUMNS}
          ${REQUEST_SOURCE_SQL}
          WHERE r.event_id = ${query.eventId}::uuid
            ${filter}
          ORDER BY ar.created_at DESC, ar.id DESC
          LIMIT ${query.pageSize}
          OFFSET ${offset}
        `;

        const totals = await tx.$queryRaw<{ readonly count: number }[]>`
          SELECT count(*)::bigint AS count
          ${REQUEST_SOURCE_SQL}
          WHERE r.event_id = ${query.eventId}::uuid
            ${filter}
        `;

        return {
          items: items.map(toAttendeeRequestListRow),
          total: Number(totals[0]?.count ?? 0),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /**
   * Write a response, or resolve the request — conditionally.
   *
   * One statement, three guards in the `WHERE`:
   *
   *   - `ar.id` — which request;
   *   - `r.event_id` — the event scope, re-asserted here so a `PATCH` cannot mutate a
   *     request through an event that does not own it even if the service's read were
   *     bypassed (rule 08: resolve parent→child relationships before authorising);
   *   - `ar.status = 'open'` — §14's terminal-state rule, enforced by the database rather
   *     than by a read the service performed a moment earlier.
   *
   * The assignments are conditional too, and that is what makes a *response* different
   * from a *resolution*:
   *
   *   - `resolution_notes` is written only when supplied. `null` means "do not change
   *     them", never "erase them" — §12's `PATCH` is a partial update, so a body carrying
   *     only a note must not blank a note written earlier.
   *   - `status`/`resolved_at` are written only on the `resolved` branch, and
   *     `resolved_at` uses the instant the service chose, so one resolution has one
   *     timestamp (the same reasoning `resolveVerifiedPayment` records for `verified_at`).
   *
   * The projection is re-read **inside the same transaction as the write**, because the
   * response body is the organiser's view *after* the write; assembling it from a
   * separately-read row would be a second race, and one the client would see as a
   * `PATCH` that reported somebody else's resolution.
   *
   * ## Why this transaction is `READ COMMITTED` and not `REPEATABLE READ`
   *
   * The two concurrent-resolution case is what fixes it, and it is a case the guarded
   * `WHERE` exists to produce:
   *
   *   - T1 resolves the request and holds the row lock.
   *   - T2's `UPDATE` blocks on that lock, T1 commits, and T2's statement re-reads the
   *     row (EvalPlanQual). The row now says `resolved`, so `ar.status = 'open'` no longer
   *     matches, **zero rows are affected**, and T2's re-read finds `resolved` and reports
   *     `already_resolved` — the `409` the contract specifies.
   *
   * Under `REPEATABLE READ` the same interleaving is *not* the same outcome: the row T2's
   * snapshot holds is one a concurrent transaction has updated, so PostgreSQL raises
   * `40001 could not serialize access due to concurrent update` and the request dies as a
   * `500`. The transaction would abort before the re-read could name the winner's
   * resolution. `READ COMMITTED` is also sufficient for the read-back: it always sees the
   * transaction's own writes, which is the row the `UPDATE` just produced.
   *
   * `listAttendeeRequests` *does* use `REPEATABLE READ`, because there the snapshot is
   * protecting two reads from each other (page and count) rather than a write from a
   * competing writer - a different job, and the level is right for it.
   */
  async recordAttendeeRequestResolution(
    input: RecordAttendeeRequestResolutionInput,
  ): Promise<RecordAttendeeRequestResolutionOutcome> {
    if (input.status === null && input.resolutionNotes === null) {
      // The service rejects an empty patch with a field-level 400 and folds an explicit
      // `status: "open"` into `null`, so this is unreachable. A `SET` with no assignment
      // is a SQL error, and reporting a programming error beats writing a statement whose
      // meaning depends on the driver.
      throw new Error(
        "A resolution write must change resolution_notes, set status to resolved, or both.",
      );
    }

    const assignments: Prisma.Sql[] = [];

    if (input.resolutionNotes !== null) {
      assignments.push(Prisma.sql`resolution_notes = ${input.resolutionNotes}`);
    }

    if (input.status === "resolved") {
      assignments.push(
        Prisma.sql`status = 'resolved'::attendee_request_status`,
        Prisma.sql`resolved_at = ${input.resolvedAt}`,
      );
    }

    return this.prisma.$transaction(
      async (tx) => {
        const repository = new PrismaAttendeeRequestRepository(tx);

        const affected = await tx.$executeRaw`
          UPDATE attendee_requests ar
          SET ${Prisma.join(assignments)}
          FROM registrations r
          WHERE r.id = ar.registration_id
            AND ar.id = ${input.requestId}::uuid
            AND r.event_id = ${input.eventId}::uuid
            AND ar.status = 'open'::attendee_request_status
        `;

        if (Number(affected) === 0) {
          // Which of the three guards failed is a question only the row can answer, and
          // all three answers are refusals the service turns into a single
          // `404`/`409` pair.
          const existing = await repository.findAttendeeRequestForEvent(
            input.eventId,
            input.requestId,
          );

          if (existing === null) {
            return { kind: "not_found" };
          }

          if (existing.status === "resolved") {
            return { kind: "already_resolved", request: existing };
          }

          // In scope and still `open`, yet the guarded update matched nothing. Only a
          // broken trigger or a concurrent delete can do that, and requests are never
          // deleted, so this is reported rather than retried: a retry loop would turn a
          // database inconsistency into a hanging request.
          throw new Error(
            "The attendee request is open and in scope but its guarded update matched no row.",
          );
        }

        const written = await repository.findAttendeeRequestForEvent(
          input.eventId,
          input.requestId,
        );

        if (written === null) {
          // The write succeeded and requests are never deleted, so this read cannot miss.
          throw new Error(
            "The attendee request update could not be read back after it was written.",
          );
        }

        return { kind: "updated", request: written };
      },
      // Default isolation, stated explicitly so the reason above is not "quietly
      // removed" by a later edit that copies the level from the list method.
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }
}

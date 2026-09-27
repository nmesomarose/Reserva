/**
 * Persistence port for attendee requests (PRD v2 FR-23, FR-23a, FR-24, §12 rows 11
 * and 12, §14; rule 07).
 *
 * The domain declares what it needs; `src/server/db/request.repository.ts` supplies
 * the Prisma implementation. `transact` matches the shape used by the other three
 * ports so a caller already holding a transaction can pass its handle in.
 *
 * ## Three decisions this port fixes, each load-bearing
 *
 *   1. **The idempotency key is arbitrated by the database, not by a prior read.**
 *      {@link AttendeeRequestRepository.createAttendeeRequest} returns a *discriminated
 *      outcome* rather than throwing, exactly as `RegistrationRepository`'s
 *      `RegistrationCreation` does: FR-23a's "debounced" submission must return the
 *      original request to a double-click, and the only race-free way to decide which
 *      of two concurrent identical submissions created the row is to let
 *      `UNIQUE(idempotency_key)` reject the loser and re-read the winner's row.
 *   2. **Every read is scoped by `eventId`, in the query.** Requests hang off
 *      registrations, so "this request's event" is only knowable through a join. A
 *      `WHERE id = ?` read followed by a comparison in the service would still let a
 *      read cross a tenant boundary; more importantly the *write* must be scoped, or
 *      a `PATCH` naming another event's request would mutate it and only then report
 *      `404` — the same reasoning that scoped `revokeStaffToken` (rule 05, rule 08).
 *   3. **A resolution is written once.** {@link RecordAttendeeRequestResolution} takes
 *      the event id *and* requires the row to still be `open` when the command
 *      resolves it, so `resolved_at` is stamped exactly once and a second organiser
 *      click cannot overwrite retained resolution text (§14).
 */

import type { PagedResult } from "../events/event";
import type {
  AttendeeRequestListRow,
  AttendeeRequestRecord,
  AttendeeRequestStatus,
} from "./request";

/**
 * What {@link AttendeeRequestRepository.createAttendeeRequest} produced.
 *
 * A union rather than a nullable record because the two outcomes mean opposite
 * things to the service, and "the key was already used" is the *success* case for
 * FR-23a — not an error to be reported as one.
 */
export type AttendeeRequestCreation =
  | { readonly outcome: "created"; readonly request: AttendeeRequestRecord }
  | { readonly outcome: "replayed"; readonly request: AttendeeRequestRecord };

export interface CreateAttendeeRequestInput {
  readonly registrationId: string;
  readonly message: string;
  readonly idempotencyKey: string;
}

export interface ListAttendeeRequestsQuery {
  readonly eventId: string;
  /** `null` means "no filter" — the whole event's queue, both statuses. */
  readonly status: AttendeeRequestStatus | null;
  readonly page: number;
  readonly pageSize: number;
}

/**
 * The only status change this port will ever write.
 *
 * `null` — a response, not a resolution: notes are written, the lifecycle does not move.
 * `"resolved"` — the resolution itself, which also stamps `resolved_at`.
 *
 * There is deliberately **no `"open"` member**. A `PATCH` may legitimately say
 * `{"status": "open"}` for an already-open request, and the service folds that into
 * `null` before the port is called, because the decision to refuse a *backward*
 * transition belongs in the domain (which answers `409` and names the retained
 * resolution) rather than in the adapter (which could only either silently accept it or
 * fail without explanation). A type that cannot express the forbidden write is stronger
 * than a check that has to remember to run.
 */
export type AttendeeRequestResolutionTarget = "resolved" | null;

export interface RecordAttendeeRequestResolutionInput {
  readonly eventId: string;
  readonly requestId: string;
  /** `null` leaves `status` and `resolved_at` alone (a response, not a resolution). */
  readonly status: AttendeeRequestResolutionTarget;
  /** `null` leaves the existing note alone. */
  readonly resolutionNotes: string | null;
  /**
   * The instant a resolution is stamped with.
   *
   * Passed in rather than read from the database so one resolution has one `resolved_at`
   * (the same reasoning `resolveVerifiedPayment` records for `verified_at`). The adapter
   * writes it **only** on the `resolved` branch, and ignores it otherwise: a notes-only
   * response must not look like a resolution by acquiring a timestamp.
   */
  readonly resolvedAt: Date;
}

/**
 * The outcome of a resolution write, decided inside one statement.
 *
 * `not_found` deliberately covers "no such request" **and** "a request belonging to
 * another event", exactly as the staff slice's `recordCheckIn` does: a caller must
 * not be able to learn that an id it guessed is real somewhere else (PRD §15).
 *
 * The updated row is the *list* row, registration context included, so a `PATCH`
 * response is the same shape the queue already holds and a client can replace its
 * entry without a second request. Implementations read that context back inside the
 * same transaction as the write.
 */
export type RecordAttendeeRequestResolutionOutcome =
  | { readonly kind: "updated"; readonly request: AttendeeRequestListRow }
  | { readonly kind: "already_resolved"; readonly request: AttendeeRequestListRow }
  | { readonly kind: "not_found" };

export interface AttendeeRequestRepository {
  transact<T>(work: (repository: AttendeeRequestRepository) => Promise<T>): Promise<T>;

  /**
   * Insert one open request, or report the request this `idempotency_key` already
   * produced (FR-23, FR-23a).
   *
   * MUST behave as follows:
   *
   * 1. `status` is always `open`; `resolution_notes` and `resolved_at` are `null`.
   *    A request cannot be born resolved — there is nobody to have resolved it.
   * 2. Duplicate `idempotency_key` returns `replayed` carrying the **stored** row.
   *    A pre-flight existence read would be a check-then-act race (rule 07), so the
   *    insert is attempted and the `UNIQUE` violation is the arbiter.
   * 3. A duplicate `id` is impossible (`gen_random_uuid()`) and a duplicate
   *    `registration_id` is not unique at all — §7.3 is Registration 1:N
   *    AttendeeRequest, so any number of requests per registration is legitimate.
   */
  createAttendeeRequest(input: CreateAttendeeRequestInput): Promise<AttendeeRequestCreation>;

  /** The request a client-supplied `idempotency_key` already produced, if any. */
  findAttendeeRequestByIdempotencyKey(idempotencyKey: string): Promise<AttendeeRequestRecord | null>;

  /**
   * One page of an event's request queue, with the count of the whole filtered set.
   *
   * The join to `registrations` is inside the query because it is what establishes
   * event scope, and the attendee context it selects is what the queue renders.
   */
  listAttendeeRequests(query: ListAttendeeRequestsQuery): Promise<PagedResult<AttendeeRequestListRow>>;

  /**
   * One request *of this event*, with the same context the list carries, or `null`.
   *
   * Used to decide the outcome of a `PATCH` before writing. It is an optimisation,
   * not the guarantee: {@link recordAttendeeRequestResolution} re-asserts the scope
   * and the `open` precondition in its own statement.
   */
  findAttendeeRequestForEvent(
    eventId: string,
    requestId: string,
  ): Promise<AttendeeRequestListRow | null>;

  /**
   * Write the organiser's response and/or resolution — one conditional statement.
   *
   * MUST refuse (`already_resolved`) a command against a request that is not `open`, so
   * `resolved_at` is stamped once and a resolution is never overwritten (§14). The
   * `open` precondition is the adapter's, not just the service's: a check the domain
   * performed a moment earlier is not what stops the second of two organisers resolving
   * the same request.
   *
   * A notes-only write (both `status` and no note change) leaves `status` and
   * `resolved_at` untouched, which is what makes a response distinguishable from a
   * resolution.
   */
  recordAttendeeRequestResolution(
    input: RecordAttendeeRequestResolutionInput,
  ): Promise<RecordAttendeeRequestResolutionOutcome>;
}

/**
 * Attendee-request domain types (PRD v2 §7.2, §5.8, §12, §14; FR-23, FR-23a, FR-24).
 *
 * Framework- and database-agnostic, like every other domain module: plain shapes,
 * never a Prisma model. The adapter in `src/server/db/request.repository.ts` maps
 * `attendee_requests` onto these.
 *
 * ## What the PRD fixes, and what it leaves to this slice
 *
 * §7.2 fixes the columns exactly: `id`, `registration_id` (`RESTRICT`),
 * `message`, `status`, nullable `resolution_notes`, `UNIQUE(idempotency_key)`,
 * `created_at`, nullable `resolved_at`. There is **no** `resolved_by` column, no
 * thread of responses, and no status beyond `open`/`resolved` — so a "response"
 * (FR-24) can only be written to `resolution_notes`, and who wrote it cannot be
 * recorded on the row. Both facts are handled rather than worked around: see
 * `ATTENDEE_REQUEST_STATUS_TRANSITIONS` for how the two statuses may be used, and
 * the open item in `docs/evidence/requirements-matrix.md` for the missing actor.
 *
 * ## The lifecycle is one-way on purpose
 *
 * ```
 * (no row) -> OPEN -> RESOLVED [terminal]
 * ```
 *
 * `resolved -> open` is refused. §14 requires the request *and its resolution* to be
 * retained, so a reopen would have to either overwrite a retained resolution or
 * invent a second status value; both are a backward transition of exactly the kind
 * rule 03 forbids, and §9.2/§9.4 show the product's own lifecycles have none. The
 * request stays resolvable-in-fact because the resolution *is* the record.
 */

import type { RegistrationStatus } from "../registrations/registration";

/** PRD v2 §7.2. Mirrors the `attendee_request_status` enum exactly (rule 02). */
export const ATTENDEE_REQUEST_STATUSES = ["open", "resolved"] as const;

export type AttendeeRequestStatus = (typeof ATTENDEE_REQUEST_STATUSES)[number];

export function isAttendeeRequestStatus(value: unknown): value is AttendeeRequestStatus {
  return typeof value === "string" && (ATTENDEE_REQUEST_STATUSES as readonly string[]).includes(value);
}

/**
 * Legal `status` transitions.
 *
 * `open -> open` is listed as the self-transition because writing notes to a request
 * that is already open is legal (§14 records the response in `resolution_notes`);
 * it is a no-op on the status itself, not a transition. `resolved -> resolved` is
 * absent: the resolution is written **once** and never rewritten, so a repeat write
 * is refused rather than silently overwriting retained text.
 */
export const ATTENDEE_REQUEST_STATUS_TRANSITIONS: Readonly<
  Record<AttendeeRequestStatus, readonly AttendeeRequestStatus[]>
> = {
  open: ["open", "resolved"],
  resolved: [],
};

export function isAttendeeRequestTransitionAllowed(
  from: AttendeeRequestStatus,
  to: AttendeeRequestStatus,
): boolean {
  return ATTENDEE_REQUEST_STATUS_TRANSITIONS[from].includes(to);
}

/** One attendee request, as stored. */
export interface AttendeeRequestRecord {
  readonly id: string;
  readonly registrationId: string;
  readonly message: string;
  readonly status: AttendeeRequestStatus;
  /** The organiser's response and/or resolution. `null` while nothing is written. */
  readonly resolutionNotes: string | null;
  readonly idempotencyKey: string;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
}

/**
 * One request as the organiser's queue sees it, with the registration context a
 * triage decision needs.
 *
 * The attendee's own name is included unmasked because the organiser owns the
 * registration and G-1 already shows them the full contact record; the email and
 * phone are kept **masked** here because a queue is a list, and the list convention
 * established by the staff search (§4.4.2) is to disambiguate without handing out a
 * stranger's contact details. The full values are one click away on the record view.
 */
export interface AttendeeRequestListRow extends AttendeeRequestRecord {
  readonly registrationStatus: RegistrationStatus;
  readonly attendeeName: string;
  readonly attendeeEmail: string;
  readonly attendeePhone: string;
}

/**
 * Validated, domain-level input for submitting a request (FR-23, §12 row 11).
 *
 * `registrationId` comes from the path and the reference/email pair from the body,
 * and **both** must resolve to the same registration. That is §12's own error
 * semantics ("400 if registration not found for that reference/email pair") rather
 * than an invention: an attendee holds their reference and email but not the row id
 * (the create response never returns it), so the pair is what proves ownership, and
 * the path is what makes the request addressable in the organiser's queue.
 */
export interface SubmitAttendeeRequestCommand {
  readonly registrationId: string;
  readonly uniqueReference: string;
  readonly attendeeEmail: string;
  readonly message: string;
  /** Client-generated UUID; FR-23a's debounce, `UNIQUE` in the database. */
  readonly idempotencyKey: string;
}

/**
 * A sparse edit from `PATCH /api/v1/events/{id}/requests/{request_id}` (R-5 G-3).
 *
 * `status` absent means "do not change the status" — a response is written by
 * `resolutionNotes` alone. `status: "resolved"` resolves the request and requires
 * notes (see the service). `status: "open"` is accepted only as a self-transition on
 * an open request; on a resolved one it is the forbidden backward move.
 */
export interface ResolveAttendeeRequestCommand {
  readonly status?: AttendeeRequestStatus;
  readonly resolutionNotes?: string;
}

/**
 * Message bound — a product decision, and the first one this slice has to make.
 *
 * §11 specifies no rule for `message`, and §12 requires `400` on an invalid one, so
 * some bound is required. 5000 characters matches the `description` limit already
 * fixed by product-owner decision 4 (2026-09-26) and reused for `programme_items`
 * and ticket tiers, so the product has **one** convention for free-text columns
 * rather than a per-table one. It is recorded as design position P-14 in
 * `docs/evidence/requirements-matrix.md`.
 */
export const MAX_ATTENDEE_REQUEST_MESSAGE_LENGTH = 5_000;

/**
 * Resolution-notes bound, same number and same reasoning as
 * {@link MAX_ATTENDEE_REQUEST_MESSAGE_LENGTH} (P-14).
 */
export const MAX_ATTENDEE_REQUEST_RESOLUTION_NOTES_LENGTH = 5_000;

/** Statuses the organiser queue may be filtered by (§12: "requests additionally supports `status`"). */
export const LISTABLE_ATTENDEE_REQUEST_STATUSES = ATTENDEE_REQUEST_STATUSES;

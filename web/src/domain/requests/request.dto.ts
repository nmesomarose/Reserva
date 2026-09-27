/**
 * Attendee-request projections (rule 06: hand-defined DTOs; rule 08: allow-lists).
 *
 * Two audiences, two shapes, and the difference is the point:
 *
 *   - {@link AttendeeRequestDTO} is what the **attendee** gets back. It carries their
 *     own message and whatever the organiser has written, and nothing else — in
 *     particular no `idempotency_key` (an internal bookkeeping value the client
 *     already holds), no attendee contact details beyond the request itself, and no
 *     organiser or event internals.
 *   - {@link OrganiserRequestDTO} is the **organiser's** queue row. It adds the
 *     registration's status, which is what the respond/resolve decision actually
 *     turns on: a request against a `refunded` registration is answered differently
 *     from one against a `confirmed` one. Contact details are masked here for the
 *     same reason the staff search masks them (§4.4.2) — a queue is a list, and the
 *     unmasked values are on the record view (R-5 G-1) the organiser can open.
 *
 * Neither shape carries a `status` the stored row does not have: `open` and `resolved`
 * are the only two values in the `attendee_request_status` enum and the mapper refuses to
 * invent a third. And because `resolved_at` is only ever stamped alongside a
 * `resolution_notes` the service refused to accept without notes, a `resolved` row here
 * always carries its resolution text — see {@link assertCoherent} for the incoherence
 * that would still be reported rather than projected.
 */

import type { RegistrationStatus } from "../registrations/registration";
import type { AttendeeRequestRecord, AttendeeRequestStatus } from "./request";
import type { AttendeeRequestListRow } from "./request";

/**
 * Email and phone masking, imported from the staff slice rather than re-implemented.
 *
 * One definition of "what a list is allowed to show" across the whole product: a
 * second copy is a second thing to get subtly wrong, and the rules that shape it
 * (keep the domain, expose the first and last local character, survive a
 * degenerate address) are already argued in `staff.dto.ts`.
 */
import { maskEmail, maskPhone } from "../staff/staff.dto";

/**
 * The attendee's own request (FR-23: "Request record").
 *
 * `resolution_notes` and `resolved_at` are the answer channel: FR-24 says the
 * organiser can respond and resolve, and with §7.2 fixing the columns this is the
 * only place a response can reach the attendee.
 *
 * The two fields answer different questions and are therefore independently `null`:
 * `resolved_at` is stamped only by a *resolution*, so it stays `null` for the whole of
 * an open request, while `resolution_notes` may be written by a *response* at any point
 * (§14 records the response there, and `open -> open` is a legal self-transition for
 * exactly that reason). A client that renders "we are looking into it" from `status` is
 * reading the stored truth rather than a guess, and one that shows notes is showing what
 * the organiser actually wrote, not a resolution that never happened.
 */
export interface AttendeeRequestDTO {
  readonly id: string;
  readonly registration_id: string;
  readonly message: string;
  readonly status: AttendeeRequestStatus;
  readonly resolution_notes: string | null;
  readonly created_at: string;
  readonly resolved_at: string | null;
}

/**
 * One row of `GET /api/v1/events/{id}/requests` (FR-24: organiser can view requests).
 *
 * `registration_status` is the registration's own stored status — the cached
 * projection PRD §7.4 maintains in the same transaction as any check-in — and is
 * included because the organiser's next action depends on it. It is not a
 * substitute for the payment lifecycle anywhere: the *payment* breakdown belongs to
 * the dashboard (FR-25), which derives it from the `payments` table.
 */
export interface OrganiserRequestDTO {
  readonly id: string;
  readonly registration_id: string;
  readonly attendee_name: string;
  readonly attendee_email_masked: string;
  readonly attendee_phone_masked: string;
  readonly registration_status: RegistrationStatus;
  readonly message: string;
  readonly status: AttendeeRequestStatus;
  readonly resolution_notes: string | null;
  readonly created_at: string;
  readonly resolved_at: string | null;
}

/**
 * Whether the stored pair is self-consistent, re-asserted by the mapper.
 *
 * The database enforces this pairing as a CHECK constraint (migration
 * `20260927040000_attendee_request_integrity`), and rule 06's "responses are
 * hand-defined, never serialized rows" does not exempt a projection from reporting a
 * row it does not understand. A `resolved` request with no `resolved_at` would render
 * as answered-when with no answer, which is the misrepresentation rule 08 exists to
 * prevent.
 */
function assertCoherent(
  request: Pick<AttendeeRequestRecord, "status" | "resolutionNotes" | "resolvedAt">,
): void {
  if (request.status === "resolved" && request.resolvedAt === null) {
    throw new Error(
      "A resolved attendee request must carry a resolved_at instant; the stored row is not " +
        "coherent, so it is not projected rather than projected as answered.",
    );
  }
}

export function toAttendeeRequestDTO(request: AttendeeRequestRecord): AttendeeRequestDTO {
  assertCoherent(request);

  return {
    id: request.id,
    registration_id: request.registrationId,
    message: request.message,
    status: request.status,
    resolution_notes: request.resolutionNotes,
    created_at: request.createdAt.toISOString(),
    resolved_at: request.resolvedAt === null ? null : request.resolvedAt.toISOString(),
  };
}

export function toOrganiserRequestDTO(row: AttendeeRequestListRow): OrganiserRequestDTO {
  assertCoherent(row);

  return {
    id: row.id,
    registration_id: row.registrationId,
    attendee_name: row.attendeeName,
    attendee_email_masked: maskEmail(row.attendeeEmail),
    attendee_phone_masked: maskPhone(row.attendeePhone),
    registration_status: row.registrationStatus,
    message: row.message,
    status: row.status,
    resolution_notes: row.resolutionNotes,
    created_at: row.createdAt.toISOString(),
    resolved_at: row.resolvedAt === null ? null : row.resolvedAt.toISOString(),
  };
}

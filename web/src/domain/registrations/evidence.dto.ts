/**
 * The attendee ticket-evidence projection (PRD v2 §5.5, §6.3, §13; FR-15, FR-19;
 * rule 08).
 *
 * ## This is the narrowest DTO in the product
 *
 * It is a **ticket**, not a registration record. FR-15 asks for the attendee to
 * "retrieve their ticket" and FR-19 requires that anything not confirmed is never
 * presented as a valid ticket; rule 08 then says the evidence response must not carry
 * the registration's payment history, check-in log, or attendee requests. Between
 * them, three separate documents say the same thing, and the field list below is the
 * intersection:
 *
 * | Field | Why it is here |
 * |---|---|
 * | `registration_id` | The attendee's next move is `POST /registrations/{id}/requests`, and the path parameter is this id. Without it the attendee must re-derive a value the platform already has, and P-13 records that decision. |
 * | `unique_reference` | The ticket's own identifier; the attendee quotes it back to any organiser. |
 * | `attendee_name` / `attendee_email` | Proof the PDF is *theirs*: the §6.3 ticket carries both, so a screenshot of someone else's ticket fails the second check. |
 * | `ticket_type_name` | What they bought. Read from the registration's tier, never from a request. |
 * | `status` | The one field that makes FR-19 work. A `pending_payment` or `cancelled` registration is reported as exactly that, so no client can mistake the response for a valid ticket. |
 * | `hold_expires_at` | Only meaningful while `pending_payment`, and it is what §9.3's hold window means to the holder of an unpaid ticket. |
 * | `created_at` | When the hold was placed — the other half of the hold window. |
 * | `event` | Live, not snapshotted (BR-6), so a rescheduled event reaches an already-issued ticket. |
 *
 * **Deliberately absent:** `attendee_phone`, every `Payment` field (including
 * `provider_reference` and `raw_provider_payload`), the check-in log, and the
 * attendee's requests. Each omission is a §6.3/§13 privacy decision, and the API tests
 * assert the field *names* are absent — an allow-list that is only implied by a
 * mapper is not an allow-list.
 */

import { holdExpiresAt, type TicketTypeRecord } from "../tickets/ticket-type";
import type { EventRecord } from "../events/event";
import type { RegistrationRecord, RegistrationStatus } from "./registration";

/** The event facts a ticket needs, read live (BR-6). */
export interface RegistrationEvidenceEventDTO {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly venue: string;
  readonly status: string;
}

/** Everything FR-15 promises, and nothing else. */
export interface RegistrationEvidenceDTO {
  readonly registration_id: string;
  readonly unique_reference: string;
  readonly attendee_name: string;
  readonly attendee_email: string;
  readonly ticket_type_name: string;
  /**
   * The stored `Registration.status`, verbatim.
   *
   * FR-19 is satisfied by *labelling* the state honestly rather than by refusing to
   * answer: a `pending_payment` attendee who cannot see that they have not paid yet is
   * worse served than one who can. No field of this DTO says the ticket is valid; the
   * client is required to check this one.
   */
  readonly status: RegistrationStatus;
  /**
   * When the tier hold lapses — `null` once the hold has been consumed or released.
   *
   * Derived with the same `holdExpiresAt` helper the registration service uses, so
   * "expires at" on the ticket is the same instant as "expires at" everywhere else and
   * cannot be two different functions.
   */
  readonly hold_expires_at: string | null;
  readonly created_at: string;
  readonly event: RegistrationEvidenceEventDTO;
}

export function toRegistrationEvidenceEventDTO(
  event: EventRecord,
): RegistrationEvidenceEventDTO {
  return {
    id: event.id,
    name: event.name,
    slug: event.slug,
    starts_at: event.startsAt.toISOString(),
    ends_at: event.endsAt.toISOString(),
    venue: event.venue,
    status: event.status,
  };
}

export function toRegistrationEvidenceDTO(
  registration: RegistrationRecord,
  tier: TicketTypeRecord,
  event: EventRecord,
): RegistrationEvidenceDTO {
  return {
    registration_id: registration.id,
    unique_reference: registration.uniqueReference,
    attendee_name: registration.attendeeName,
    attendee_email: registration.attendeeEmail,
    ticket_type_name: tier.name,
    status: registration.status,
    hold_expires_at: holdExpiry(registration),
    created_at: registration.createdAt.toISOString(),
    event: toRegistrationEvidenceEventDTO(event),
  };
}

/**
 * The hold's expiry, or `null` when there is no hold to expire.
 *
 * `pending_payment` is the only state with an outstanding hold (BR-3: initiation
 * places it, §8.5's confirmation consumes it, the sweep releases it), so every other
 * status answers `null` instead of printing a deadline that has already passed. A
 * `confirmed` ticket showing "hold expires at 14:05" would be a lie about a hold that
 * no longer exists.
 */
function holdExpiry(registration: RegistrationRecord): string | null {
  if (registration.status !== "pending_payment") {
    return null;
  }

  return holdExpiresAt(registration.createdAt).toISOString();
}

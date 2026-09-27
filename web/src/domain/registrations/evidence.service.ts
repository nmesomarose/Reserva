/**
 * Attendee ticket evidence (PRD v2 §5.5, §6.3, §7.2, §13; FR-15, FR-19; rules 05,
 * 06, 08).
 *
 * ## What this endpoint is allowed to know
 *
 * A ticket PDF is the attendee's *own* ticket, and the whole reason it can be served
 * without a login is that the attendee proves possession two ways at once: the unique
 * reference printed on the PDF (§5.5) plus the email the registration was made with.
 * Either alone is a guessable or shareable half-secret; together they are the
 * capability the product chose instead of magic links (row 18 of the §12 table, marked
 * `N/A` with the reason).
 *
 * The security consequence drives every decision below, and rule 08 states it directly:
 * the evidence response carries the attendee's ticket and nothing else. It is not an
 * account view, not a payment receipt, and not an event report. So:
 *
 *   - **no payment history** — no attempt list, no provider reference, no raw payload;
 *   - **no check-in log** — the attendee's `status` already tells them they are in, and
 *     the per-entry staff/organiser audit trail is staff-facing;
 *   - **no attendee requests** — a request is a private message, and a response to it
 *     would be delivered by email anyway (FR-21).
 *   - **no phone number** — the email is the second factor being checked; echoing the
 *     phone would add a third identifier to a response that only needs to say "yes,
 *     this ticket, these details".
 *
 * Event details are read **live** (BR-6): an event rescheduled after a ticket was issued
 * must be reflected on the ticket the attendee downloads now, which is the opposite of
 * what a snapshot would do.
 */

import { ForbiddenError, NotFoundError } from "../errors";
import type { EventRepository } from "../events/event.repository";
import { emailsMatch } from "./registration";
import type { RegistrationRepository } from "./registration.repository";
import { toRegistrationEvidenceDTO, type RegistrationEvidenceDTO } from "./evidence.dto";

/**
 * One message for "no such ticket", "wrong email", and "registration belongs to nobody
 * you can prove".
 *
 * The single fixed string is the whole mechanism (rule 08's anti-enumeration rule, and
 * the reason it says "resolve … *or deliberately combine*" rather than translate each
 * case separately): if these three answers differed, the endpoint would confirm which
 * references exist to anyone who could guess or obtain one. The status is `403` for the
 * same reason — a `404` would say "this reference is real but you may not see it",
 * which is one bit more than the caller is entitled to.
 */
const EVIDENCE_UNAVAILABLE_MESSAGE = "No ticket matches that reference and email address.";

/** The attendee's own ticket, and only that. */
export class EvidenceService {
  constructor(
    private readonly registrationRepository: RegistrationRepository,
    private readonly eventRepository: EventRepository,
  ) {}

  /**
   * FR-15: retrieve the ticket evidence for a registration.
   *
   * The lookup is by **reference**, never by row id: the id is not on the PDF, so a
   * lookup by id would be a second, weaker capability on the same endpoint.
   *
   * Tier and event are read *after* the possession check passes, and both are read
   * live. Two consequences, both deliberate:
   *
   *   - the two extra reads cost nothing to an unauthorised caller, because they never
   *     run for one;
   *   - the event is the **current** row (BR-6), so a reschedule or cancellation reaches
   *     a ticket issued weeks earlier, and a soft-deleted event still renders — the
   *     attendee paid for it, so silently blanking the event on their ticket would be
   *     worse than showing a cancelled one.
   */
  async retrieveEvidence(
    uniqueReference: string,
    email: string,
  ): Promise<RegistrationEvidenceDTO> {
    const registration = await this.registrationRepository.findRegistrationByReference(
      uniqueReference,
    );

    if (registration === null || !emailsMatch(registration.attendeeEmail, email)) {
      throw new ForbiddenError(EVIDENCE_UNAVAILABLE_MESSAGE);
    }

    const [tier, event] = await Promise.all([
      this.registrationRepository.findRegistrationTier(registration),
      this.eventRepository.findEventById(registration.eventId),
    ]);

    if (event === null) {
      // Unreachable while the foreign key holds. If it ever happens the ticket cannot
      // be described at all, and saying so plainly beats inventing event details.
      throw new NotFoundError("This ticket's event is no longer available.");
    }

    return toRegistrationEvidenceDTO(registration, tier, event);
  }
}

/**
 * Email comparison for a possession check.
 *
 * Not defined here: it is `emailsMatch` in `./registration`, the one predicate FR-15 and
 * FR-23 both use (P-18). Two copies of "does this email match" would be two different
 * answers to the same question, and the attendee-facing one is the one that decides
 * whether somebody can open their own ticket.
 */

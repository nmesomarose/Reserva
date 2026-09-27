/**
 * The organiser-ownership check, shared by every slice that nests a resource under
 * an event.
 *
 * This is a single function rather than a private method on `EventService`
 * because the TicketType slice needs the *identical* rule, including the exact
 * `404` / `403` split, and a second copy is a second thing to get wrong. PRD §3 and
 * rule 05 require the comparison to be server-side on every request: an `event_id`
 * in a path is never proof of ownership (IDOR).
 *
 * The split itself is product-owner decision R-3 (see
 * `.agents/rules/03` "Resolved product-owner decisions"):
 *
 *   - unknown id -> `404`. It may not exist, or it may not be yours; to a stranger
 *     the two are indistinguishable, and that is deliberate.
 *   - existing id owned by another organiser -> `403`. The caller is authenticated
 *     and the resource exists; answering `404` would be a false statement.
 */

import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import type { EventRecord } from "./event";
import type { EventRepository } from "./event.repository";

/** Organiser-scoped misses are described differently from a public 404. */
export const EVENT_BY_ID_NOT_FOUND_MESSAGE = "No event exists with that id.";

/** A cross-owner attempt never confirms that the row exists. */
export const EVENT_FORBIDDEN_MESSAGE = "This event belongs to another organiser.";

/** The only part of the port this check needs. */
type EventOwnershipLookup = Pick<EventRepository, "findEventById">;

/**
 * Reject an identity the auth boundary should never produce.
 *
 * Reaching this means the boundary handed over an empty organiser id. Failing
 * closed is the only safe reading: an event with no owner would be invisible to
 * its creator and editable by nobody, including whoever guessed its id.
 */
export function requireOrganiserId(organiserId: string): void {
  if (organiserId.trim() === "") {
    throw new ValidationError("An authenticated organiser is required.", {
      organiser: ["No organiser identity was resolved for this request."],
    });
  }
}

/**
 * Load an event the caller owns, or fail.
 *
 * `repository` is a parameter so a caller already holding a transaction scope
 * passes its handle: the ownership read then lands in the same transaction as the
 * write it guards, which is what closes the check-then-write gap (rule 03).
 */
export async function requireOwnedEvent(
  repository: EventOwnershipLookup,
  organiserId: string,
  eventId: string,
): Promise<EventRecord> {
  requireOrganiserId(organiserId);

  const event = await repository.findEventById(eventId);

  if (event === null) {
    throw new NotFoundError(EVENT_BY_ID_NOT_FOUND_MESSAGE);
  }

  if (event.organiserId !== organiserId) {
    throw new ForbiddenError(EVENT_FORBIDDEN_MESSAGE);
  }

  return event;
}

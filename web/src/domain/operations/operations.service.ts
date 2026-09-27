/**
 * Organiser operations rules (PRD v2 §5.9, §12 row 13, §13, §17; FR-22, FR-25, FR-26;
 * R-5 G-1/G-2; rules 05, 06, 08).
 *
 * Three capabilities, all organiser-only, all scoped to one event the caller owns:
 *
 *   - {@link OperationsService.getDashboard} — FR-25's four aggregates.
 *   - {@link OperationsService.getRegistrationRecord} — FR-26's full record (G-1).
 *   - {@link OperationsService.readDashboardForEvent} — the same aggregate, read again
 *     on a timer by the SSE stream (G-2). It takes an already-authorised event rather
 *     than an organiser id, which is the one thing that makes it usable per tick.
 *
 * ## Ownership is checked before every read, and the same check serves all three
 *
 * `requireOwnedEvent` is the shared helper the ticket-type and staff slices already
 * use, with the `404`/`403` split of product-owner decision R-3. Using it here rather
 * than writing a fourth copy is the point: rule 05 requires the check on *every*
 * organiser-scoped request, and an IDOR is what a "nearly the same" check becomes.
 *
 * The SSE stream checks **once**, before the stream opens, and does not re-authorise
 * per event. That is deliberate: re-resolving the session every two seconds would
 * break a dashboard left open all evening, and it buys nothing — the stream is scoped to
 * an event this session already proved it owns, and the per-event data it can therefore
 * push is exactly the data the organiser may read.
 *
 * ## Where the arithmetic lives
 *
 * Nothing here trusts an adapter to have counted correctly or derived availability: the
 * service zero-fills both status maps, derives `available` from BR-3's two counters, and
 * cross-checks the check-in counts against each other. A count that disagrees with the
 * rows behind it is a *defect* (§17, the skill's step 3), so the shape that would reveal
 * it is built here rather than returned as-is.
 */

import { ConflictError, NotFoundError } from "../errors";
import { requireOrganiserId, requireOwnedEvent } from "../events/event-ownership";
import { isTierAvailable } from "../events/event.dto";
import type { EventRecord, TicketTypeRecord } from "../events/event";
import type { EventRepository } from "../events/event.repository";
import {
  PAYMENT_STATUSES,
  REGISTRATION_STATUSES,
  type PaymentStatus,
  type RegistrationStatus,
} from "../registrations/registration";
import {
  toEventDashboardDTO,
  toOrganiserRegistrationRecordDTO,
  type EventDashboardDTO,
  type OrganiserRegistrationRecordDTO,
} from "./operations.dto";
import type { EventOperationsRepository } from "./operations.repository";
import type {
  DashboardCheckInCounts,
  DashboardPaymentCounts,
  DashboardRegistrationCounts,
  DashboardTierSales,
  EventDashboardRecord,
} from "./operations";

/**
 * A registration that is not on this event.
 *
 * `404`, not `403`: the client supplied an id, and the answer to "does this belong to
 * me" must not distinguish "no such id" from "someone else's id", or the route becomes
 * an id oracle across tenants. This is the same reasoning the staff check-in message
 * records, and rule 08's "resolve parent→child relationships before authorising" is what
 * puts the event in the adapter's `WHERE` at all.
 */
const REGISTRATION_NOT_ON_EVENT_MESSAGE = "No such registration exists on this event.";

export class OperationsService {
  constructor(
    private readonly eventRepository: EventRepository,
    private readonly repository: EventOperationsRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * FR-25: the per-event aggregate picture.
   *
   * The event is read first so its identity and timing are part of the same answer, and
   * so ownership is settled before a single aggregate statement runs.
   */
  async getDashboard(organiserId: string, eventId: string): Promise<EventDashboardDTO> {
    const event = await this.authoriseEvent(organiserId, eventId);

    return toEventDashboardDTO(await this.readDashboardForEvent(event));
  }

  /**
   * Resolve the event *after* checking that the caller owns it, and hand it back.
   *
   * This exists for the SSE stream (R-5 G-2), which must authorise once at connect time
   * and then re-read the aggregate on a timer. A stream cannot do that through
   * {@link getDashboard}, because that returns a DTO and the per-tick read needs the
   * event record the aggregate is framed by.
   *
   * It is deliberately a *narrow* capability: it returns the event, not any aggregate,
   * so a caller holding it still has to come back through
   * {@link readDashboardForEvent} — which cannot authorise and therefore cannot be reached
   * from a route. That asymmetry is what makes "authorise once, read many" safe here
   * instead of a way to skip an ownership check.
   */
  async authoriseEvent(organiserId: string, eventId: string): Promise<EventRecord> {
    requireOrganiserId(organiserId);

    return requireOwnedEvent(this.eventRepository, organiserId, eventId);
  }

  /**
   * The aggregate read for an event whose ownership the caller has already established.
   *
   * Takes an `EventRecord` rather than an organiser id on purpose: it is the only way
   * the SSE module can re-read per tick without re-resolving a session, and a route
   * cannot call it because a route has ids, not records.
   */
  async readDashboardForEvent(event: EventRecord): Promise<EventDashboardRecord> {
    const rows = await this.repository.loadDashboard(event.id);

    const registrations = registrationCounts(rows.registrationCounts);
    const payments = paymentCounts(rows.paymentCounts, rows.paymentsRequiringReconciliation);
    const ticketTypes = rows.ticketTypes.map(tierSales);
    const checkIns = checkInCounts(rows.checkIns, registrations.byStatus.checked_in);

    return {
      event: {
        id: event.id,
        name: event.name,
        slug: event.slug,
        status: event.status,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        venue: event.venue,
      },
      registrations,
      payments,
      ticketTypes,
      checkIns,
      // From the service's clock, not the database: the stamp answers "when was this
      // reading taken", which is a fact about the request, not about the data.
      generatedAt: this.now(),
    };
  }

  /**
   * FR-26 / G-1: one registration's full record (PRD §5.9, rule 05).
   *
   * "Not just the latest" and "not just current status" are the operative words: the
   * adapter returns every attempt and every check-in row, and the only way this service
   * could reduce them is by not asking for them.
   */
  async getRegistrationRecord(
    organiserId: string,
    eventId: string,
    registrationId: string,
  ): Promise<OrganiserRegistrationRecordDTO> {
    requireOrganiserId(organiserId);
    await requireOwnedEvent(this.eventRepository, organiserId, eventId);

    const record = await this.repository.findRegistrationRecord(eventId, registrationId);

    if (record === null) {
      throw new NotFoundError(REGISTRATION_NOT_ON_EVENT_MESSAGE);
    }

    return toOrganiserRegistrationRecordDTO(record);
  }
}

/**
 * Registration aggregate, zero-filled across all five states (PRD §9.2).
 *
 * `total` is the sum of the grouped rows rather than a separate `COUNT(*)`, so the
 * total and the breakdown cannot disagree — which is the zero-discrepancy requirement
 * applied to the arithmetic inside one response.
 */
function registrationCounts(
  rows: readonly { readonly status: RegistrationStatus; readonly count: number }[],
): DashboardRegistrationCounts {
  const byStatus = Object.fromEntries(
    REGISTRATION_STATUSES.map((status) => [status, 0]),
  ) as Record<RegistrationStatus, number>;

  let total = 0;

  for (const row of rows) {
    byStatus[row.status] = row.count;
    total += row.count;
  }

  return { total, byStatus };
}

/**
 * Payment aggregate, zero-filled across all five states (PRD §9.1), with R-1's
 * reconciliation flag counted beside them rather than inside them.
 */
function paymentCounts(
  rows: readonly { readonly status: PaymentStatus; readonly count: number }[],
  requiresReconciliation: number,
): DashboardPaymentCounts {
  const byStatus = Object.fromEntries(
    PAYMENT_STATUSES.map((status) => [status, 0]),
  ) as Record<PaymentStatus, number>;

  let attempts = 0;

  for (const row of rows) {
    byStatus[row.status] = row.count;
    attempts += row.count;
  }

  return { attempts, byStatus, requiresReconciliation };
}

/**
 * Per-tier sales, with `available` **derived** from BR-3's two counters.
 *
 * The same subtraction the public event page performs, and `sold_out` is
 * `!isTierAvailable(tier)` rather than `available <= 0` written again — one definition
 * of "sold out" for the whole product, so the page and the dashboard cannot disagree
 * about an event that is one seat away from full.
 */
function tierSales(tier: TicketTypeRecord): DashboardTierSales {
  const available = tier.quantityTotal - tier.quantityConfirmed - tier.quantityHeld;

  return {
    ticketTypeId: tier.id,
    name: tier.name,
    priceMinorUnits: tier.priceMinorUnits,
    currency: tier.currency,
    quantityTotal: tier.quantityTotal,
    quantityConfirmed: tier.quantityConfirmed,
    quantityHeld: tier.quantityHeld,
    available,
    soldOut: !isTierAvailable(tier),
  };
}

/**
 * Check-in aggregate, cross-checked against the cached projection.
 *
 * `registrations_checked_in` comes from the log (the source of truth, §9.4). The
 * cached `Registration.status = checked_in` is the projection §7.4 maintains in the same
 * transaction as every check-in insert, and the two are compared here rather than
 * trusted: §17 requires "zero discrepancy", and the skill's stop condition is explicit
 * that a disagreement must be *reported*, not recomputed.
 *
 * ## Why the comparison is one-directional
 *
 * The projection may legitimately **lag** the log, and must never **lead** it.
 *
 *   - Lagging: a registration that was checked in and afterwards refunded or cancelled
 *     is `refunded`/`cancelled` today while its append-only log row still exists (BR-7
 *     moves a registration to a terminal state from which check-in is forbidden *in*,
 *     not one that erases the record of a door having opened for it). That is a
 *     consistent database, and refusing the whole dashboard over it would be worse than
 *     useless at exactly the moment an organiser is reconciling a bad night.
 *   - Leading: `registrations.status = checked_in` with no log row behind it. §9.2
 *     forbids `cancelled/refunded -> checked_in`, so the projection can only get there
 *     by a write that skipped the check-in transaction, or by a check-in row that was
 *     lost. That is the defect "zero discrepancy" is about, and it is reported.
 *
 * Reporting is a `409` rather than a patched number or a silent fix. A caller seeing
 * `409` learns the platform's own records disagree, which is the one thing an organiser
 * needs to be told; a dashboard that quietly corrected itself would hide a missing
 * same-transaction write until somebody reconciled stock by hand.
 */
function checkInCounts(
  row: { readonly entries: number; readonly overrides: number; readonly registrationsCheckedIn: number },
  checkedInProjection: number,
): DashboardCheckInCounts {
  if (row.entries < row.registrationsCheckedIn || row.overrides > row.entries) {
    throw new ConflictError(
      "The check-in log is internally inconsistent; this event's dashboard is not available until it is reconciled.",
    );
  }

  if (checkedInProjection > row.registrationsCheckedIn) {
    throw new ConflictError(
      "This event's check-in log and its registration records disagree, so no dashboard is served until they are reconciled.",
    );
  }

  return {
    registrationsCheckedIn: row.registrationsCheckedIn,
    entries: row.entries,
    overrides: row.overrides,
  };
}

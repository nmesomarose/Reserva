/**
 * Persistence port for the organiser's operational reads (PRD v2 §5.9, §7.4, §12
 * row 13, §17; FR-25, FR-26).
 *
 * ## Why these two reads are one snapshot each
 *
 * A dashboard assembled from four independent statements can straddle a commit: the
 * check-in count read one millisecond after a check-in lands, and the registration
 * total read one millisecond before the projection flips, disagree — with the log the
 * organiser is looking at in the next tab. That is precisely the "count disagrees with
 * the underlying rows" defect §17 forbids, and it is invisible in a test that writes
 * its fixture first and reads it after.
 *
 * So both methods are specified as **one consistent snapshot**: implementations MUST
 * read at a single isolation level strong enough that a concurrent writer is either
 * wholly visible or wholly invisible (`REPEATABLE READ` or better), and MUST NOT answer
 * with a partially-updated dashboard if one statement fails.
 *
 * The same is true of FR-26's record: a payment-attempt list read from one snapshot and
 * a check-in log read from another would show a registration whose attempts the log has
 * not caught up with, which reads as a defect and is one.
 *
 * ## Why this port returns *rows*, not aggregates
 *
 * `loadDashboard` returns grouped rows and stored tier rows; the service turns them
 * into `DashboardRegistrationCounts` / `DashboardPaymentCounts` / `DashboardTierSales`.
 * That split is deliberate:
 *
 *   - **zero-filling the enums is domain work.** "A `pending_payment` event still
 *     reports `pending_payment: 0`" is a statement about the *shape of the product's
 *     answer*, not about SQL, and an adapter that emitted only the states it happened
 *     to find would make the wire format depend on the data.
 *   - **`available` is derived, never stored** (BR-3). Computing it next to
 *     `isTierAvailable` — the same pure function the public event page uses — is what
 *     makes "sold out on the page" and "sold out on the dashboard" the same statement
 *     by construction rather than by review.
 */

import type { PaymentStatus, RegistrationStatus } from "../registrations/registration";
import type { TicketTypeRecord } from "../events/event";
import type { OrganiserRegistrationRecord } from "./operations";

/** One `GROUP BY status` row of the registration aggregate. */
export interface RegistrationStatusCountRow {
  readonly status: RegistrationStatus;
  readonly count: number;
}

/** One `GROUP BY status` row of the payment aggregate. */
export interface PaymentStatusCountRow {
  readonly status: PaymentStatus;
  readonly count: number;
}

/** The check-in log's three counts, aggregated from the append-only rows. */
export interface CheckInAggregateRow {
  /** Every row in the log, overrides included (BR-4). */
  readonly entries: number;
  /** The subset recorded as deliberate repeats. */
  readonly overrides: number;
  /** Distinct registrations with at least one row — the people through the door. */
  readonly registrationsCheckedIn: number;
}

/** The grouped rows the service assembles the four FR-25 aggregates from. */
export interface DashboardAggregateRows {
  readonly registrationCounts: readonly RegistrationStatusCountRow[];
  readonly paymentCounts: readonly PaymentStatusCountRow[];
  /** R-1's flag, counted separately because it is never a status. */
  readonly paymentsRequiringReconciliation: number;
  readonly ticketTypes: readonly TicketTypeRecord[];
  readonly checkIns: CheckInAggregateRow;
}

export interface EventOperationsRepository {
  /**
   * Every FR-25 aggregate for one event, read as one consistent snapshot.
   *
   * The event id is a *parameter of each statement*, not a filter applied afterwards:
   * `registrations`, `ticket_types`, and therefore every `payments` and `check_ins` row
   * reachable from them are selected by `event_id` inside the query itself. There is no
   * code path in this method by which another event's rows can enter the result.
   */
  loadDashboard(eventId: string): Promise<DashboardAggregateRows>;

  /**
   * FR-26: one registration of *this* event, with its tier, its event, **every**
   * payment attempt, and the **whole** check-in log.
   *
   * Returns `null` for a registration that does not exist **and** for one belonging to
   * another event, so an organiser cannot probe ids across tenants through this route.
   * Both collections are ordered in the port contract — payments newest first so
   * "the latest attempt" is element zero, check-ins oldest first so element zero is the
   * original entry (§4.4.4) — because a service that has to re-sort is a service that
   * can be given the wrong order.
   */
  findRegistrationRecord(
    eventId: string,
    registrationId: string,
  ): Promise<OrganiserRegistrationRecord | null>;
}

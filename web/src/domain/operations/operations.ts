/**
 * Organiser operational records and reporting (PRD v2 §5.9, §7.4, §12 row 13,
 * §13, §14, §17; FR-25, FR-26, FR-22).
 *
 * One module for both, because they are the same §5.9 capability seen at two
 * granularities: the per-event aggregates an organiser watches during an event, and
 * the full record behind any one of those numbers.
 *
 * ## The rule that shapes every aggregate here
 *
 * "Dashboard counts match underlying data with zero discrepancy" (§17) is a
 * requirement about *provenance*, not about arithmetic. Each count therefore names
 * the rows it is derived from, and the skill is explicit about two of them:
 *
 *   - the **payment-status breakdown** is derived from the `payments` table and its
 *     lifecycle, never from `Registration.status`. `Registration.status` is a cached
 *     projection (§7.4) and is not a payment state; reading it as one would make the
 *     dashboard disagree with the payment log the moment a reversal arrived.
 *   - the **check-in count** is derived from the append-only `check_ins` log, which is
 *     the source of truth for "when and by whom" (§9.4). `Registration.status =
 *     checked_in` is allowed as a *cross-check* and is proved never to exceed the log by
 *     a test, not used as the number itself. It may fall behind it — BR-7 can move a
 *     checked-in registration to `refunded`/`cancelled` while the log row stands — which
 *     is why the check is one-directional; see `checkInCounts` in `operations.service.ts`.
 *
 * The registration breakdown does use `Registration.status`, and only for that: it is
 * the indexed column §7.4 denormalised precisely so this list view can filter on it.
 */

import type { CheckInRecord } from "../staff/staff";
import type {
  PaymentRecord,
  PaymentStatus,
  RegistrationStatus,
} from "../registrations/registration";
import type { EventRecord, TicketTypeRecord } from "../events/event";

/**
 * Registration counts (FR-25's first aggregate).
 *
 * `total` is the event's registration rows, and `byStatus` is zero-filled across all
 * five states so the shape is stable: a client renders a breakdown without having to
 * know in advance which states exist in a given event. A missing key would be
 * indistinguishable from a state the product does not have.
 *
 * The per-status map is a **flagged superset** of FR-25, which names "registrations"
 * without saying "a breakdown": the skill's stop condition asks that a new breakdown
 * be raised rather than assumed, so it is recorded as design position P-17 rather
 * than slipped in.
 */
export interface DashboardRegistrationCounts {
  readonly total: number;
  readonly byStatus: Readonly<Record<RegistrationStatus, number>>;
}

/**
 * Payment counts (FR-25's second aggregate).
 *
 * `attempts` is every `payments` row for the event's registrations — §7.3's 1:N means
 * one registration can hold several attempts, and a breakdown that counted
 * registrations rather than attempts would not be the payment picture.
 *
 * `requiresReconciliation` is counted *separately* rather than folded into a status,
 * because R-1 makes it a flag and never a status: a `success` attempt flagged for
 * review is neither a success nor a failure, and §8.5 requires a human to be able to
 * find it. It is organiser/audit surface (rule 08), which is the only audience this
 * dashboard serves.
 */
export interface DashboardPaymentCounts {
  readonly attempts: number;
  readonly byStatus: Readonly<Record<PaymentStatus, number>>;
  readonly requiresReconciliation: number;
}

/**
 * Per-tier sales and availability (FR-25's third aggregate).
 *
 * `available` is **derived** from the two counters (BR-3) and never stored or
 * supplied: `total - confirmed - held`. The same arithmetic the public event page
 * performs, and it is exposed here — unlike on the public DTO — because an organiser
 * configuring tiers needs the actual inventory, which is exactly what §13 withholds
 * from the public.
 */
export interface DashboardTierSales {
  readonly ticketTypeId: string;
  readonly name: string;
  readonly priceMinorUnits: number;
  readonly currency: string;
  readonly quantityTotal: number;
  readonly quantityConfirmed: number;
  readonly quantityHeld: number;
  readonly available: number;
  /** `true` when `available <= 0` — sold out, in the public page's own terms (§13). */
  readonly soldOut: boolean;
}

/**
 * Check-in counts (FR-25's fourth aggregate).
 *
 * Three numbers rather than one, because "check-ins" has two honest readings and a
 * dashboard that picks one silently is the kind of ambiguity §17's zero-discrepancy
 * clause is about:
 *
 *   - `registrationsCheckedIn` — distinct registrations that have at least one row in
 *     the log. **This is the event-day number**: how many people have come through
 *     the door, which is what FR-22's 5-second propagation is about.
 *   - `entries` — every row in the append-only log, overrides included (BR-4: an
 *     override is its own auditable row).
 *   - `overrides` — the subset of entries recorded as deliberate repeats.
 *
 * `entries` therefore equals `registrationsCheckedIn + overrides` for any event with
 * at most one override per registration, and the identity is asserted in the database
 * tests so a future change to the check-in path cannot quietly make the three
 * numbers disagree.
 */
export interface DashboardCheckInCounts {
  readonly registrationsCheckedIn: number;
  readonly entries: number;
  readonly overrides: number;
}

/** The event context repeated on the dashboard, so one response is self-contained. */
export interface DashboardEventSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly venue: string;
}

/** The whole per-event picture (FR-25). */
export interface EventDashboardRecord {
  readonly event: DashboardEventSummary;
  readonly registrations: DashboardRegistrationCounts;
  readonly payments: DashboardPaymentCounts;
  readonly ticketTypes: readonly DashboardTierSales[];
  readonly checkIns: DashboardCheckInCounts;
  /**
   * The instant the snapshot was taken.
   *
   * A dashboard is a *reading*, not a fact, and on a busy event the numbers move while
   * the organiser looks at them. Without a timestamp, two reads of the same page are
   * indistinguishable from a dashboard that is lying.
   */
  readonly generatedAt: Date;
}

/**
 * FR-26's full record: one registration, every payment attempt, the whole check-in
 * log.
 *
 * §5.9's wording is what makes this a different endpoint from the staff search: "not
 * just the latest" and "not just current status" appear twice, and a search row
 * answers neither. It is the organiser/audit surface (rule 08), so
 * {@link OrganiserPaymentRecord} is the one place a raw provider payload is exposed —
 * and the attendee evidence endpoint deliberately does not reach this shape.
 */
export interface OrganiserRegistrationRecord {
  readonly registration: {
    readonly id: string;
    readonly uniqueReference: string;
    readonly attendeeName: string;
    readonly attendeeEmail: string;
    readonly attendeePhone: string;
    readonly status: RegistrationStatus;
    readonly createdAt: Date;
  };
  /** The tier as bought, read from the registration — not from any request. */
  readonly ticketType: TicketTypeRecord;
  /** Newest first, so "the latest attempt" is the first element (FR-26 needs all). */
  readonly payments: readonly OrganiserPaymentRecord[];
  /** Oldest first, so the first row is the original check-in (§4.4.4). */
  readonly checkIns: readonly CheckInRecord[];
  /** The event context, live rather than snapshotted (BR-6). */
  readonly event: EventRecord;
}

/**
 * One payment attempt as the organiser/audit surface sees it.
 *
 * `providerReference` and `rawProviderPayload` are here and only here: §18 makes full
 * payloads organiser/audit-only, and this is the audit surface. Neither is ever
 * projected into an attendee or staff DTO — the omission in `registration.dto.ts` and
 * `staff.dto.ts` is the enforcement, and the tests assert their absence by field name.
 *
 * An alias rather than a copy, so the audit view cannot drift from the stored shape it
 * is claiming to expose.
 */
export type OrganiserPaymentRecord = PaymentRecord;

/**
 * Organiser-facing projections for §5.9 (rule 06: hand-defined DTOs; rule 08:
 * allow-lists per role).
 *
 * Three shapes, and the boundaries between them are the interesting part:
 *
 *   - {@link EventDashboardDTO} is the aggregate read. It carries the event's identity
 *     and timestamps, the four FR-25 aggregates, and `generated_at`.
 *   - {@link OrganiserRegistrationRecordDTO} is FR-26's full record: the only
 *     response in the product that includes a raw provider payload, because it is the
 *     audit surface (§18) and §5.9 asks for the payment-attempt *history*.
 *   - {@link OrganiserCheckInDTO} is the check-in log as the organiser reads it. The
 *     actor is a union because §7.2 stores it in two columns
 *     (`organiser_id`/`staff_token_id`) and a client must not have to guess which id
 *     it is looking at — the same reason `CheckInActorDTO` exists on the staff side.
 *
 * What is deliberately **absent** from the dashboard: revenue, refunds totals, ticket
 * transfers, request counts, and per-attendee rows. FR-25 names four aggregates and
 * the skill's stop condition requires a new one to be raised rather than added.
 */

import type { EventRecord, TicketTypeRecord } from "../events/event";
import type {
  PaymentStatus,
  RegistrationStatus,
} from "../registrations/registration";
import type { CheckInRecord } from "../staff/staff";
import type {
  DashboardCheckInCounts,
  DashboardPaymentCounts,
  DashboardRegistrationCounts,
  DashboardTierSales,
  EventDashboardRecord,
  OrganiserPaymentRecord,
  OrganiserRegistrationRecord,
} from "./operations";

/** The event identity and timing, repeated so one dashboard response is self-contained. */
export interface DashboardEventDTO {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: string;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly venue: string;
}

/**
 * FR-25 aggregate 1: registrations.
 *
 * `by_status` is a full object rather than a sparse map, and the domain fills every
 * state with zero — a client must be able to render a five-state breakdown without
 * first proving which states this particular event has reached.
 */
export interface DashboardRegistrationDTO {
  readonly total: number;
  readonly by_status: Readonly<Record<RegistrationStatus, number>>;
}

/**
 * FR-25 aggregate 2: the payment-status breakdown.
 *
 * `attempts` counts `payments` rows, not registrations (§7.3 is 1:N, and an attendee
 * who paid once and retried has two attempts against one registration). The
 * `requires_reconciliation` count is separate for the reason R-1 gives: it is a flag,
 * never a status, and a dashboard that folded it into `success` would contradict §8.5's
 * "a human must be able to see it".
 */
export interface DashboardPaymentDTO {
  readonly attempts: number;
  readonly by_status: Readonly<Record<PaymentStatus, number>>;
  readonly requires_reconciliation: number;
}

/** FR-25 aggregate 3: per-tier sales and availability (BR-3's two counters, derived). */
export interface DashboardTicketTypeDTO {
  readonly ticket_type_id: string;
  readonly name: string;
  readonly price_minor_units: number;
  readonly currency: string;
  readonly quantity_total: number;
  readonly quantity_confirmed: number;
  readonly quantity_held: number;
  /** `quantity_total - quantity_confirmed - quantity_held`, derived server-side. */
  readonly available: number;
  readonly sold_out: boolean;
}

/** FR-25 aggregate 4: the check-in log's counts, from the append-only rows themselves. */
export interface DashboardCheckInDTO {
  readonly registrations_checked_in: number;
  readonly entries: number;
  readonly overrides: number;
}

/** The whole per-event picture. */
export interface EventDashboardDTO {
  readonly event: DashboardEventDTO;
  readonly registrations: DashboardRegistrationDTO;
  readonly payments: DashboardPaymentDTO;
  readonly ticket_types: readonly DashboardTicketTypeDTO[];
  readonly check_ins: DashboardCheckInDTO;
  /** When this snapshot was read, so two reads can be told apart. */
  readonly generated_at: string;
}

/** One payment attempt, organiser/audit view. The only place a raw payload appears. */
export interface OrganiserPaymentDTO {
  readonly id: string;
  readonly provider_reference: string;
  readonly status: PaymentStatus;
  readonly expected_amount_minor_units: number;
  readonly verified_amount_minor_units: number | null;
  readonly currency: string;
  readonly verified_at: string | null;
  readonly requires_reconciliation: boolean;
  readonly created_at: string;
  /**
   * The provider's raw response, verbatim (rule 08's organiser/audit exception).
   *
   * Serialised as-is rather than summarised: §14 retains it for dispute resolution,
   * and a summary would be a second thing to keep faithful. It is `unknown` because
   * the column is JSON and the platform does not own its shape.
   */
  readonly raw_provider_payload: unknown;
  readonly updated_at: string;
}

/** Who performed a check-in, discriminated so the id cannot be mistaken for the other kind. */
export type OrganiserCheckInActorDTO =
  | { readonly kind: "staff_token"; readonly staff_token_id: string }
  | { readonly kind: "organiser"; readonly organiser_id: string };

/** One row of the full check-in log, overrides included (BR-4). */
export interface OrganiserCheckInDTO {
  readonly id: string;
  readonly checked_in_at: string;
  readonly is_override: boolean;
  readonly performed_by: OrganiserCheckInActorDTO;
}

/** The tier the registration was bought against, with its inventory at read time. */
export interface OrganiserTicketTypeDTO {
  readonly id: string;
  readonly name: string;
  readonly price_minor_units: number;
  readonly currency: string;
  readonly quantity_total: number;
  readonly quantity_confirmed: number;
  readonly quantity_held: number;
}

/** FR-26: the registration itself, with unmasked contact (the organiser owns it). */
export interface OrganiserRegistrationDTO {
  readonly id: string;
  readonly unique_reference: string;
  readonly attendee_name: string;
  readonly attendee_email: string;
  readonly attendee_phone: string;
  readonly status: RegistrationStatus;
  readonly created_at: string;
}

/** The event context, live rather than snapshotted (BR-6). */
export interface OrganiserRegistrationEventDTO {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly venue: string;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly status: string;
}

/** FR-26's full record: registration + tier + every attempt + the whole check-in log. */
export interface OrganiserRegistrationRecordDTO {
  readonly event: OrganiserRegistrationEventDTO;
  readonly registration: OrganiserRegistrationDTO;
  readonly ticket_type: OrganiserTicketTypeDTO;
  readonly payments: readonly OrganiserPaymentDTO[];
  readonly check_ins: readonly OrganiserCheckInDTO[];
}

export function toDashboardEventDTO(event: EventDashboardRecord["event"]): DashboardEventDTO {
  return {
    id: event.id,
    name: event.name,
    slug: event.slug,
    status: event.status,
    starts_at: event.startsAt.toISOString(),
    ends_at: event.endsAt.toISOString(),
    venue: event.venue,
  };
}

export function toDashboardRegistrationDTO(
  counts: DashboardRegistrationCounts,
): DashboardRegistrationDTO {
  return { total: counts.total, by_status: { ...counts.byStatus } };
}

export function toDashboardPaymentDTO(counts: DashboardPaymentCounts): DashboardPaymentDTO {
  return {
    attempts: counts.attempts,
    by_status: { ...counts.byStatus },
    requires_reconciliation: counts.requiresReconciliation,
  };
}

export function toDashboardTicketTypeDTO(tier: DashboardTierSales): DashboardTicketTypeDTO {
  return {
    ticket_type_id: tier.ticketTypeId,
    name: tier.name,
    price_minor_units: tier.priceMinorUnits,
    currency: tier.currency,
    quantity_total: tier.quantityTotal,
    quantity_confirmed: tier.quantityConfirmed,
    quantity_held: tier.quantityHeld,
    available: tier.available,
    sold_out: tier.soldOut,
  };
}

export function toDashboardCheckInDTO(counts: DashboardCheckInCounts): DashboardCheckInDTO {
  return {
    registrations_checked_in: counts.registrationsCheckedIn,
    entries: counts.entries,
    overrides: counts.overrides,
  };
}

export function toEventDashboardDTO(record: EventDashboardRecord): EventDashboardDTO {
  return {
    event: toDashboardEventDTO(record.event),
    registrations: toDashboardRegistrationDTO(record.registrations),
    payments: toDashboardPaymentDTO(record.payments),
    ticket_types: record.ticketTypes.map(toDashboardTicketTypeDTO),
    check_ins: toDashboardCheckInDTO(record.checkIns),
    generated_at: record.generatedAt.toISOString(),
  };
}

export function toOrganiserPaymentDTO(payment: OrganiserPaymentRecord): OrganiserPaymentDTO {
  return {
    id: payment.id,
    provider_reference: payment.providerReference,
    status: payment.status,
    expected_amount_minor_units: payment.expectedAmountMinorUnits,
    verified_amount_minor_units: payment.verifiedAmountMinorUnits,
    currency: payment.currency,
    verified_at: payment.verifiedAt === null ? null : payment.verifiedAt.toISOString(),
    requires_reconciliation: payment.requiresReconciliation,
    created_at: payment.createdAt.toISOString(),
    raw_provider_payload: payment.rawProviderPayload,
    updated_at: payment.updatedAt.toISOString(),
  };
}

/**
 * The actor union, mirroring `CheckInActorDTO` on the staff side.
 *
 * The difference is the label: staff already know which token they presented, while an
 * organiser auditing a shift needs the token *id* to correlate it with the token
 * listing, so this side reports ids on both branches and leaves presentation to the
 * client.
 */
export function toOrganiserCheckInDTO(checkIn: CheckInRecord): OrganiserCheckInDTO {
  if (checkIn.staffTokenId !== null) {
    return {
      id: checkIn.id,
      checked_in_at: checkIn.checkedInAt.toISOString(),
      is_override: checkIn.isOverride,
      performed_by: { kind: "staff_token", staff_token_id: checkIn.staffTokenId },
    };
  }

  if (checkIn.organiserId === null) {
    // Unreachable: `check_ins_exactly_one_actor_check` rejects a row naming neither, and
    // the staff slice's mapper argues the same point. Throwing beats emitting an audit
    // row that claims nobody did it.
    throw new Error("A check-in row must name exactly one actor (organiser or staff token).");
  }

  return {
    id: checkIn.id,
    checked_in_at: checkIn.checkedInAt.toISOString(),
    is_override: checkIn.isOverride,
    performed_by: { kind: "organiser", organiser_id: checkIn.organiserId },
  };
}

export function toOrganiserTicketTypeDTO(tier: TicketTypeRecord): OrganiserTicketTypeDTO {
  return {
    id: tier.id,
    name: tier.name,
    price_minor_units: tier.priceMinorUnits,
    currency: tier.currency,
    quantity_total: tier.quantityTotal,
    quantity_confirmed: tier.quantityConfirmed,
    quantity_held: tier.quantityHeld,
  };
}

export function toOrganiserRegistrationRecordDTO(
  record: OrganiserRegistrationRecord,
): OrganiserRegistrationRecordDTO {
  return {
    event: toOrganiserRegistrationEventDTO(record.event),
    registration: {
      id: record.registration.id,
      unique_reference: record.registration.uniqueReference,
      attendee_name: record.registration.attendeeName,
      attendee_email: record.registration.attendeeEmail,
      attendee_phone: record.registration.attendeePhone,
      status: record.registration.status,
      created_at: record.registration.createdAt.toISOString(),
    },
    ticket_type: toOrganiserTicketTypeDTO(record.ticketType),
    payments: record.payments.map(toOrganiserPaymentDTO),
    check_ins: record.checkIns.map(toOrganiserCheckInDTO),
  };
}

function toOrganiserRegistrationEventDTO(event: EventRecord): OrganiserRegistrationEventDTO {
  return {
    id: event.id,
    name: event.name,
    slug: event.slug,
    venue: event.venue,
    starts_at: event.startsAt.toISOString(),
    ends_at: event.endsAt.toISOString(),
    status: event.status,
  };
}

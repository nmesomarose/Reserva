/**
 * Attendee-facing DTOs for registration and payment (PRD v2 §12, §13, rule 06,
 * rule 08).
 *
 * ## The projection rule that shapes this file
 *
 * An allow-list, like every other DTO here — and the omissions are the point.
 * Three things are deliberately **absent** from every attendee-facing shape:
 *
 *   - `provider_reference` and the row `id` of the `Payment`. Rule 08 is explicit
 *     that provider references and gateway diagnostics are organiser/audit surface.
 *     An attendee holding one could attempt to verify or replay it against
 *     `/payments/verify`, and the reference is also the webhook lookup key, so
 *     leaking it widens the replay surface described in
 *     `docs/evidence/flutterwave-verify-resolution.md` §"Residual risk".
 *   - `requires_reconciliation` (R-1). It is an organiser queue filter, not an
 *     attendee concept. §15/§17 require the attendee to be told the honest outcome,
 *     which {@link attendeePaymentState} does, without exposing the flag itself.
 *   - `raw_provider_payload` in any form, ever.
 *
 * What the attendee *does* get is deliberately small and sufficient: their
 * reference (the one they must keep — FR-15's first factor), the tier they chose
 * (FR-14 names the tier as part of the confirmation), the amount and currency
 * they are being asked to pay, and the state with a deadline.
 *
 * ## Why `hold_expires_at` is in the attendee response
 *
 * PRD §17 requires the "confirming your payment" state to be *explicit and
 * time-bounded, paired with the 15-minute hold window*. A state name with no
 * deadline does not satisfy that: the attendee cannot act on a window they cannot
 * see. It is also the only honest way to present a `pending_payment` row — the
 * tier hold is real, and so is the moment it lapses.
 */

import type { PaymentRecord, RegistrationRecord, RegistrationStatus } from "./registration";
import { holdDeadline } from "./registration";

/** The attendee's own registration, as they are entitled to see it (FR-15). */
export interface AttendeeRegistrationDTO {
  /** The reference to quote for FR-15 evidence and to quote to staff at the door. */
  readonly unique_reference: string;
  readonly attendee_name: string;
  readonly attendee_email: string;
  readonly attendee_phone: string;
  /** The tier bought — FR-14 requires the confirmation to name it. */
  readonly ticket_type_name: string;
  readonly status: RegistrationStatus;
  /**
   * When the tier hold lapses (BR-3's 15 minutes), or `null` once the hold has
   * been consumed by confirmation or released by cancellation. A `null` here is
   * meaningful: there is nothing left to wait for.
   */
  readonly hold_expires_at: string | null;
  readonly created_at: string;
}

/** The attendee's payment attempt, without any provider detail (rule 08). */
export interface AttendeePaymentDTO {
  readonly status: PaymentStateView;
  /** Integer minor units (PRD §7.2) — the same unit the public tier DTO uses. */
  readonly expected_amount_minor_units: number;
  readonly currency: string;
  /**
   * Present only once the provider has confirmed the amount. `null` before that,
   * including on a confirmed registration, where the value is then always equal to
   * the expected amount (PRD §11 blocks any other outcome).
   */
  readonly verified_amount_minor_units: number | null;
  readonly created_at: string;
}

/**
 * The payment state names an attendee sees (PRD §15).
 *
 * A **projection**, not `Payment.status` verbatim: rule 03 R-1 keeps the
 * reconciliation flag out of the status enum, and §15 requires a `success` payment
 * carrying that flag to read as reconciliation rather than as a failure or as a
 * clean confirmation. The mapping is a product decision, so it is stated in one
 * place here instead of being inlined at each call site.
 */
export type PaymentStateView =
  | "awaiting_payment"
  | "processing"
  | "confirmed"
  | "failed"
  | "pending"
  | "requires_reconciliation";

const PAYMENT_STATE_VIEWS: readonly PaymentStateView[] = [
  "awaiting_payment",
  "processing",
  "confirmed",
  "failed",
  "pending",
  "requires_reconciliation",
];

export function isPaymentStateView(value: unknown): value is PaymentStateView {
  return typeof value === "string" && PAYMENT_STATE_VIEWS.includes(value as PaymentStateView);
}

/**
 * Map a stored attempt onto the attendee-visible state (PRD §15, R-1).
 *
 * Reconciliation is checked **first** and outranks every status: a `success`
 * attempt flagged for review must never render as `confirmed`, because that would
 * tell the attendee a ticket exists when the platform has not granted one. §17's
 * "never show a false failure" is satisfied by the same ordering from the other
 * side — it is reported as reconciliation, not as `failed`.
 */
export function attendeePaymentState(payment: PaymentRecord): PaymentStateView {
  if (payment.requiresReconciliation) {
    return "requires_reconciliation";
  }

  switch (payment.status) {
    case "initiated":
      return "awaiting_payment";
    case "processing":
    case "pending":
      return "processing";
    case "success":
      return "confirmed";
    case "failed":
      return "failed";
  }
}

/**
 * The `POST /api/v1/events/{id}/registrations` response: PRD §12's "draft
 * registration + payment redirect URL".
 *
 * `redirect_url` is the provider's hosted link, obtained by a **server-side**
 * call (evidence §6). No client-side integration exists in this product, so this
 * URL is the only way an attendee reaches checkout and the secret key never
 * appears in any response.
 */
export interface RegistrationCheckoutDTO {
  readonly registration: AttendeeRegistrationDTO;
  readonly payment: AttendeePaymentDTO;
  /**
   * Where to send the attendee. `null` only when the provider could not be reached
   * for a *new* checkout (see `PaymentProviderError.mayHaveMoved`); a replayed
   * idempotency key still returns the original link from
   * `raw_provider_payload`.
   */
  readonly redirect_url: string | null;
}

export function toAttendeeRegistrationDTO(
  registration: RegistrationRecord,
  ticketTypeName: string,
): AttendeeRegistrationDTO {
  const stillHeld = registration.status === "pending_payment";

  return {
    unique_reference: registration.uniqueReference,
    attendee_name: registration.attendeeName,
    attendee_email: registration.attendeeEmail,
    attendee_phone: registration.attendeePhone,
    ticket_type_name: ticketTypeName,
    status: registration.status,
    // BR-3's window is only meaningful while the hold is actually outstanding; a
    // confirmed or cancelled row would otherwise show a deadline that has already
    // passed, implying the attendee is still waiting when they are not.
    hold_expires_at: stillHeld ? holdDeadline(registration).toISOString() : null,
    created_at: registration.createdAt.toISOString(),
  };
}

export function toAttendeePaymentDTO(payment: PaymentRecord): AttendeePaymentDTO {
  return {
    status: attendeePaymentState(payment),
    expected_amount_minor_units: payment.expectedAmountMinorUnits,
    currency: payment.currency,
    verified_amount_minor_units: payment.verifiedAmountMinorUnits,
    created_at: payment.createdAt.toISOString(),
  };
}

/**
 * The `POST/GET /api/v1/payments/verify` response: PRD §12's
 * "Confirmed/failed/pending".
 *
 * A projection of its own rather than a reuse of {@link RegistrationCheckoutDTO},
 * for two reasons that are both about what this particular body is:
 *
 *   - it answers a *state* question, not a "here is your purchase" question, so it
 *     carries the registration's reference, tier, status, and hold deadline and
 *     nothing else;
 *   - it is the response most likely to be displayed, bookmarked, or copied out of
 *     a browser's address bar by an attendee who was redirected here from the
 *     provider. The attendee's email and phone are deliberately absent: nothing in
 *     this surface needs them, so they are not carried into a URL-facing body.
 *
 * `outcome` is derived from the stored attempt rather than from which code path
 * produced it, and that is what makes §12's "idempotent — safe to call
 * repeatedly" true of the *body* as well as the state: a second `/verify` call
 * answers `confirmed` because the row says `success`, not because the first call
 * happened to be the one that confirmed it.
 */
export interface AttendeePaymentResolutionDTO {
  readonly outcome: AttendeeResolutionOutcome;
  readonly registration: AttendeeResolutionRegistrationDTO | null;
  readonly payment: AttendeeResolutionPaymentDTO | null;
}

export type AttendeeResolutionOutcome =
  | "confirmed"
  | "pending"
  | "failed"
  | "requires_reconciliation"
  | "not_found";

export interface AttendeeResolutionRegistrationDTO {
  readonly unique_reference: string;
  readonly ticket_type_name: string | null;
  readonly status: RegistrationStatus;
  /** `null` once the hold has been consumed or released — there is nothing to wait for. */
  readonly hold_expires_at: string | null;
}

export interface AttendeeResolutionPaymentDTO {
  readonly status: PaymentStateView;
  readonly expected_amount_minor_units: number;
  readonly currency: string;
  readonly verified_amount_minor_units: number | null;
  readonly verified_at: string | null;
}

/**
 * The five states §12 names for this endpoint, mapped from what is stored.
 *
 * `requires_reconciliation` is checked first and outranks `success`, for the same
 * reason {@link attendeePaymentState} checks it first: a verified payment that was
 * not applied must never read as `confirmed` (§15, §17). It is also never reported
 * as `failed` — the money moved, and §17 forbids a false failure.
 */
export function toAttendeeResolutionOutcome(payment: PaymentRecord | null): AttendeeResolutionOutcome {
  if (payment === null) {
    return "not_found";
  }

  switch (attendeePaymentState(payment)) {
    case "confirmed":
      return "confirmed";
    case "failed":
      return "failed";
    case "requires_reconciliation":
      return "requires_reconciliation";
    case "awaiting_payment":
    // `attendeePaymentState` maps a `pending` attempt to `processing` today, but the
    // state name exists in §9.1's vocabulary and must keep reporting "not yet
    // settled" if that mapping ever changes. Listed rather than left to fall through.
    case "pending":
    case "processing":
      return "pending";
  }
}

/**
 * Build the §12 verify body from stored records.
 *
 * Takes the three fields it needs rather than the service's outcome type, so this
 * module stays free of a dependency on the service (AGENTS.md §4's layer rule) and
 * so the projection can be exercised in a test without constructing an outcome.
 * A `PaymentResolutionOutcome` is structurally assignable to this shape, which is
 * what lets a route pass one straight in.
 */
export function toAttendeePaymentResolutionDTO(input: {
  readonly registration: RegistrationRecord | null;
  readonly payment: PaymentRecord | null;
  readonly ticketTypeName: string | null;
}): AttendeePaymentResolutionDTO {
  const { registration, payment, ticketTypeName } = input;

  return {
    outcome: toAttendeeResolutionOutcome(payment),
    registration:
      registration === null
        ? null
        : {
            unique_reference: registration.uniqueReference,
            ticket_type_name: ticketTypeName,
            status: registration.status,
            // Same rule as the checkout DTO: a deadline is only shown while a hold is
            // actually outstanding, so a confirmed attendee is not told to hurry.
            hold_expires_at:
              registration.status === "pending_payment"
                ? holdDeadline(registration).toISOString()
                : null,
          },
    payment:
      payment === null
        ? null
        : {
            status: attendeePaymentState(payment),
            expected_amount_minor_units: payment.expectedAmountMinorUnits,
            currency: payment.currency,
            verified_amount_minor_units: payment.verifiedAmountMinorUnits,
            verified_at: payment.verifiedAt === null ? null : payment.verifiedAt.toISOString(),
          },
  };
}

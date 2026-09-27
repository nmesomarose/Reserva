/**
 * Registration & Payment domain types (PRD v2 §7.2, §9.1, §9.2, FR-8/9/10/10a,
 * FR-11/12/13/13a, BR-1, BR-2, BR-3).
 *
 * Framework- and database-agnostic, like `events/event.ts`: plain shapes, never
 * Prisma models. The persistence adapter maps onto these.
 *
 * ## Why `Registration` and `Payment` live in one file
 *
 * They are separate tables with a 1:N relationship (PRD §7.3 — "v1's core bug
 * was 1:1"), and the payment skill's §8.5 confirmation transaction writes both in
 * one unit of work. Splitting the *types* would mean two files describing one
 * transaction. The records are still independent shapes and no code treats them
 * as one.
 *
 * ## The hold has no column, and that is deliberate
 *
 * `HOLD_WINDOW_MINUTES` lives in `../tickets/ticket-type.ts` with a comment
 * explaining that the two-counter model stores no per-hold row (PRD §7.2 fixes
 * the columns; §9.3 states there is no per-unit row). A hold is therefore
 * identified by the `Registration` that placed it, and its age is
 * `now() - created_at`. {@link holdHasExpired} is the one place that comparison
 * is made, so the rule cannot be re-implemented differently on the initiate path
 * and the payment path.
 */

import { holdExpiresAt, HOLD_WINDOW_MINUTES } from "../tickets/ticket-type";

/** PRD v2 §9.2. Mirrors the `registration_status` enum exactly (rule 02). */
export const REGISTRATION_STATUSES = [
  "pending_payment",
  "confirmed",
  "checked_in",
  "cancelled",
  "refunded",
] as const;

export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

export function isRegistrationStatus(value: unknown): value is RegistrationStatus {
  return typeof value === "string" && (REGISTRATION_STATUSES as readonly string[]).includes(value);
}

/**
 * PRD v2 §9.1. Mirrors the `payment_status` enum exactly.
 *
 * R-1 is why there is no `reconciliation` value here: the reconciliation state is
 * the `requires_reconciliation` **flag** on the `Payment` row, never a status.
 */
export const PAYMENT_STATUSES = [
  "initiated",
  "processing",
  "success",
  "failed",
  "pending",
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export function isPaymentStatus(value: unknown): value is PaymentStatus {
  return typeof value === "string" && (PAYMENT_STATUSES as readonly string[]).includes(value);
}

/** A terminal `Payment` status, per PRD §9.1's §10 table. */
export function isResolvedPaymentStatus(status: PaymentStatus): boolean {
  return status === "success" || status === "failed";
}

/**
 * A registration as stored (PRD v2 §7.2).
 *
 * `id` is deliberately **not** re-exported here even though it is the primary key:
 * the `unique_reference` is what an attendee holds (PRD §5.5), so it is the
 * identifier the API surface exposes. The row id remains available to organiser
 * and staff surfaces, which legitimately need it.
 */
export interface RegistrationRecord {
  readonly id: string;
  readonly eventId: string;
  readonly ticketTypeId: string;
  /** The attendee-facing reference. ≥128 bits, `UNIQUE` (skill precondition). */
  readonly uniqueReference: string;
  readonly attendeeName: string;
  readonly attendeeEmail: string;
  readonly attendeePhone: string;
  readonly status: RegistrationStatus;
  /** Client-supplied; `UNIQUE` is what makes replay safe (FR-10a). */
  readonly idempotencyKey: string;
  /** The instant the tier hold was placed — see the file header. */
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * A payment attempt as stored (PRD v2 §7.2).
 *
 * `expectedAmountMinorUnits` is computed from the tier **at initiation** and never
 * from a request (FR-11). `verifiedAmountMinorUnits` is populated only by
 * verification, in **minor units** (PRD §7.2), so PRD §11's equality check
 * compares two values in the same unit and needs no conversion — the
 * major-unit conversion lives solely at the provider boundary, per R-6.
 */
export interface PaymentRecord {
  readonly id: string;
  readonly registrationId: string;
  /**
   * Our own `tx_ref` — see the design note in `docs/evidence/requirements-matrix.md`
   * (P-4) and the registration service.
   */
  readonly providerReference: string;
  readonly expectedAmountMinorUnits: number;
  /** `null` until verified. Never inferred, never defaulted. */
  readonly verifiedAmountMinorUnits: number | null;
  readonly currency: string;
  readonly status: PaymentStatus;
  readonly verifiedAt: Date | null;
  /** R-1: a flag, never a status value. */
  readonly requiresReconciliation: boolean;
  /**
   * The provider's raw response, retained for audit (PRD §14) and used to serve a
   * replayed idempotency key its original redirect without a second provider call.
   * Rule 08: never reaches a client or a log line.
   */
  readonly rawProviderPayload: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Validated, domain-level input for creating a registration (PRD v2 §12). */
export interface CreateRegistrationCommand {
  readonly attendeeName: string;
  readonly attendeeEmail: string;
  readonly attendeePhone: string;
  readonly ticketTypeId: string;
  /** Client-generated UUID; the sole duplicate-submission defence (FR-10a). */
  readonly idempotencyKey: string;
}

/**
 * Has this registration's tier hold expired? (PRD v2 §10, BR-3)
 *
 * Answers the question the two-counter model cannot answer on its own. The hold
 * was placed when the row was created, and BR-3's window is
 * `HOLD_WINDOW_MINUTES`, so expiry is a pure function of `created_at` — no extra
 * column and no per-unit row, which §7.2 and §9.3 both forbid.
 *
 * `now` is a parameter so the boundary is testable without faking the clock, and
 * so one transaction can evaluate expiry against a single consistent instant.
 */
export function holdHasExpired(registration: RegistrationRecord, now: Date): boolean {
  return now.getTime() >= holdExpiresAt(registration.createdAt).getTime();
}

/**
 * When this registration's hold runs out, for the attendee-facing DTO.
 *
 * Exposed because PRD §17 requires the "confirming your payment" state to be
 * *explicit and time-bounded*: an attendee who is not told the deadline cannot
 * act on it.
 */
export function holdDeadline(registration: RegistrationRecord): Date {
  return holdExpiresAt(registration.createdAt);
}

/**
 * The registration states in which a hold is still outstanding.
 *
 * A confirmed registration's hold has been consumed by §9.3's
 * `HELD → CONFIRMED` (so releasing it again would double-release), and a
 * cancelled or refunded one has already had it released. Only
 * `pending_payment` and `checked_in` can still hold stock — `checked_in` because
 * a registration is only ever checked in *after* confirmation, so the two are
 * mutually exclusive in practice, and listing it would be dead code.
 */
export function holdsInventory(status: RegistrationStatus): boolean {
  return status === "pending_payment";
}

/**
 * Is this supplied email the one stored on a registration? (design position P-18)
 *
 * One predicate for FR-15's possession check and FR-23's authorisation basis, because
 * the two must agree: an attendee who can open their own ticket but is then refused a
 * request on the same registration would conclude the platform is broken, and the
 * refusal would in fact be two different email rules.
 *
 * Trimmed and compared case-insensitively. RFC 5321 makes only the *domain* part
 * case-insensitive, but the local part is not something a human reproduces reliably
 * when typing an address they used weeks ago, and this comparison decides whether
 * someone gets their own ticket. The stored value is left exactly as supplied (FR-14
 * echoes it back), so this is a *comparison* rule, not a normalisation rule.
 *
 * Deliberately not normalised further — no plus-addressing, no dot-stripping. Those
 * rules differ per provider, and a wrong guess locks a legitimate attendee out of their
 * own evidence. An unrecognised provider-specific address is a support question, not a
 * rule to guess at.
 */
export function emailsMatch(stored: string, supplied: string): boolean {
  return stored.trim().toLowerCase() === supplied.trim().toLowerCase();
}

/** The 15-minute window, re-exported so consumers need one import for a hold. */
export { HOLD_WINDOW_MINUTES };

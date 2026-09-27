/**
 * The payment-provider port (PRD v2 §5.4, §8, §19; rule 04; the payment skill).
 *
 * ## Why the domain defines this interface at all
 *
 * The domain must be able to reason about a provider *result* — was it
 * successful, what amount, which currency — without knowing that the provider is
 * Flutterwave, that it is reached over HTTPS, or that its JSON nests everything
 * under `data`. So this file declares the port and the plain shapes it returns;
 * `src/server/flutterwave/` holds the adapter that actually speaks HTTP.
 *
 * That split is what makes the money rules testable. PRD §11's equality check,
 * R-6's unit conversion, and §10's "never guess success" are all decisions about
 * a *value*, and a test can assert them against a stub returning a literal amount
 * instead of a sandbox round-trip.
 *
 * ## Units: read this before using `VerifiedTransaction.amount`
 *
 * `amount` is in the currency's **MAJOR** units, because that is what the
 * provider reports. Everything the database stores is in **minor** units (PRD §7.2).
 * The conversion therefore happens in exactly one place — see R-6 and
 * `../payments/currency-units.ts` — and it happens *before* any comparison, so no
 * code path can compare a minor-unit expected amount against a major-unit
 * verified amount. Getting that backwards is a 100× error, which is why it is
 * called out here rather than left to the type system, which cannot see it.
 */

/** The provider's own transaction status vocabulary (lowercase, per its docs). */
export type ProviderTransactionStatus =
  | "successful"
  | "failed"
  | "pending"
  | "refunded"
  | "cancelled"
  | "unknown";

/**
 * A provider transaction, already parsed and normalised.
 *
 * `status` is `"unknown"` for any value this platform does not recognise, rather
 * than optimistically mapping it to success. PRD §15 forbids guessing, and the
 * provider's vocabulary is longer than the five states PRD §9.1 defines — an
 * unrecognised value must stop the confirmation, not fall through it.
 */
export interface VerifiedTransaction {
  /** The `tx_ref` the provider echoed. Checked against ours before trusting. */
  readonly providerReference: string;
  /** The provider's own reference (`flw_ref`). Audit only; not a lookup key here. */
  readonly flwReference: string | null;
  /** The numeric transaction id. Needed to re-verify; `null` if absent. */
  readonly transactionId: number | null;
  /** **Major** units. Convert with `majorUnitsToMinorUnits` before comparing. */
  readonly amount: number;
  readonly currency: string;
  readonly status: ProviderTransactionStatus;
  /** Retained verbatim for PRD §14 audit. Never logged, never returned. */
  readonly raw: unknown;
}

export interface InitiateCheckoutInput {
  /** Our `tx_ref`, from `payments.provider_reference` (see `reference.ts`). */
  readonly providerReference: string;
  /** **Major** units. The caller converts from the stored minor-unit price. */
  readonly amount: number;
  readonly currency: string;
  readonly customerEmail: string;
  readonly customerName: string;
  readonly customerPhone: string;
  /**
   * Where the provider sends the attendee back after payment.
   *
   * Nullable because the product may be deployed without a public origin
   * configured; the provider treats it as optional. When absent the payment
   * completes via webhook alone, which §8.6 makes the governing channel anyway.
   */
  readonly redirectUrl: string | null;
  /**
   * BR-3's 15-minute hold, mirrored onto the provider's hosted session.
   *
   * If these drift, one of the two expires first and the attendee is either turned
   * away after paying, or left with a live link for a hold that has already been
   * released. So the value is passed in from the domain constant rather than
   * written as a literal here.
   */
  readonly sessionDurationMinutes: number;
}

/** The hosted link the attendee must be redirected to. */
export interface InitiatedCheckout {
  readonly link: string;
  /** The provider's numeric id, when the response carries one. */
  readonly transactionId: number | null;
  /** The whole provider response, for `raw_provider_payload` (PRD §14). */
  readonly raw: unknown;
}

export interface VerifyTransactionInput {
  /** Verify by our `tx_ref` — the form this product uses (see `reference.ts`). */
  readonly providerReference: string;
}

/**
 * Why a provider call failed, as far as this platform can honestly tell.
 *
 * The distinctions matter because they lead to different product outcomes, and
 * collapsing them would mean either lying to an attendee or retrying a payment
 * creation the provider explicitly told us not to retry.
 */
export type PaymentProviderFailureKind =
  /** The provider answered with a non-2xx that is not a rate limit or a timeout. */
  | "rejected"
  /** The provider returned 429. The documented remedy is a backoff retry. */
  | "rate_limited"
  /**
   * The provider returned 503, or the request exceeded our own timeout. **The
   * documented meaning is that the payment may still be processing** — so this
   * must never be reported to an attendee as a failed payment, and a create must
   * never be blindly retried on the strength of it.
   */
  | "indeterminate"
  /** The response was not the shape this adapter knows how to read. */
  | "malformed";

export class PaymentProviderError extends Error {
  readonly kind: PaymentProviderFailureKind;
  /** The provider's HTTP status, when there was one. `null` on a transport error. */
  readonly status: number | null;
  /**
   * The provider's message, for the audit trail.
   *
   * Kept separate from `message` so it can never reach a log line by accident
   * (rule 08: provider diagnostics are not attendee surface). Nothing in the
   * codebase interpolates it into a `DomainError`.
   */
  readonly providerMessage: string | null;

  constructor(
    kind: PaymentProviderFailureKind,
    message: string,
    status: number | null = null,
    providerMessage: string | null = null,
  ) {
    super(message);
    this.name = "PaymentProviderError";
    this.kind = kind;
    this.status = status;
    this.providerMessage = providerMessage;
  }

  /**
   * Did the money possibly move?
   *
   * True only for the case the provider documents as ambiguous. Every one of the
   * payment skill's "never show a false failure" requirements is a consequence of
   * honouring this: a caller that receives `true` must leave the attempt
   * `initiated` and query state later, never mark it `failed`.
   */
  get mayHaveMoved(): boolean {
    return this.kind === "indeterminate";
  }
}

export interface PaymentProvider {
  /**
   * Create a hosted checkout and return the link to redirect the attendee to.
   *
   * MUST throw {@link PaymentProviderError} rather than returning a null or a
   * half-built result, so the caller cannot mistake a failure for a checkout.
   */
  initiateCheckout(input: InitiateCheckoutInput): Promise<InitiatedCheckout>;

  /**
   * Ask the provider for a transaction's final state.
   *
   * "No such transaction" is a **result**, not a throw: the provider documents it
   * as a `200` with `status: "error"`, and it is an ordinary answer meaning the
   * payment is not there to confirm. A throw means the question could not be
   * answered, which is a different thing entirely.
   */
  verifyTransaction(input: VerifyTransactionInput): Promise<VerifiedTransaction | null>;
}

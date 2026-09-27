/**
 * Payment verification and confirmation (PRD v2 FR-11, FR-12, FR-13, FR-13a,
 * BR-1, BR-2, §8 in full, §9.1, §10, §11, §15).
 *
 * This is the highest-risk path in the product: it is the only place a
 * `Registration` becomes `confirmed`, and it does that by moving money-adjacent
 * counters based on a value that arrived over the network. Every rule below exists
 * because skipping it produces a specific, named failure.
 *
 * ## One resolution core, two entry channels
 *
 * The redirect callback and the webhook are separate entry points into the **same**
 * idempotent logic (`resolve`), and neither is trusted alone (skill step 1). The
 * difference is only *where the verified facts come from*:
 *
 * - `redirect` — ask the provider, then act (FR-12: the redirect is not
 *   authoritative, so verification must precede any write).
 * - `webhook` — the payload **is** the verification, because §8.6 and FR-13a make
 *   the webhook the eventual source of truth and require it to *govern* when the
 *   two channels disagree. Re-querying the provider here would make the two
 *   channels symmetric and quietly delete that precedence, so it is not done. The
 *   anti-spoofing mechanisms are instead the `verif-hash` comparison the route
 *   performs before any call reaches this class, and `UNIQUE(provider_reference)`
 *   making redelivery a database-level no-op. The residual replay exposure that
 *   leaves is recorded in
 *   `docs/evidence/flutterwave-verify-resolution.md` rather than being papered
 *   over.
 *
 * ## The order of the checks, and why amount equality sits where it does
 *
 * A verified transaction is only allowed to confirm a registration if **all** of
 * these hold, and they are evaluated in this order:
 *
 * 1. the echoed `tx_ref` is ours — otherwise we are reading someone else's payment;
 * 2. the currency is the one the tier is priced in — a currency mismatch means the
 *    amount comparison in 3 is comparing different units;
 * 3. the amount is **equal** (PRD §11) — the skill forbids
 *    `initiated → confirmed` without verification, and PRD §11 blocks a mismatch
 *    rather than flagging-and-accepting;
 * 4. the registration is not already resolved (R-1's reconciliation flag covers
 *    "money moved but we did not grant value", and R-2's `CANCELLED` case);
 * 5. the tier still holds the unit — the conditional `HELD → CONFIRMED` statement,
 *    inside the transaction, which is where a vanished hold is caught.
 *
 * Any failure after 1 and 2 sets `requires_reconciliation` and confirms nothing.
 * None of them reports a *failure* to the attendee for money that moved (§17).
 */

import {
  majorUnitsToMinorUnits,
  UnrepresentableAmountError,
} from "../payments/currency-units";
import type { PaymentProvider, VerifiedTransaction } from "../payments/provider";
import { PaymentProviderError } from "../payments/provider";
import type { PaymentRecord, RegistrationRecord } from "./registration";
import {
  HoldLostError,
  type PaymentResolution,
  type RegistrationRepository,
} from "./registration.repository";

/**
 * Where the verified facts came from (skill step 1).
 *
 * Carried on the outcome so the route can answer the two channels differently
 * *without* the domain branching on HTTP: a webhook must be acknowledged with
 * `200` even for an outcome the redirect would surface as a `404` or a `409`.
 */
export type ResolutionChannel = "redirect" | "webhook";

/**
 * Why an attempt is still `pending` because the provider could not be asked.
 *
 * Written in this product's voice and deliberately free of the provider's own
 * `message`, which rule 08 keeps out of every surface. Organiser-only: it is a queue
 * hint ("ask the provider again"), never attendee copy.
 */
const UNDETERMINED_REASON =
  "The payment provider could not confirm this payment yet, so it is still being determined.";

export type PaymentOutcomeKind =
  /** This call performed the confirmation. */
  | "confirmed"
  /** A prior call already resolved this attempt; nothing was re-applied. */
  | "already_resolved"
  /** Verified, but the provider has not settled it yet. */
  | "pending"
  /** The provider reported a terminal failure. */
  | "failed"
  /** Money moved, but value was withheld and a human must look (R-1). */
  | "reconciliation"
  /** No `Payment` row carries that `provider_reference`. */
  | "unknown_reference";

export interface PaymentResolutionOutcome {
  readonly kind: PaymentOutcomeKind;
  readonly registration: RegistrationRecord | null;
  readonly payment: PaymentRecord | null;
  /**
   * Set for `reconciliation` — naming the rule that withheld value — and for a
   * `pending` that the provider could not resolve. Never attendee-facing (rule 08):
   * the attendee DTO projects the *state*, and this string is the organiser's queue
   * hint, which is what makes a flag or a stuck attempt actionable rather than a
   * bare boolean.
   */
  readonly reason: string | null;
  /**
   * The bought tier's name, resolved for the attendee projection (FR-14) and `null`
   * exactly when `registration` is `null` — the two can only differ together,
   * because a `Registration` is `RESTRICT`-referenced by its `TicketType` and a
   * registration row that does not exist cannot name a tier.
   */
  readonly ticketTypeName: string | null;
}

export interface ResolvePaymentInput {
  /** The `payments.provider_reference` — our `tx_ref`. */
  readonly providerReference: string;
  readonly channel: ResolutionChannel;
  /**
   * The verified facts, when they are already in hand (the webhook). `null` for
   * the redirect, where this class must fetch them itself.
   */
  readonly verified: VerifiedTransaction | null;
  /**
   * The provider's numeric transaction id, when the payload carried one. Retained
   * for audit; matching is by `provider_reference` (BR-2).
   */
  readonly providerTransactionId?: number | null;
}

export class PaymentService {
  /**
   * The tier counter movement is NOT performed here.
   *
   * It has to be the same transaction as the `Payment` and `Registration` writes
   * (PRD §8.5, rule 03), which means it has to be a statement on the handle the
   * confirmation transaction is already running on — so it belongs to
   * `resolveVerifiedPayment`, not to a service method that would need its own
   * transaction and could not join this one. A `TicketTypeRepository` injected here
   * would be a collaborator this class never calls, and a collaborator that is never
   * called but is required in the constructor is a rule waiting to be broken.
   *
   * @param now injectable so `verified_at` is testable.
   */
  constructor(
    private readonly repository: RegistrationRepository,
    private readonly provider: PaymentProvider,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * The single resolution core. Safe to call repeatedly with the same
   * `provider_reference` (skill verification: "repeated `/payments/verify` calls
   * are safe").
   */
  async resolve(input: ResolvePaymentInput): Promise<PaymentResolutionOutcome> {
    return this.withTierName(await this.resolveCore(input));
  }

  /**
   * Attach the tier name the attendee projection needs, for the one outcome shape
   * that has a registration.
   *
   * Deliberately one lookup on one indexed foreign key, and only when a
   * registration exists: the alternative is a route reaching past the service into
   * the repository, which is the layering AGENTS.md §4 forbids.
   */
  private async withTierName(outcome: PaymentResolutionOutcome): Promise<PaymentResolutionOutcome> {
    if (outcome.registration === null) {
      return outcome;
    }

    const tier = await this.repository.findRegistrationTier(outcome.registration);

    return { ...outcome, ticketTypeName: tier.name };
  }

  /**
   * The resolution core proper, before the attendee projection is completed.
   *
   * Split from {@link resolve} so every one of the many outcomes below returns the
   * same shape, and the single place that adds `ticketTypeName` is the single place
   * that can be forgotten if a new outcome is added.
   */
  private async resolveCore(input: ResolvePaymentInput): Promise<PaymentResolutionOutcome> {
    const payment = await this.repository.findPaymentByProviderReference(input.providerReference);

    // --- Step 3: no row. Do not invent one (BR-2). ------------------------------
    if (payment === null) {
      return {
        kind: "unknown_reference",
        registration: null,
        payment: null,
        reason: null,
        ticketTypeName: null,
      };
    }

    const registration = await this.repository.findRegistrationById(payment.registrationId);

    if (registration === null) {
      // `Registration` is `RESTRICT`-referenced by `Payment`, so this is not
      // reachable through any write this product makes. Treated as reconciliation
      // rather than crashing, because the alternative is a `500` on the webhook's
      // hottest path.
      //
      // The payload passed here is the one **already stored on the row**, not a
      // synthesised `{ reason }` object. Writing our own reason into
      // `raw_provider_payload` would destroy the provider's initiate response — the
      // only provider evidence this attempt has — in exchange for a string the
      // outcome already carries. PRD §14 requires the provider's own payload to be
      // retained, so the column is never a place for our own text.
      const flagged = await this.repository.flagPaymentForReconciliation({
        paymentId: payment.id,
        verifiedAmountMinorUnits: null,
        payload: payment.rawProviderPayload ?? null,
        verifiedAt: null,
      });

      // The **flagged** record, not the one read before the write: an outcome that
      // still said `requiresReconciliation: false` after the row was flagged would
      // misreport the state to whoever reads this result, and the two callers of this
      // branch are the webhook and the verify route.
      return {
        kind: "reconciliation",
        registration: null,
        payment: flagged,
        reason: "The payment has no registration row.",
        ticketTypeName: null,
      };
    }

    // --- Step 3: already resolved. A no-op, not a re-application (skill step 3) -
    if (payment.status === "success" || payment.status === "failed") {
      return {
        kind: payment.requiresReconciliation ? "reconciliation" : "already_resolved",
        registration,
        payment,
        reason: payment.requiresReconciliation ? "This payment is awaiting manual review." : null,
        ticketTypeName: null,
      };
    }

    // --- Step 4: obtain the verified facts, if we do not already have them -----
    const verified = await this.obtainVerifiedFacts(input, payment);

    if (verified.kind === "indeterminate") {
      // The provider's own timeout contract: a `503` or transport timeout means
      // "still processing", not "failed". The attempt stays `initiated` so a later
      // call can resolve it, and the attendee is told it is pending.
      return {
        kind: "pending",
        registration,
        payment,
        reason: verified.reason,
        ticketTypeName: null,
      };
    }

    if (verified.kind === "not_found") {
      return {
        kind: "unknown_reference",
        registration: null,
        payment: null,
        reason: null,
        ticketTypeName: null,
      };
    }

    return this.applyVerifiedTransaction(verified.transaction, payment, registration);
  }

  /**
   * Fetch the provider's verdict when the caller has not supplied one.
   *
   * The `mayHaveMoved` distinction is preserved rather than flattened into a
   * failure: the provider documents that a `503` or a timeout can mean the request
   * is still processing, and reporting that as a failed payment is precisely the
   * "false failure" §17 forbids. A rejected or malformed response *is* a genuine
   * "we could not answer", and both leave the attempt untouched.
   *
   * ## Every provider error means "not yet", not "no"
   *
   * A `PaymentProviderError` of *any* kind — including `rejected`, which for this
   * call covers a `401` from a misconfigured secret key and a `400` from a reference
   * the provider will not look up — is treated as "the outcome could not be
   * established" and reported as `pending`, never as a failed payment. PRD §15
   * requires payment-adjacent endpoints to "surface `pending`/
   * `requires_reconciliation` rather than guessing success or failure", and a
   * provider 4xx says nothing about whether the money moved.
   *
   * The consequence is that a broken integration shows up as attempts stuck in
   * `initiated`/`pending` rather than as tickets, which is the correct direction to
   * fail: loudly wrong in the organiser's queue, and never an attendee told their
   * payment failed. The provider's own `message` is deliberately not carried
   * anywhere (rule 08); the reason string below is written in this product's voice.
   */
  private async obtainVerifiedFacts(
    input: ResolvePaymentInput,
    payment: PaymentRecord,
  ): Promise<
    | { readonly kind: "resolved"; readonly transaction: VerifiedTransaction }
    | { readonly kind: "indeterminate"; readonly reason: string | null }
    | { readonly kind: "not_found" }
  > {
    if (input.verified !== null) {
      return { kind: "resolved", transaction: input.verified };
    }

    let transaction: VerifiedTransaction | null;
    try {
      transaction = await this.provider.verifyTransaction({
        providerReference: payment.providerReference,
      });
    } catch (error) {
      if (error instanceof PaymentProviderError) {
        return { kind: "indeterminate", reason: UNDETERMINED_REASON };
      }
      throw error;
    }

    if (transaction === null) {
      return { kind: "not_found" };
    }

    return { kind: "resolved", transaction };
  }

  /**
   * Steps 5-9: map a verified transaction onto the stored attempt, and confirm if
   * every rule allows it.
   *
   * Every `ticketTypeName` here is `null` by construction: {@link resolveCore} is the
   * single place that fills it in, after this method has decided the outcome.
   */
  private async applyVerifiedTransaction(
    verified: VerifiedTransaction,
    payment: PaymentRecord,
    registration: RegistrationRecord,
  ): Promise<PaymentResolutionOutcome> {
    // --- Step 5, non-successful outcomes first --------------------------------
    if (verified.status === "failed" || verified.status === "cancelled") {
      const failed = await this.repository.markPaymentFailed(payment.id, verified.raw);
      return {
        kind: "failed",
        registration,
        payment: failed,
        reason: null,
        ticketTypeName: null,
      };
    }

    if (verified.status !== "successful") {
      // `pending`, `refunded`, or an unrecognised value. PRD §15 forbids guessing,
      // so an unknown status stops here rather than being treated as success — and
      // a `refunded` transaction is not quietly confirmed either.
      const stillPending = await this.repository.markPaymentPending(payment.id, verified.raw);
      return {
        kind: "pending",
        registration,
        payment: stillPending,
        reason: null,
        ticketTypeName: null,
      };
    }

    // --- Checks 1 and 2: is this *our* payment, in the *right* currency? -------
    // Both carry `null` for the amount. A `tx_ref` that is not ours means this is
    // somebody else's transaction and its amount means nothing about ours; a
    // currency mismatch means the reported figure is not in a unit this column
    // holds. Recording a number in either case would be a guess.
    if (verified.providerReference !== payment.providerReference) {
      return this.withholdValue(
        payment,
        verified,
        "The provider reported a different transaction reference than the one requested.",
        null,
      );
    }

    if (verified.currency.trim().toUpperCase() !== payment.currency) {
      return this.withholdValue(
        payment,
        verified,
        `The payment was made in ${verified.currency}, but the ticket is priced in ${payment.currency}.`,
        null,
      );
    }

    // --- Check 3: amount equality, in minor units (PRD §11, R-6) --------------
    let verifiedMinorUnits: number;
    try {
      verifiedMinorUnits = majorUnitsToMinorUnits(verified.amount, payment.currency);
    } catch (error) {
      if (error instanceof UnrepresentableAmountError) {
        // `null`: the amount is real but cannot be expressed in this currency's minor
        // units, so there is no honest value to record. Recorded as unknown rather
        // than as the expected amount, which would fabricate a match.
        return this.withholdValue(
          payment,
          verified,
          "The provider reported an amount that cannot be represented exactly, so it was not compared.",
          null,
        );
      }
      throw error;
    }

    if (verifiedMinorUnits !== payment.expectedAmountMinorUnits) {
      // D-1: the provider's guidance is "accept if amount >= expected", and PRD
      // §11 overrides it. An **overpayment is a mismatch**, so it lands here too and
      // is blocked for a human rather than auto-accepted as a free ticket.
      //
      // The verified amount IS recorded, and that is the whole point of R-1: it is
      // the only place the difference between what was charged and what was owed
      // becomes visible to whoever resolves the queue, and a flag with no numbers
      // beside it would send them back to the provider to rediscover it.
      return this.withholdValue(
        payment,
        verified,
        "The amount charged does not equal the ticket price, so the payment needs manual review.",
        verifiedMinorUnits,
      );
    }

    // --- Check 4: has this registration already been given value? --------------
    if (registration.status === "confirmed" || registration.status === "checked_in") {
      // A different attempt already confirmed this registration. Granting value
      // twice would move a counter twice, and `one_success_per_registration` would
      // rightly reject it. The money moved, so it is reconciliation.
      return this.withholdValue(
        payment,
        verified,
        "This registration already holds a confirmed ticket, so this payment was not applied.",
        verifiedMinorUnits,
      );
    }

    // --- R-2: a lapsed hold cancelled the registration. -----------------------
    if (registration.status === "cancelled") {
      // The money moved, so the attempt genuinely is `success` — but §9.2's
      // `cancelled → confirmed` prohibition is NOT relaxed and no counter moves: the
      // hold already released those units (BR-3). The attendee is never shown a
      // failure for money that succeeded (§17); it is surfaced as reconciliation.
      const unclaimable = await this.repository.recordUnclaimableSuccess({
        paymentId: payment.id,
        verifiedAmountMinorUnits: verifiedMinorUnits,
        payload: verified.raw,
        verifiedAt: this.now(),
      });

      return {
        kind: "reconciliation",
        registration,
        payment: unclaimable,
        reason:
          "The payment succeeded after the reservation had already been released, so it needs manual review.",
        ticketTypeName: null,
      };
    }

    // --- Step 7: §8.5, all five writes or none -------------------------------
    let resolution: PaymentResolution;
    try {
      resolution = await this.repository.resolveVerifiedPayment({
        paymentId: payment.id,
        registrationId: registration.id,
        ticketTypeId: registration.ticketTypeId,
        verifiedAmountMinorUnits: verifiedMinorUnits,
        verifiedAt: this.now(),
        payload: verified.raw,
      });
    } catch (error) {
      if (!(error instanceof HoldLostError)) {
        // Anything else is infrastructure — a dropped connection, a deadlock, a
        // constraint this port does not model. It is rethrown as a `500` rather than
        // retried inside the call, for three reasons:
        //
        //   - the transaction has already rolled back, so the attempt is untouched
        //     `initiated` and NOTHING is half-written; the state is safe, not stuck;
        //   - recovery does not need a retry here. The attempt exists and the
        //     provider will redeliver its webhook, and `POST /payments/verify` is
        //     idempotent — so the same confirmation arrives by another route, which
        //     is a stronger guarantee than an in-process retry that a crash would
        //     also lose;
        //   - a retry *budget* would need a column to count against, and the schema
        //     is not ours to extend for a condition with no reachable cause.
        //
        // Turning it into reconciliation instead would be worse: R-1's flag means
        // "money moved and a human must look", and a transient database blip is not
        // that.
        throw error;
      }

      // The hold was released while this payment was in flight — the 15-minute
      // sweep ran, or a competing resolution released it. The money has moved and
      // the registration cannot be confirmed, so this is R-2's situation exactly:
      // record the verified success, flag it, confirm nothing, and tell the
      // attendee reconciliation rather than failure (§17).
      const unclaimable = await this.repository.recordUnclaimableSuccess({
        paymentId: payment.id,
        verifiedAmountMinorUnits: verifiedMinorUnits,
        payload: verified.raw,
        verifiedAt: this.now(),
      });

      return {
        kind: "reconciliation",
        registration,
        payment: unclaimable,
        reason:
          "The payment succeeded after the reserved ticket had been released, so it needs manual review.",
        ticketTypeName: null,
      };
    }

    if (!resolution.confirmedNow) {
      // The attempt was resolved by a concurrent delivery between our read and the
      // transaction. That is the duplicate-delivery path working, not an error.
      return {
        kind: resolution.payment.requiresReconciliation ? "reconciliation" : "already_resolved",
        registration: resolution.registration,
        payment: resolution.payment,
        reason: resolution.payment.requiresReconciliation
          ? "This payment is awaiting manual review."
          : null,
        ticketTypeName: null,
      };
    }

    return {
      kind: "confirmed",
      registration: resolution.registration,
      payment: resolution.payment,
      reason: null,
      ticketTypeName: null,
    };
  }

  /**
   * Record the verified truth and set `requires_reconciliation` (R-1), granting
   * nothing.
   *
   * Both halves are always written together. A `success` attempt that does *not*
   * carry the flag would be a lie the organiser's queue cannot filter on (§10's
   * "Payment row (already `success`)" is only useful if something says to look).
   *
   * `verifiedAmountMinorUnits` is the amount we *could* establish, and `null` when
   * we could not — a `tx_ref` that is not ours, a currency that is not the ticket's,
   * or a reported amount with no exact minor-unit form. It is never the expected
   * amount: recording a match we did not observe would erase the mismatch the flag
   * exists to report (§11).
   *
   * `verified` is taken as a whole rather than as the two facts needed, because the
   * provider's **raw payload must be retained verbatim** (PRD §14). Passing only a
   * reason would overwrite the provider's evidence with our own sentence, and the
   * reviewer who opens this row would find our explanation where the transaction
   * should be — the flag would then be unauditable, which defeats its purpose.
   */
  private async withholdValue(
    payment: PaymentRecord,
    verified: VerifiedTransaction,
    reason: string,
    verifiedAmountMinorUnits: number | null,
  ): Promise<PaymentResolutionOutcome> {
    const flagged = await this.repository.flagPaymentForReconciliation({
      paymentId: payment.id,
      verifiedAmountMinorUnits,
      payload: verified.raw,
      verifiedAt: this.now(),
    });

    const registration = await this.repository.findRegistrationById(payment.registrationId);

    return {
      kind: "reconciliation",
      registration,
      payment: flagged,
      reason,
      ticketTypeName: null,
    };
  }
}

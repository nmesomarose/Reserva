/**
 * Persistence port for registrations and payments (PRD v2 FR-8/9/10/10a,
 * FR-11/12/13/13a, BR-1, BR-2, BR-3, §8.5, §9.1, §9.2, §10).
 *
 * The domain declares what it needs; `src/server/db` supplies the Prisma
 * implementation. As with the event and ticket-type ports, every method here is
 * specified in terms of *atomicity*, not merely its result, because that is the
 * part a fake repository cannot prove and the part that is load-bearing
 * (rule 07).
 *
 * ## The shape of this port
 *
 * Deliberately **two methods with large names** rather than several small ones:
 * `createPendingRegistration` performs the registration insert, the tier hold, and
 * the `Payment` insert as one unit, and `resolveVerifiedPayment` performs the five
 * steps of PRD §8.5 as one unit. Both are the transactions the PRD specifies, and
 * splitting either across separate port methods would let a caller interleave work
 * between two halves of a rule — which is exactly the "read-then-write" shape
 * rule 07 forbids.
 */

import type { TicketTypeRecord } from "../tickets/ticket-type";
import type {
  CreateRegistrationCommand,
  PaymentRecord,
  RegistrationRecord,
} from "./registration";

/**
 * What {@link RegistrationRepository.createPendingRegistration} produced.
 *
 * A discriminated union rather than a nullable record because the two outcomes
 * mean opposite things to the caller and the service must not be able to confuse
 * them by forgetting a null check. `replayed` is the **success** case for PRD §12
 * — a client that double-submits must get its original answer, not an error.
 */
export type RegistrationCreation =
  | { readonly outcome: "created"; readonly registration: RegistrationRecord; readonly payment: PaymentRecord }
  /**
   * The key was already used. Carries the **stored** registration and its newest
   * payment, which is what "return the original result" means. The caller
   * compares the stored attendee fields against the incoming body itself, because
   * whether a difference is *material* is a business judgement, not a persistence
   * one.
   */
  | { readonly outcome: "replayed"; readonly registration: RegistrationRecord; readonly payment: PaymentRecord | null };

export interface CreatePendingRegistrationInput {
  readonly eventId: string;
  readonly command: CreateRegistrationCommand;
  /** Generated per attempt; 256 bits. See `reference.ts`. */
  readonly uniqueReference: string;
  /** Generated per attempt; also the provider's `tx_ref`. See `reference.ts`. */
  readonly providerReference: string;
  /**
   * The tier price in **minor units**, read from the stored `TicketType` inside
   * this same transaction. Passed in by the service, which has already loaded the
   * tier — the value is re-read from the row here so a price edited between the
   * read and the write cannot be charged at the stale amount.
   */
  readonly expectedAmountMinorUnits: number;
  readonly currency: string;
}

export interface RegistrationRepository {
  /**
   * Run `work` against a handle bound to a single transaction, returning its
   * result; a throw rolls every write back. Same shape as the other two ports so
   * all three read alike.
   */
  transact<T>(work: (repository: RegistrationRepository) => Promise<T>): Promise<T>;

  /**
   * Create a registration, place its tier hold, and open its first payment
   * attempt — **all three in one transaction** (skill steps 4-6, integrity check
   * "the hold increment and the registration insert are one transaction").
   *
   * MUST behave as follows:
   *
   * 1. `status` is `pending_payment`. NEVER `confirmed`: BR-1 permits confirmation
   *    only through the §8.5 transaction, and FR-9 requires the attendee not to
   *    hold a ticket before verification.
   * 2. The hold is a single conditional
   *    `UPDATE ticket_types ... WHERE quantity_confirmed + quantity_held + 1 <=
   *    quantity_total RETURNING *`. If it matches no row the tier is sold out and
   *    the WHOLE transaction fails — no registration row, no hold, no payment
   *    (skill step 5, §12's `409`).
   * 3. `expected_amount_minor_units` is taken from the stored tier, never from
   *    `command`. Implementations MUST re-read the tier inside the transaction
   *    rather than trusting the caller's copy (FR-11).
   * 4. The `Payment` row starts at `initiated` (skill step 7) with
   *    `verified_amount_minor_units = null` and `verified_at = null`. A row
   *    created `success` would be a lie about money that has not moved.
   * 5. Duplicate `idempotency_key` returns `replayed`, **not** an error. The
   *    `UNIQUE(idempotency_key)` index is the arbiter: a pre-flight existence read
   *    would be a check-then-act race (rule 07), so a concurrent pair of
   *    double-submits must be resolved by the index. Exactly one row results.
   * 6. A duplicate `unique_reference` is NOT treated as a replay — it is a
   *    distinct-constraint collision, and implementations MUST retry with a fresh
   *    reference rather than returning someone else's registration. At 256 bits
   *    this is vanishingly unlikely, but conflating the two constraints would turn
   *    an astronomical accident into a data-disclosure bug.
   *
   * `Payment` is 1:N with `Registration` (PRD §7.3), so this creates the *first*
   * attempt; a later one comes through
   * {@link RegistrationRepository.openPaymentAttempt}.
   */
  createPendingRegistration(
    input: CreatePendingRegistrationInput,
  ): Promise<RegistrationCreation>;

  /**
   * Find the registration a client-supplied `idempotency_key` already produced.
   *
   * Used for the "materially different body" check (skill integrity checks) and as
   * the fast path that avoids a pointless transaction on an obvious replay. The
   * `UNIQUE` index remains the real guarantee — this read is an optimisation, and
   * treating it as authoritative is what creates the race.
   */
  findRegistrationByIdempotencyKey(idempotencyKey: string): Promise<RegistrationRecord | null>;

  /** One registration by row id, unscoped — used to resolve and then authorise. */
  findRegistrationById(id: string): Promise<RegistrationRecord | null>;

  /** One registration by its attendee-facing `unique_reference` (FR-15). */
  findRegistrationByReference(uniqueReference: string): Promise<RegistrationRecord | null>;

  /** The newest payment attempt for a registration, or `null` if it has none. */
  findLatestPayment(registrationId: string): Promise<PaymentRecord | null>;

  /**
   * The tier a registration was made against, as a *stored* row.
   *
   * Needed by the replay path: to answer a repeated `idempotency_key` the
   * registration has to be projected with its tier's name (FR-14), and the tier
   * named in the retried body may no longer be the one that was actually bought.
   * Reading the tier from the registration — not from the request — is what makes
   * the replay return the *original* result.
   */
  findRegistrationTier(registration: RegistrationRecord): Promise<TicketTypeRecord>;

  /**
   * Move a registration to `cancelled` **only if it is still `pending_payment`**.
   *
   * The conditionality is the point: a hold-expiry sweep and a concurrent
   * confirmation can both reach the same row, and whichever loses must find nothing
   * to do rather than overwriting a `confirmed` registration. Returns `null` when
   * the row was not `pending_payment`, so the caller knows not to release a hold
   * that is no longer outstanding.
   */
  cancelRegistrationIfPending(registrationId: string): Promise<RegistrationRecord | null>;

  /**
   * §9.3 `HELD → AVAILABLE`: give back `quantity` held units on a tier.
   *
   * MUST be a single conditional statement, as `TicketTypeRepository.releaseInventory`
   * already is. The registration slice uses it only through
   * `cancelRegistrationIfPending` succeeding first, so the two cannot disagree
   * about whether a hold was outstanding — but the guard still has to be in the
   * statement, because a check-then-write pair is a race (rule 07).
   *
   * Returns `null` when the guard does not hold, so a double release is a lost race
   * the caller can recognise rather than silent stock corruption.
   */
  releaseHeldInventory(ticketTypeId: string, quantity: number): Promise<TicketTypeRecord | null>;

  /** One attempt by `provider_reference` — the webhook's lookup key (BR-2). */
  findPaymentByProviderReference(providerReference: string): Promise<PaymentRecord | null>;

  /**
   * Open a further payment attempt against an existing registration.
   *
   * This is what makes §7.3's 1:N real and what `POST /api/v1/payments/initiate`
   * uses to prepare a *fresh* redirect after a failed attempt. It MUST NOT reuse
   * the previous `provider_reference` — that would collide with `UNIQUE` and, worse,
   * conflate two attempts into one row so a replay of the old hosted link could
   * resolve the new attempt.
   */
  openPaymentAttempt(input: {
    readonly registrationId: string;
    readonly providerReference: string;
    readonly expectedAmountMinorUnits: number;
    readonly currency: string;
  }): Promise<PaymentRecord>;

  /**
   * Attach the provider's initiate response to an attempt.
   *
   * Separate from {@link openPaymentAttempt} because the provider call is network
   * I/O and MUST NOT happen inside the transaction that created the row: holding a
   * database transaction open across a 28-second-timeout HTTP call is how a
   * connection pool dies. This is also where the hosted `data.link` is persisted,
   * which is what lets a replayed idempotency key return its original redirect
   * rather than issuing a second hosted link.
   */
  recordProviderPayload(paymentId: string, payload: unknown): Promise<PaymentRecord>;

  /**
   * Mark an attempt `failed`, outside the confirmation transaction.
   *
   * A failed attempt is terminal for that row (PRD §9.1 forbids
   * `failed → success` on the same row), so this is how a genuine failure is
   * recorded and the attendee is offered a new attempt. It is NOT a substitute for
   * {@link resolveVerifiedPayment}: nothing here touches a registration or a tier
   * counter.
   */
  markPaymentFailed(paymentId: string, payload: unknown): Promise<PaymentRecord>;

  /**
   * Record that the provider has not settled the attempt yet.
   *
   * Separate from leaving the row alone because §9.1 defines `pending` as a real
   * state and §15 requires it be reported as pending rather than guessed either
   * way. A verified `pending` is genuinely informative: the payment may yet succeed
   * and will arrive again as a further webhook, so the attempt must not be closed.
   *
   * MUST NOT touch a registration or a counter, and MUST NOT set
   * `requires_reconciliation` — nothing is wrong yet.
   */
  markPaymentPending(paymentId: string, payload: unknown): Promise<PaymentRecord>;

  /**
   * §8.5's confirmation transaction: mark the attempt `success` with its verified
   * amount, assert amount equality, `quantity_confirmed` up, `quantity_held` down,
   * `Registration.status = confirmed`. **All five, or none.**
   *
   * MUST be one transaction, and MUST be safe to run twice against the same
   * `provider_reference` (skill verification: "repeated `/payments/verify` calls
   * are safe"). The second run has to observe a resolved attempt and return the
   * already-confirmed outcome rather than re-incrementing a counter or hitting the
   * `one_success_per_registration` partial unique index.
   *
   * `verifiedAmountMinorUnits` is in **minor units** (PRD §7.2), the same unit as
   * `expected`, so §11's equality check compares like with like (R-6).
   */
  resolveVerifiedPayment(input: ResolveVerifiedPaymentInput): Promise<PaymentResolution>;

  /**
   * The §8.5 transaction when it **cannot** complete: record the verified truth on
   * the attempt and set `requires_reconciliation` (R-1), without confirming
   * anything.
   *
   * The cases that need it are all "the money moved but we must not grant value" —
   * an amount mismatch (PRD §11), a `tx_ref` or currency that is not ours, or a
   * registration that already holds a ticket. Keeping them in one port method means
   * the "money moved" half can never be recorded without the "needs a human" half.
   *
   * The attempt's `status` is left as it was: in these cases the platform has not
   * established a verified success, so claiming `success` would be the lie R-1
   * exists to prevent. R-2's one case where the status genuinely is `success` has
   * its own method, {@link recordUnclaimableSuccess}.
   */
  flagPaymentForReconciliation(input: FlagReconciliationInput): Promise<PaymentRecord>;

  /**
   * R-2: a verified success that must **not** confirm, because the registration is
   * already `CANCELLED` by a hold expiry.
   *
   * Three writes and no more: `status = success`, the verified amount and
   * `verified_at`, and `requires_reconciliation = true`. It MUST NOT touch
   * `Registration.status` and MUST NOT move either tier counter — the hold already
   * released those units (BR-3), and §9.2's `cancelled → confirmed` prohibition is
   * not relaxed here.
   *
   * A separate method rather than a flag on {@link flagPaymentForReconciliation}
   * because the two differ in a way a boolean parameter would hide: this one moves
   * the attempt to `success`, which is a lifecycle transition, and the distinction
   * is the entire content of R-2.
   */
  recordUnclaimableSuccess(input: FlagReconciliationInput): Promise<PaymentRecord>;

  /**
   * Whether this registration's tier hold is still outstanding.
   *
   * Deliberately a count, not a boolean: the sweep that releases expired holds
   * (PRD §10, BR-3) may find several, and it must release exactly as many units as
   * it found holds or the counters drift. Implementations MUST filter on
   * `status = 'pending_payment'` — {@link holdsInventory} in `./registration` is the
   * domain rule, and a confirmed registration's hold has already been consumed by
   * §9.3, so releasing it again would double-release stock.
   */
  findExpiredHolds(olderThan: Date, limit: number): Promise<RegistrationRecord[]>;
}

export interface ResolveVerifiedPaymentInput {
  readonly paymentId: string;
  readonly registrationId: string;
  readonly ticketTypeId: string;
  readonly verifiedAmountMinorUnits: number;
  /**
   * The single instant this resolution happened.
   *
   * Passed in rather than read from the database so one resolution has one
   * `verified_at`, and so it is the same instant the service used for every other
   * `verified_at` it writes on this path. Left to each adapter, the two channels
   * (redirect and webhook) would stamp the same verification moments apart, and
   * "when was this verified" stops being a fact.
   */
  readonly verifiedAt: Date;
  readonly payload: unknown;
}

export interface PaymentResolution {
  readonly payment: PaymentRecord;
  readonly registration: RegistrationRecord;
  /**
   * Whether THIS call performed the confirmation, as opposed to observing one an
   * earlier call had already performed. The API needs it: PRD §12's redirect
   * verify is "safe to call repeatedly", and a repeated call must report the same
   * state without pretending it just granted a ticket.
   */
  readonly confirmedNow: boolean;
}

export interface FlagReconciliationInput {
  readonly paymentId: string;
  /** `null` when no amount could be verified at all (R-2's cancelled case). */
  readonly verifiedAmountMinorUnits: number | null;
  readonly payload: unknown;
  /** `null` when there was nothing to verify — recorded rather than assumed. */
  readonly verifiedAt: Date | null;
}

/**
 * Thrown by {@link RegistrationRepository.resolveVerifiedPayment} when the tier's
 * held unit is gone by the time the confirmation runs.
 *
 * It exists because that outcome has to *roll the transaction back and be handled
 * differently*, and the two requirements are incompatible in one return value: the
 * caller must not see a partially-applied confirmation, and it must be told to fall
 * back to reconciliation rather than retry. A `null` result would read as
 * "nothing to do"; a `PaymentResolution` would have to carry a state that means
 * "failed" and lose the reason.
 *
 * The condition is a **lost race**, not a bug: the 15-minute hold can be released
 * by the expiry sweep while a payment is in flight, and the money has still moved.
 * So the caller records the verified success and flags it (R-1) — the same handling
 * as R-2 — and the attendee is never shown a failure for it (§17).
 */
export class HoldLostError extends Error {
  readonly ticketTypeId: string;

  constructor(ticketTypeId: string) {
    super(
      "The tier hold was released before the payment could be applied, so the " +
        "confirmation transaction was rolled back.",
    );
    this.name = "HoldLostError";
    this.ticketTypeId = ticketTypeId;
  }
}

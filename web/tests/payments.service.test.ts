import { beforeEach, describe, expect, it } from "vitest";

/**
 * Payment resolution and confirmation (PRD v2 §8, §8.5, §8.6, §9.1, §9.2, §11, §15,
 * §17; FR-12, FR-13, FR-13a; R-1, R-2).
 *
 * This is the only path in the product that turns a `Registration` into
 * `confirmed`, and it does so from a value that arrived over the network. Every test
 * below is one of the ways that can go wrong, written as the failure it prevents:
 *
 *   - confirming on a **mismatched amount** (an underpayment, and D-1's overpayment);
 *   - confirming on **someone else's transaction**, because a `tx_ref` that is not
 *     ours still carries a plausible amount and status;
 *   - confirming a registration that **already holds a ticket**, which would move a
 *     counter twice;
 *   - reporting a **false failure** for money that moved — §17's prohibition, and the
 *     reason every withholding case below is `reconciliation` and never `failed`;
 *   - letting a **provider error** be read as an answer.
 *
 * The atomicity of the five §8.5 writes, the `one_success_per_registration` index, and
 * the `FOR UPDATE` duplicate serialisation are proven in `registrations.db.test.ts`
 * against real PostgreSQL. This fake models the adapter's outcomes so the *service's*
 * handling of them is testable.
 */

import type { PaymentProvider, VerifiedTransaction } from "@/domain/payments/provider";
import { PaymentProviderError } from "@/domain/payments/provider";
import type { PaymentRecord, RegistrationRecord } from "@/domain/registrations/registration";
import {
  HoldLostError,
  type FlagReconciliationInput,
  type PaymentResolution,
  type RegistrationRepository,
  type ResolveVerifiedPaymentInput,
} from "@/domain/registrations/registration.repository";
import { PaymentService } from "@/domain/registrations/payment.service";
import type { TicketTypeRecord } from "@/domain/tickets/ticket-type";

const TIER_ID = "11111111-1111-4111-8111-111111111111";
const REGISTRATION_ID = "22222222-2222-4222-8222-222222222222";
const REFERENCE = "rsv_8Xk2mQ7pL4vR1sT6yB0nJ3wZ5cD7fH1aG9iK2l";

const CREATED_AT = new Date("2026-09-27T10:00:00.000Z");
const VERIFIED_AT = new Date("2026-09-27T10:06:00.000Z");

/** 5,000 kobo == ₦50, so every "correct" verified amount below is 50. */
const PRICE_MINOR_UNITS = 5_000;

let clock = new Date("2026-09-27T10:06:00.000Z");

// -----------------------------------------------------------------------------
// Fakes
// -----------------------------------------------------------------------------

const registrationRow = (overrides: Partial<RegistrationRecord> = {}): RegistrationRecord => ({
  id: REGISTRATION_ID,
  eventId: "33333333-3333-4333-8333-333333333333",
  ticketTypeId: TIER_ID,
  uniqueReference: "BGNEqSon4dw4szERiBHK5o58VDyy",
  attendeeName: "Ada Lovelace",
  attendeeEmail: "ada@example.com",
  attendeePhone: "+2348012345678",
  status: "pending_payment",
  idempotencyKey: "44444444-4444-4444-8444-444444444444",
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  ...overrides,
});

const paymentRow = (overrides: Partial<PaymentRecord> = {}): PaymentRecord => ({
  id: "pay-1",
  registrationId: REGISTRATION_ID,
  providerReference: REFERENCE,
  expectedAmountMinorUnits: PRICE_MINOR_UNITS,
  verifiedAmountMinorUnits: null,
  currency: "NGN",
  status: "initiated",
  verifiedAt: null,
  requiresReconciliation: false,
  // The provider's own initiate response, as PRD §14 requires it to be kept.
  rawProviderPayload: { status: "success", data: { link: "https://checkout.example/pay-1" } },
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  ...overrides,
});

/**
 * A tier whose counters can move.
 *
 * `TicketTypeRecord` is readonly because no *product* code mutates one in place � the
 * database does, atomically, inside �8.5. This fake stands in for the database, so it
 * is the one place that readonly-ness is lifted.
 */
type MutableTier = { -readonly [K in keyof TicketTypeRecord]: TicketTypeRecord[K] };

const tierRow = (overrides: Partial<TicketTypeRecord> = {}): MutableTier => ({
  id: TIER_ID,
  eventId: "33333333-3333-4333-8333-333333333333",
  name: "General Admission",
  description: null,
  priceMinorUnits: PRICE_MINOR_UNITS,
  currency: "NGN",
  quantityTotal: 10,
  quantityConfirmed: 0,
  quantityHeld: 1,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  ...overrides,
});

const verifiedTransaction = (overrides: Partial<VerifiedTransaction> = {}): VerifiedTransaction => ({
  providerReference: REFERENCE,
  flwReference: "FLW-REF-ABC-123",
  transactionId: 1_234_567,
  amount: 50,
  currency: "NGN",
  status: "successful",
  raw: { data: { tx_ref: REFERENCE, status: "successful", amount: 50, currency: "NGN" } },
  ...overrides,
});

interface FakeWorld {
  registration: RegistrationRecord | null;
  payment: PaymentRecord | null;
  tier: MutableTier;
  /** Every call the service made to a port method, for "must not have been called". */
  readonly calls: string[];
  /** Set by a test to make the §8.5 transaction throw a specific way. */
  confirmationFailure: Error | null;
  /** Set to `false` to model a concurrent delivery having already resolved it. */
  confirmedNow: boolean;
}

function inMemoryRepository(world: FakeWorld): RegistrationRepository {
  const note = (method: string) => world.calls.push(method);

  const put = (payment: PaymentRecord) => {
    world.payment = payment;
    return payment;
  };

  const repository: RegistrationRepository = {
    async transact<T>(work: (tx: RegistrationRepository) => Promise<T>): Promise<T> {
      return work(repository);
    },

    async createPendingRegistration() {
      throw new Error("Not used by the payment slice.");
    },
    async findRegistrationByIdempotencyKey() {
      throw new Error("Not used by the payment slice.");
    },
    async findRegistrationByReference() {
      throw new Error("Not used by the payment slice.");
    },
    async findLatestPayment() {
      throw new Error("Not used by the payment slice.");
    },
    async cancelRegistrationIfPending() {
      throw new Error("Not used by the payment slice.");
    },
    async releaseHeldInventory() {
      throw new Error("Not used by the payment slice.");
    },
    async openPaymentAttempt() {
      throw new Error("Not used by the payment slice.");
    },
    async recordProviderPayload() {
      throw new Error("Not used by the payment slice.");
    },
    async findExpiredHolds() {
      throw new Error("Not used by the payment slice.");
    },

    async findRegistrationTier(registration: RegistrationRecord) {
      note("findRegistrationTier");
      return { ...world.tier, id: registration.ticketTypeId };
    },

    async findPaymentByProviderReference(providerReference: string) {
      note("findPaymentByProviderReference");
      return world.payment?.providerReference === providerReference ? world.payment : null;
    },

    async findRegistrationById(id: string) {
      note("findRegistrationById");
      return world.registration?.id === id ? world.registration : null;
    },

    async markPaymentFailed(paymentId: string, payload: unknown) {
      note("markPaymentFailed");
      return put({ ...(world.payment as PaymentRecord), id: paymentId, status: "failed", rawProviderPayload: payload });
    },

    async markPaymentPending(paymentId: string, payload: unknown) {
      note("markPaymentPending");
      return put({ ...(world.payment as PaymentRecord), id: paymentId, status: "pending", rawProviderPayload: payload });
    },

    async flagPaymentForReconciliation(input: FlagReconciliationInput) {
      note("flagPaymentForReconciliation");
      // §8.5's other half, in the port's contract: the verified truth is recorded and
      // the flag is set together, and the row is NOT moved to `success`.
      return put({
        ...(world.payment as PaymentRecord),
        verifiedAmountMinorUnits: input.verifiedAmountMinorUnits,
        verifiedAt: input.verifiedAt,
        requiresReconciliation: true,
        rawProviderPayload: input.payload,
      });
    },

    async recordUnclaimableSuccess(input: FlagReconciliationInput) {
      note("recordUnclaimableSuccess");
      return put({
        ...(world.payment as PaymentRecord),
        status: "success",
        verifiedAmountMinorUnits: input.verifiedAmountMinorUnits,
        verifiedAt: input.verifiedAt,
        requiresReconciliation: true,
        rawProviderPayload: input.payload,
      });
    },

    async resolveVerifiedPayment(input: ResolveVerifiedPaymentInput): Promise<PaymentResolution> {
      note("resolveVerifiedPayment");

      if (world.confirmationFailure !== null) {
        throw world.confirmationFailure;
      }

      const payment = world.payment as PaymentRecord;

      if (!world.confirmedNow) {
        // A concurrent delivery resolved it between the read and this transaction.
        return { payment, registration: world.registration as RegistrationRecord, confirmedNow: false };
      }

      if (world.tier.quantityHeld < 1) {
        throw new HoldLostError(input.ticketTypeId);
      }

      // The five writes of §8.5, all together.
      world.tier.quantityHeld -= 1;
      world.tier.quantityConfirmed += 1;
      world.registration = { ...(world.registration as RegistrationRecord), status: "confirmed" };

      const resolved = put({
        ...payment,
        status: "success",
        verifiedAmountMinorUnits: input.verifiedAmountMinorUnits,
        verifiedAt: input.verifiedAt,
      });

      return { payment: resolved, registration: world.registration, confirmedNow: true };
    },
  };

  return repository;
}

function fakeProvider(behaviour: () => Promise<VerifiedTransaction | null>) {
  const calls: string[] = [];

  const provider: PaymentProvider = {
    async initiateCheckout() {
      throw new Error("Not used by the payment slice.");
    },
    async verifyTransaction(input) {
      calls.push(input.providerReference);
      return behaviour();
    },
  };

  return { provider, calls };
}

/**
 * The redirect channel, with the provider answering with `verified`.
 *
 * Sets the stub as a side effect because on this channel the transaction is *not* an
 * argument to `resolve` — it is what the provider is asked for and returns. Writing
 * it as an ignored parameter is how this file's first draft asserted amounts the
 * service never received.
 */
const redirect = (verified: VerifiedTransaction | null) => {
  provider = fakeProvider(() => Promise.resolve(verified));

  return {
    providerReference: REFERENCE,
    channel: "redirect" as const,
    verified: null,
  };
};

const webhook = (verified: VerifiedTransaction) => ({
  providerReference: REFERENCE,
  channel: "webhook" as const,
  verified,
  providerTransactionId: verified.transactionId,
});

/**
 * The redirect channel with no opinion about the provider's answer.
 *
 * For the tests that install the provider's own behaviour — a `null`, a rejection —
 * where {@link redirect} would overwrite it with a success.
 */
const redirectChannel = {
  providerReference: REFERENCE,
  channel: "redirect" as const,
  verified: null,
} as const;

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

let world: FakeWorld;
let provider: ReturnType<typeof fakeProvider>;

function buildService(): PaymentService {
  // The provider is bound **late**, on purpose. Each test states the provider's answer
  // inline as the argument to `redirect(...)`, and `buildService()` is evaluated
  // before that argument — so a provider captured here would be the *previous* test's,
  // and the assertions would be about a transaction this service never received.
  const lateBound: PaymentProvider = {
    initiateCheckout: (input) => provider.provider.initiateCheckout(input),
    verifyTransaction: (input) => provider.provider.verifyTransaction(input),
  };

  return new PaymentService(inMemoryRepository(world), lateBound, () => clock);
}

beforeEach(() => {
  clock = VERIFIED_AT;
  world = {
    registration: registrationRow(),
    payment: paymentRow(),
    tier: tierRow(),
    calls: [],
    confirmationFailure: null,
    confirmedNow: true,
  };
  provider = fakeProvider(() => Promise.resolve(verifiedTransaction()));
});

// -----------------------------------------------------------------------------
// The happy path, and its idempotence
// -----------------------------------------------------------------------------

describe("a verified successful payment (redirect channel)", () => {
  it("confirms the registration and the attempt in one step", async () => {
    const outcome = await buildService().resolve(redirectChannel);

    expect(outcome.kind).toBe("confirmed");
    expect(outcome.registration?.status).toBe("confirmed");
    expect(outcome.payment?.status).toBe("success");
    expect(outcome.reason).toBeNull();
  });

  it("moves the tier counter HELD to CONFIRMED, never AVAILABLE to CONFIRMED", async () => {
    await buildService().resolve(redirectChannel);

    expect(world.tier.quantityHeld).toBe(0);
    expect(world.tier.quantityConfirmed).toBe(1);
  });

  it("records the verified amount in MINOR units and the injected instant", async () => {
    // 50 major -> 5,000 minor. Recording 50 next to an expected 5,000 would look like
    // a 50× underpayment and flag every payment in the product.
    const outcome = await buildService().resolve(redirectChannel);

    expect(outcome.payment?.verifiedAmountMinorUnits).toBe(PRICE_MINOR_UNITS);
    expect(outcome.payment?.verifiedAt).toEqual(VERIFIED_AT);
  });

  it("names the tier, which FR-14 requires the confirmation to do", async () => {
    const outcome = await buildService().resolve(redirectChannel);

    expect(outcome.ticketTypeName).toBe("General Admission");
  });

  it("asks the provider by OUR tx_ref", async () => {
    await buildService().resolve(redirectChannel);

    expect(provider.calls).toEqual([REFERENCE]);
  });

  it("is a NO-OP when called again, and says so rather than confirming twice", async () => {
    const service = buildService();
    await service.resolve(redirect(verifiedTransaction()));

    const second = await service.resolve(redirect(verifiedTransaction()));

    expect(second.kind).toBe("already_resolved");
    expect(world.tier.quantityConfirmed).toBe(1);
    expect(world.tier.quantityHeld).toBe(0);
    // A second provider call is still made — the answer must come from the provider,
    // not from a cache — but nothing is written.
    expect(world.calls.filter((call) => call === "resolveVerifiedPayment")).toHaveLength(1);
  });

  it("re-raises a failure from the §8.5 transaction that is not a lost hold", async () => {
    world.confirmationFailure = new Error("connection reset");

    await expect(buildService().resolve(redirectChannel)).rejects.toThrow(
      "connection reset",
    );
  });
});

// -----------------------------------------------------------------------------
// PRD §11: the amount must be equal
// -----------------------------------------------------------------------------

describe("an amount that is not the ticket price", () => {
  it("REFUSES an underpayment and records what was actually charged", async () => {
    const outcome = await buildService().resolve(
      redirect(verifiedTransaction({ amount: 40 })),
    );

    expect(outcome.kind).toBe("reconciliation");
    // The difference is the only place it becomes visible to whoever clears the
    // queue, so the verified amount is recorded rather than nulled.
    expect(outcome.payment?.verifiedAmountMinorUnits).toBe(4_000);
    expect(outcome.payment?.requiresReconciliation).toBe(true);
  });

  it("REFUSES an OVERPAYMENT too, rather than auto-accepting it (D-1)", async () => {
    // The provider's own guidance is "accept if amount >= expected". PRD §11
    // overrides it: an overpayment is still a mismatch and a human decides.
    const outcome = await buildService().resolve(
      redirect(verifiedTransaction({ amount: 60 })),
    );

    expect(outcome.kind).toBe("reconciliation");
    expect(outcome.payment?.verifiedAmountMinorUnits).toBe(6_000);
  });

  it("confirms NOTHING for a mismatch, and never calls it a failure", async () => {
    const outcome = await buildService().resolve(redirect(verifiedTransaction({ amount: 40 })));

    expect(outcome.kind).not.toBe("failed");
    expect(outcome.registration?.status).toBe("pending_payment");
    expect(world.tier.quantityConfirmed).toBe(0);
    expect(world.tier.quantityHeld).toBe(1);
    expect(world.calls).not.toContain("resolveVerifiedPayment");
  });

  it("refuses an amount with no exact minor-unit form, rather than rounding it", async () => {
    // ₦12.345 cannot be stored. Rounding to 12.35 would fabricate a match.
    const outcome = await buildService().resolve(
      redirect(verifiedTransaction({ amount: 12.345 })),
    );

    expect(outcome.kind).toBe("reconciliation");
    expect(outcome.payment?.verifiedAmountMinorUnits).toBeNull();
    expect(outcome.reason).toMatch(/cannot be represented/i);
  });

  it("keeps the provider's RAW payload beside the flag, so the queue is auditable", async () => {
    const raw = { data: { tx_ref: REFERENCE, amount: 40, currency: "NGN" } };

    const outcome = await buildService().resolve(
      redirect(verifiedTransaction({ amount: 40, raw })),
    );

    // Our own sentence must never overwrite the provider's evidence (§14).
    expect(outcome.payment?.rawProviderPayload).toBe(raw);
  });
});

// -----------------------------------------------------------------------------
// Checks 1 and 2: it must be OUR payment, in the ticket's currency
// -----------------------------------------------------------------------------

describe("a transaction that is not this registration's", () => {
  it("refuses a foreign tx_ref, and records no amount for it", async () => {
    // Someone else's transaction has a perfectly plausible amount and status; the
    // reference is the only thing that makes it ours.
    const outcome = await buildService().resolve(
      redirect(verifiedTransaction({ providerReference: "rsv_someoneElse_000000" })),
    );

    expect(outcome.kind).toBe("reconciliation");
    expect(outcome.payment?.verifiedAmountMinorUnits).toBeNull();
    expect(outcome.reason).toMatch(/different transaction reference/i);
  });

  it("refuses a currency that is not the ticket's, and records no amount", async () => {
    // Comparing ₦ against $ would compare different units, so the figure means
    // nothing about this ticket and must not be written into its currency column.
    const outcome = await buildService().resolve(
      redirect(verifiedTransaction({ currency: "USD" })),
    );

    expect(outcome.kind).toBe("reconciliation");
    expect(outcome.payment?.verifiedAmountMinorUnits).toBeNull();
    expect(outcome.reason).toMatch(/USD/);
  });

  it("compares the currency case-insensitively, as a provider label is written", async () => {
    const outcome = await buildService().resolve(
      redirect(verifiedTransaction({ currency: " ngn " })),
    );

    expect(outcome.kind).toBe("confirmed");
  });
});

// -----------------------------------------------------------------------------
// Check 4 and R-2: the registration's own state
// -----------------------------------------------------------------------------

describe("a registration that has already moved on", () => {
  it("refuses to confirm twice, so a counter is not moved twice", async () => {
    world.registration = registrationRow({ status: "confirmed" });

    const outcome = await buildService().resolve(redirectChannel);

    expect(outcome.kind).toBe("reconciliation");
    expect(world.calls).not.toContain("resolveVerifiedPayment");
    expect(world.tier.quantityConfirmed).toBe(0);
  });

  it("treats a checked-in registration the same way", async () => {
    world.registration = registrationRow({ status: "checked_in" });

    expect((await buildService().resolve(redirectChannel)).kind).toBe("reconciliation");
  });

  it("R-2: a CANCELLED registration records a success but grants no ticket", async () => {
    // The hold already released these units, so a confirmation would sell stock that
    // is gone; §9.2's `cancelled -> confirmed` prohibition is not relaxed.
    world.registration = registrationRow({ status: "cancelled" });

    const outcome = await buildService().resolve(redirectChannel);

    expect(outcome.kind).toBe("reconciliation");
    expect(outcome.payment?.status).toBe("success");
    expect(outcome.payment?.verifiedAmountMinorUnits).toBe(PRICE_MINOR_UNITS);
    expect(world.tier.quantityConfirmed).toBe(0);
    expect(world.calls).not.toContain("resolveVerifiedPayment");
  });

  it("R-2 via a lost race: a hold released mid-flight is handled the same way", async () => {
    world.confirmationFailure = new HoldLostError(TIER_ID);

    const outcome = await buildService().resolve(redirectChannel);

    expect(outcome.kind).toBe("reconciliation");
    expect(world.calls).toContain("recordUnclaimableSuccess");
    expect(world.registration?.status).toBe("pending_payment");
    expect(world.tier.quantityConfirmed).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// Non-successful outcomes
// -----------------------------------------------------------------------------

describe("a provider status that is not a success", () => {
  it("marks a FAILED attempt failed, and leaves the hold alone for release", async () => {
    const outcome = await buildService().resolve(
      redirect(verifiedTransaction({ status: "failed" })),
    );

    expect(outcome.kind).toBe("failed");
    expect(outcome.payment?.status).toBe("failed");
    expect(world.registration?.status).toBe("pending_payment");
    expect(world.tier.quantityHeld).toBe(1);
  });

  it("treats a CANCELLED transaction as failed", async () => {
    expect(
      (await buildService().resolve(redirect(verifiedTransaction({ status: "cancelled" })))).kind,
    ).toBe("failed");
  });

  it("marks a PENDING attempt pending, without closing it", async () => {
    // §9.1 defines `pending` as a real state: the payment may yet succeed and will
    // arrive again, so the attempt must stay open.
    const outcome = await buildService().resolve(
      redirect(verifiedTransaction({ status: "pending" })),
    );

    expect(outcome.kind).toBe("pending");
    expect(outcome.payment?.status).toBe("pending");
    expect(outcome.payment?.requiresReconciliation).toBe(false);
  });

  it("REFUSES to confirm a refunded transaction", async () => {
    const outcome = await buildService().resolve(
      redirect(verifiedTransaction({ status: "refunded" })),
    );

    expect(outcome.kind).toBe("pending");
    expect(world.calls).not.toContain("resolveVerifiedPayment");
  });

  it("REFUSES to confirm an unrecognised status, which is not success (§15)", async () => {
    const outcome = await buildService().resolve(
      redirect(verifiedTransaction({ status: "unknown" })),
    );

    expect(outcome.kind).toBe("pending");
    expect(world.calls).not.toContain("resolveVerifiedPayment");
  });
});

// -----------------------------------------------------------------------------
// When there is no answer
// -----------------------------------------------------------------------------

describe("when the provider cannot be asked", () => {
  it("reports an unknown reference without inventing a row", async () => {
    provider = fakeProvider(() => Promise.resolve(verifiedTransaction({ providerReference: "rsv_other" })));

    const outcome = await buildService().resolve({
      providerReference: "rsv_neverIssued",
      channel: "redirect",
      verified: null,
    });

    expect(outcome.kind).toBe("unknown_reference");
    expect(outcome.payment).toBeNull();
    expect(world.calls).toEqual(["findPaymentByProviderReference"]);
  });

  it("reports a provider 'no such transaction' as an unknown reference", async () => {
    // A `null` result is the provider saying the payment is not there — a real answer,
    // distinct from being unable to ask.
    provider = fakeProvider(() => Promise.resolve(null));

    const outcome = await buildService().resolve(redirectChannel);

    expect(outcome.kind).toBe("unknown_reference");
    expect(world.payment?.status).toBe("initiated");
  });

  it("reports an INDETERMINATE provider error as pending, and changes nothing", async () => {
    // 503 or our own timeout: the payment may still be processing. Writing "failed"
    // here is the false failure §17 forbids, and inviting a retry is the duplicate the
    // provider's own guidance warns against.
    provider = fakeProvider(() =>
      Promise.reject(new PaymentProviderError("indeterminate", "Service unavailable", 503, null)),
    );

    const outcome = await buildService().resolve(redirectChannel);

    expect(outcome.kind).toBe("pending");
    expect(outcome.payment?.status).toBe("initiated");
    // Reads and the tier lookup for the projection — and nothing else. In particular no
    // write, because "we do not know" must leave the attempt exactly as it was.
    expect(world.calls).toEqual([
      "findPaymentByProviderReference",
      "findRegistrationById",
      "findRegistrationTier",
    ]);
  });

  it("gives the organiser a queue hint, in our own words", async () => {
    provider = fakeProvider(() =>
      Promise.reject(new PaymentProviderError("indeterminate", "Service unavailable", 503, null)),
    );

    const outcome = await buildService().resolve(redirectChannel);

    expect(outcome.reason).toMatch(/could not confirm/i);
    // Rule 08: the provider's own diagnostic is not carried anywhere.
    expect(JSON.stringify(outcome.reason)).not.toContain("503");
  });

  it("reports every other provider error as pending too, never as a failure", async () => {
    // A 401 from a misconfigured secret key says nothing about whether the money
    // moved. Failing loudly in the organiser's queue beats lying to an attendee.
    for (const kind of ["rejected", "rate_limited", "malformed"] as const) {
      provider = fakeProvider(() =>
        Promise.reject(new PaymentProviderError(kind, "provider said no", 400, "Invalid key")),
      );

      const outcome = await buildService().resolve(redirectChannel);

      expect(outcome.kind).toBe("pending");
      expect(world.payment?.status).toBe("initiated");
    }
  });

  it("re-raises a non-provider error, so a bug is not reported as a payment state", async () => {
    provider = fakeProvider(() => Promise.reject(new TypeError("bug")));

    await expect(buildService().resolve(redirectChannel)).rejects.toBeInstanceOf(TypeError);
  });
});

// -----------------------------------------------------------------------------
// The webhook channel (§8.6)
// -----------------------------------------------------------------------------

describe("the webhook channel", () => {
  it("does NOT re-query the provider, because it is the authoritative report", async () => {
    await buildService().resolve(webhook(verifiedTransaction()));

    expect(provider.calls).toEqual([]);
  });

  it("confirms on the same rules as the redirect", async () => {
    const outcome = await buildService().resolve(webhook(verifiedTransaction()));

    expect(outcome.kind).toBe("confirmed");
    expect(world.tier.quantityConfirmed).toBe(1);
  });

  it("governs a disagreement: a webhook success confirms what a redirect saw as failed", async () => {
    // The redirect path already recorded a terminal failure; §8.6 makes the webhook
    // the eventual source of truth, so a re-delivered success must still be able to
    // grant the ticket. (The stored `failed` row is reset to `initiated` here so the
    // scenario is reachable at all — the reset is the test's, not the product's.)
    world.payment = paymentRow({ status: "initiated", rawProviderPayload: null });

    const outcome = await buildService().resolve(webhook(verifiedTransaction()));

    expect(outcome.kind).toBe("confirmed");
  });

  it("applies the same mismatch rule, so the channel cannot bypass §11", async () => {
    const outcome = await buildService().resolve(webhook(verifiedTransaction({ amount: 40 })));

    expect(outcome.kind).toBe("reconciliation");
    expect(world.calls).not.toContain("resolveVerifiedPayment");
  });

  it("rejects a webhook whose payload is not the payment that was asked about", async () => {
    // Check 1 runs for this channel too. The route looks the payment up by the
    // reference in the path/URL, and a payload carrying a different one is refused
    // rather than applied to the wrong registration.
    const outcome = await buildService().resolve(
      webhook(verifiedTransaction({ providerReference: "rsv_someoneElse_000000" })),
    );

    expect(outcome.kind).toBe("reconciliation");
    expect(world.calls).not.toContain("resolveVerifiedPayment");
  });
});

// -----------------------------------------------------------------------------
// Bookkeeping defects
// -----------------------------------------------------------------------------

describe("a payment whose registration row is missing", () => {
  it("flags it and KEEPS the stored provider payload", async () => {
    // Unreachable through any write this product makes (`RESTRICT`), so this is a
    // bookkeeping defect. Overwriting `raw_provider_payload` with our own reason
    // would destroy the only provider evidence the attempt has.
    world.registration = null;
    const stored = world.payment?.rawProviderPayload;

    const outcome = await buildService().resolve(redirectChannel);

    expect(outcome.kind).toBe("reconciliation");
    expect(outcome.payment?.rawProviderPayload).toBe(stored);
    expect(outcome.payment?.requiresReconciliation).toBe(true);
  });

  it("reports a success already flagged for review as reconciliation, not confirmed", async () => {
    // R-1's ordering rule: a `success` row that carries the flag must never render as
    // a clean confirmation, and never as a failure either.
    world.payment = paymentRow({ status: "success", requiresReconciliation: true });

    const outcome = await buildService().resolve(redirectChannel);

    expect(outcome.kind).toBe("reconciliation");
    expect(outcome.reason).toMatch(/manual review/i);
  });

  it("reports an already-failed attempt as resolved, without asking the provider", async () => {
    world.payment = paymentRow({ status: "failed" });

    const outcome = await buildService().resolve(redirectChannel);

    expect(outcome.kind).toBe("already_resolved");
    expect(provider.calls).toEqual([]);
  });
});

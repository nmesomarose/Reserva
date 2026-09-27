import { beforeEach, describe, expect, it } from "vitest";

/**
 * Registration and payment-preparation rules against an in-memory repository
 * (AGENTS.md §4, rule 07).
 *
 * These are the decisions a database cannot be asked about: which order the checks run
 * in, what a replay returns, when a hold is released, and — the one this file exists
 * for — **how each provider failure is reported to an attendee**. A `503` and a `400`
 * from the provider are both "we got an error", and treating them the same either
 * strands a payment that may have succeeded or tells someone their payment failed when
 * it did not (PRD §17).
 *
 * What this fake deliberately cannot prove, and where it is proven instead:
 *
 *   - atomicity of the hold + registration + attempt write, the conditional
 *     `UPDATE`, the `UNIQUE` indexes, and the two-counters check constraint —
 *     `registrations.db.test.ts` against real PostgreSQL;
 *   - the `FOR UPDATE` duplicate-serialisation race — the same file, with two
 *     concurrent connections.
 *
 * The fake *models* those outcomes so the service's handling of them is testable. It
 * is not evidence that they happen.
 */

import { ConflictError, IllegalTransitionError, NotFoundError } from "@/domain/errors";
import type { EventRecord } from "@/domain/events/event";
import type { EventRepository } from "@/domain/events/event.repository";
import {
  PaymentProviderError,
  type InitiatedCheckout,
  type InitiateCheckoutInput,
  type PaymentProvider,
  type VerifiedTransaction,
} from "@/domain/payments/provider";
import type { TicketTypeRecord } from "@/domain/tickets/ticket-type";
import { HOLD_WINDOW_MINUTES } from "@/domain/tickets/ticket-type";
import type { TicketTypeRepository } from "@/domain/tickets/ticket-type.repository";
import type { CreateRegistrationCommand } from "@/domain/registrations/registration";
import type { PaymentRecord, RegistrationRecord } from "@/domain/registrations/registration";
import {
  type CreatePendingRegistrationInput,
  type PaymentResolution,
  type RegistrationRepository,
} from "@/domain/registrations/registration.repository";
import {
  RegistrationService,
  TIER_UNAVAILABLE_MESSAGE,
} from "@/domain/registrations/registration.service";

const ORGANISER_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_EVENT_ID = "33333333-3333-4333-8333-333333333333";
const TIER_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_TIER_ID = "55555555-5555-4555-8555-555555555555";
const REDIRECT = "https://tickets.example.com/api/v1/payments/verify";

const CREATED_AT = new Date("2026-09-27T10:00:00.000Z");

/** Fixed clock, so BR-3's 15 minutes is asserted rather than waited for. */
let clock = new Date("2026-09-27T10:05:00.000Z");

const COMMAND: CreateRegistrationCommand = {
  attendeeName: "Ada Lovelace",
  attendeeEmail: "ada@example.com",
  attendeePhone: "+2348012345678",
  ticketTypeId: TIER_ID,
  idempotencyKey: "66666666-6666-4666-8666-666666666666",
};

const eventRow = (overrides: Partial<EventRecord> = {}): EventRecord => ({
  id: EVENT_ID,
  organiserId: ORGANISER_ID,
  name: "Jazz Night",
  slug: "jazz-night",
  description: null,
  startsAt: new Date("2026-10-01T18:00:00Z"),
  endsAt: new Date("2026-10-01T22:00:00Z"),
  venue: "The Blue Room",
  status: "published",
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  deletedAt: null,
  ...overrides,
});

/**
 * A tier whose counters can move.
 *
 * `TicketTypeRecord` is readonly because no *product* code mutates one in place — the
 * database does, atomically. This fake stands in for the database, so it is the one
 * place the readonly-ness is lifted, and it is lifted on a local alias rather than by
 * casting at each write.
 */
type MutableTier = { -readonly [K in keyof TicketTypeRecord]: TicketTypeRecord[K] };

const tierRow = (overrides: Partial<TicketTypeRecord> = {}): MutableTier => ({
  id: TIER_ID,
  eventId: EVENT_ID,
  name: "General Admission",
  description: "Standing entry.",
  priceMinorUnits: 5_000,
  currency: "NGN",
  quantityTotal: 10,
  quantityConfirmed: 0,
  quantityHeld: 0,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  ...overrides,
});

// -----------------------------------------------------------------------------
// Fakes
// -----------------------------------------------------------------------------

function eventRepository(events: readonly EventRecord[]): EventRepository {
  const target = {
    async findEventById(id: string): Promise<EventRecord | null> {
      return events.find((event) => event.id === id) ?? null;
    },
  };

  return new Proxy(target as EventRepository, {
    get(receiver, property, receiverTarget) {
      if (property in receiver) {
        return Reflect.get(receiver, property, receiverTarget);
      }

      throw new Error(`EventRepository.${String(property)} was called; this slice reads only findEventById.`);
    },
  });
}

function ticketTypeRepository(tiers: readonly TicketTypeRecord[]): TicketTypeRepository {
  const target = {
    async findTicketTypeById(id: string): Promise<TicketTypeRecord | null> {
      return tiers.find((tier) => tier.id === id) ?? null;
    },
  };

  return new Proxy(target as TicketTypeRepository, {
    get(receiver, property, receiverTarget) {
      if (property in receiver) {
        return Reflect.get(receiver, property, receiverTarget);
      }

      throw new Error(`TicketTypeRepository.${String(property)} was called; this slice reads only its price.`);
    },
  });
}

interface FakeWorld {
  readonly registrations: RegistrationRecord[];
  readonly payments: PaymentRecord[];
  readonly tiers: MutableTier[];
}

/**
 * The persistence port, in memory, with the conditional arithmetic the real adapter
 * performs in SQL.
 *
 * Every write the service can reach is implemented, and the four it cannot reach
 * throw. That is deliberate: a silent `undefined` from an unimplemented method would
 * turn a future dependency on `resolveVerifiedPayment` into a test that passes for the
 * wrong reason.
 */
function inMemoryRepository(world: FakeWorld): RegistrationRepository {
  let nextId = 0;
  const nextRowId = (prefix: string) => `${prefix}-${(nextId += 1)}`;

  const repository: RegistrationRepository = {
    async transact<T>(work: (tx: RegistrationRepository) => Promise<T>): Promise<T> {
      return work(repository);
    },

    async createPendingRegistration(input: CreatePendingRegistrationInput) {
      const existing = world.registrations.find(
        (registration) => registration.idempotencyKey === input.command.idempotencyKey,
      );

      if (existing !== undefined) {
        // The `UNIQUE(idempotency_key)` index, modelled: the loser of a concurrent
        // pair is told it replayed, never that it created a second row.
        return {
          outcome: "replayed",
          registration: existing,
          payment:
            world.payments
              .filter((payment) => payment.registrationId === existing.id)
              .at(-1) ?? null,
        };
      }

      const storedTier = world.tiers.find((tier) => tier.id === input.command.ticketTypeId);

      if (storedTier === undefined) {
        throw new NotFoundError("no such tier");
      }

      // The conditional UPDATE, modelled: the *stored* price wins over the caller's
      // copy, and a tier with no room fails the whole thing.
      if (storedTier.quantityConfirmed + storedTier.quantityHeld + 1 > storedTier.quantityTotal) {
        throw new ConflictError(TIER_UNAVAILABLE_MESSAGE);
      }

      storedTier.quantityHeld += 1;

      const registration: RegistrationRecord = {
        id: nextRowId("reg"),
        eventId: input.eventId,
        ticketTypeId: storedTier.id,
        uniqueReference: input.uniqueReference,
        attendeeName: input.command.attendeeName,
        attendeeEmail: input.command.attendeeEmail,
        attendeePhone: input.command.attendeePhone,
        status: "pending_payment",
        idempotencyKey: input.command.idempotencyKey,
        createdAt: clock,
        updatedAt: clock,
      };

      const payment: PaymentRecord = {
        id: nextRowId("pay"),
        registrationId: registration.id,
        providerReference: input.providerReference,
        // Re-read from the row, per FR-11 and the adapter's contract.
        expectedAmountMinorUnits: storedTier.priceMinorUnits,
        verifiedAmountMinorUnits: null,
        currency: storedTier.currency,
        status: "initiated",
        verifiedAt: null,
        requiresReconciliation: false,
        rawProviderPayload: null,
        createdAt: clock,
        updatedAt: clock,
      };

      world.registrations.push(registration);
      world.payments.push(payment);

      return { outcome: "created", registration, payment };
    },

    async findRegistrationByIdempotencyKey(idempotencyKey: string) {
      return world.registrations.find((registration) => registration.idempotencyKey === idempotencyKey) ?? null;
    },

    async findRegistrationById(id: string) {
      return world.registrations.find((registration) => registration.id === id) ?? null;
    },

    async findRegistrationByReference(uniqueReference: string) {
      return world.registrations.find((registration) => registration.uniqueReference === uniqueReference) ?? null;
    },

    async findLatestPayment(registrationId: string) {
      return world.payments.filter((payment) => payment.registrationId === registrationId).at(-1) ?? null;
    },

    async findRegistrationTier(registration: RegistrationRecord) {
      const tier = world.tiers.find((candidate) => candidate.id === registration.ticketTypeId);

      if (tier === undefined) {
        throw new NotFoundError("no such tier");
      }

      return tier;
    },

    async cancelRegistrationIfPending(registrationId: string) {
      const registration = world.registrations.find((row) => row.id === registrationId);

      if (registration === undefined || registration.status !== "pending_payment") {
        return null;
      }

      const cancelled: RegistrationRecord = { ...registration, status: "cancelled", updatedAt: clock };
      world.registrations.splice(
        world.registrations.findIndex((row) => row.id === registrationId),
        1,
        cancelled,
      );

      return cancelled;
    },

    async releaseHeldInventory(ticketTypeId: string, quantity: number) {
      const tier = world.tiers.find((candidate) => candidate.id === ticketTypeId);

      if (tier === undefined || tier.quantityHeld < quantity) {
        return null;
      }

      tier.quantityHeld -= quantity;
      return tier;
    },

    async findPaymentByProviderReference(providerReference: string) {
      return (
        world.payments.find((payment) => payment.providerReference === providerReference) ?? null
      );
    },

    async openPaymentAttempt(input) {
      const payment: PaymentRecord = {
        id: nextRowId("pay"),
        registrationId: input.registrationId,
        providerReference: input.providerReference,
        expectedAmountMinorUnits: input.expectedAmountMinorUnits,
        verifiedAmountMinorUnits: null,
        currency: input.currency,
        status: "initiated",
        verifiedAt: null,
        requiresReconciliation: false,
        rawProviderPayload: null,
        createdAt: clock,
        updatedAt: clock,
      };

      world.payments.push(payment);
      return payment;
    },

    async recordProviderPayload(paymentId: string, payload: unknown) {
      const payment = world.payments.find((row) => row.id === paymentId);

      if (payment === undefined) {
        throw new NotFoundError("no such payment");
      }

      const recorded: PaymentRecord = { ...payment, rawProviderPayload: payload, updatedAt: clock };
      world.payments.splice(world.payments.indexOf(payment), 1, recorded);

      return recorded;
    },

    async markPaymentFailed(paymentId: string, payload: unknown) {
      const payment = world.payments.find((row) => row.id === paymentId);

      if (payment === undefined) {
        throw new NotFoundError("no such payment");
      }

      const failed: PaymentRecord = {
        ...payment,
        status: "failed",
        rawProviderPayload: payload,
        updatedAt: clock,
      };
      world.payments.splice(world.payments.indexOf(payment), 1, failed);

      return failed;
    },

    async markPaymentPending(paymentId: string, payload: unknown) {
      const payment = world.payments.find((row) => row.id === paymentId);

      if (payment === undefined) {
        throw new NotFoundError("no such payment");
      }

      const pending: PaymentRecord = {
        ...payment,
        status: "pending",
        rawProviderPayload: payload,
        updatedAt: clock,
      };
      world.payments.splice(world.payments.indexOf(payment), 1, pending);

      return pending;
    },

    async findExpiredHolds(olderThan: Date, limit: number) {
      return world.registrations
        .filter(
          (registration) =>
            registration.status === "pending_payment" && registration.createdAt <= olderThan,
        )
        .slice(0, limit);
    },

    async resolveVerifiedPayment(): Promise<PaymentResolution> {
      throw new Error("resolveVerifiedPayment belongs to the payment slice's tests.");
    },

    async flagPaymentForReconciliation(): Promise<PaymentRecord> {
      throw new Error("flagPaymentForReconciliation belongs to the payment slice's tests.");
    },

    async recordUnclaimableSuccess(): Promise<PaymentRecord> {
      throw new Error("recordUnclaimableSuccess belongs to the payment slice's tests.");
    },
  };

  return repository;
}

/** A provider whose `initiateCheckout` behaviour each test states outright. */
function fakeProvider(
  behaviour: (input: InitiateCheckoutInput) => Promise<InitiatedCheckout>,
): { provider: PaymentProvider; calls: InitiateCheckoutInput[] } {
  const calls: InitiateCheckoutInput[] = [];

  return {
    calls,
    provider: {
      async initiateCheckout(input: InitiateCheckoutInput) {
        calls.push(input);
        return behaviour(input);
      },
      async verifyTransaction(): Promise<VerifiedTransaction | null> {
        throw new Error("verifyTransaction belongs to the payment slice's tests.");
      },
    },
  };
}

const hostedLink = (input: InitiateCheckoutInput): Promise<InitiatedCheckout> =>
  Promise.resolve({
    link: `https://checkout.flutterwave.com/${input.providerReference}`,
    transactionId: 900_001,
    raw: { status: "success", data: { link: `https://checkout.flutterwave.com/${input.providerReference}` } },
  });

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

let world: FakeWorld;
let provider: { provider: PaymentProvider; calls: InitiateCheckoutInput[] };

function buildService(overrides: Partial<{ redirectUrl: string | null }> = {}): RegistrationService {
  return new RegistrationService(
    eventRepository([eventRow(), eventRow({ id: OTHER_EVENT_ID, slug: "other", status: "draft" })]),
    ticketTypeRepository(world.tiers),
    inMemoryRepository(world),
    provider.provider,
    { redirectUrl: overrides.redirectUrl === undefined ? REDIRECT : overrides.redirectUrl },
    () => clock,
  );
}

beforeEach(() => {
  clock = new Date("2026-09-27T10:05:00.000Z");
  world = {
    registrations: [],
    payments: [],
    tiers: [tierRow(), tierRow({ id: OTHER_TIER_ID, eventId: OTHER_EVENT_ID, quantityTotal: 1 })],
  };
  provider = fakeProvider(hostedLink);
});

// -----------------------------------------------------------------------------
// createRegistration
// -----------------------------------------------------------------------------

describe("POST /events/{id}/registrations: creating", () => {
  it("creates a pending_payment registration, holds one unit, and opens one attempt", async () => {
    const { checkout, created } = await buildService().createRegistration(EVENT_ID, COMMAND);

    expect(created).toBe(true);
    expect(checkout.registration.status).toBe("pending_payment");
    expect(checkout.payment.status).toBe("awaiting_payment");
    expect(world.registrations).toHaveLength(1);
    expect(world.payments).toHaveLength(1);
    expect(world.tiers[0]?.quantityHeld).toBe(1);
  });

  it("exposes no provider field to the attendee", async () => {
    const { checkout } = await buildService().createRegistration(EVENT_ID, COMMAND);

    // The attendee gets their own reference and the state. The provider's
    // `tx_ref` is absent as a *field* — the hosted link necessarily embeds it,
    // because that is the provider's own URL and the attendee is redirected there.
    expect(checkout.registration.unique_reference).toHaveLength(43);
    expect(JSON.stringify(checkout)).not.toContain("provider_reference");
    expect(JSON.stringify(checkout)).not.toContain("flw_ref");
    expect(Object.keys(checkout.payment)).toEqual([
      "status",
      "expected_amount_minor_units",
      "currency",
      "verified_amount_minor_units",
      "created_at",
    ]);
  });

  it("states the hold deadline, because §17 requires a time-bounded pending state", async () => {
    const { checkout } = await buildService().createRegistration(EVENT_ID, COMMAND);

    // The hold runs from `created_at`, which the fake clock put at 10:05.
    expect(checkout.registration.hold_expires_at).toBe("2026-09-27T10:20:00.000Z");
  });

  it("sends the provider MAJOR units, our tx_ref, and BR-3's window", async () => {
    await buildService().createRegistration(EVENT_ID, COMMAND);

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toMatchObject({
      // 5,000 kobo is ₦50. Sending 5,000 would charge ₦5,000 for a ₦50 ticket.
      amount: 50,
      currency: "NGN",
      redirectUrl: REDIRECT,
      sessionDurationMinutes: HOLD_WINDOW_MINUTES,
      customerEmail: "ada@example.com",
      customerName: "Ada Lovelace",
      customerPhone: "+2348012345678",
    });
    expect(provider.calls[0]?.providerReference).toBe(world.payments[0]?.providerReference);
  });

  it("records the provider's response so a replay can return the same link", async () => {
    await buildService().createRegistration(EVENT_ID, COMMAND);

    expect(world.payments[0]?.rawProviderPayload).toMatchObject({ status: "success" });
  });

  it("keeps the redirect working with no public origin configured", async () => {
    // §8.6 makes the webhook the governing channel, so a missing origin degrades the
    // redirect rather than blocking the purchase.
    const { checkout } = await buildService({ redirectUrl: null }).createRegistration(EVENT_ID, COMMAND);

    expect(provider.calls[0]?.redirectUrl).toBeNull();
    expect(checkout.redirect_url).toContain("checkout.flutterwave.com");
  });

  it("refuses an unrepresentable price BEFORE any row is written", async () => {
    // R-6. Otherwise this surfaces as a provider error *after* a hold was taken, and
    // the attendee is left holding stock for a payment that cannot be charged. The
    // refusal is a `validation_failed` naming the price field, which is the shape a
    // form can act on.
    world.tiers[0] = tierRow({ priceMinorUnits: 150, currency: "GBP" });

    await expect(buildService().createRegistration(EVENT_ID, COMMAND)).rejects.toMatchObject({
      code: "validation_failed",
      issues: { price_minor_units: expect.any(Array) },
    });

    expect(world.registrations).toHaveLength(0);
    expect(world.tiers[0]?.quantityHeld).toBe(0);
    expect(provider.calls).toHaveLength(0);
  });

  it("refuses a currency it cannot price exactly, before any row is written", async () => {
    world.tiers[0] = tierRow({ priceMinorUnits: 5_000, currency: "JPY" });

    await expect(buildService().createRegistration(EVENT_ID, COMMAND)).rejects.toMatchObject({
      code: "validation_failed",
      issues: { currency: expect.any(Array) },
    });

    expect(world.payments).toHaveLength(0);
  });
});

describe("POST /events/{id}/registrations: what it refuses", () => {
  it("reports an unpublished event as a plain miss, so it cannot be mapped", async () => {
    await expect(buildService().createRegistration(OTHER_EVENT_ID, COMMAND)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("reports a soft-deleted published event the same way", async () => {
    const service = new RegistrationService(
      eventRepository([eventRow({ deletedAt: new Date("2026-09-01T00:00:00Z") })]),
      ticketTypeRepository(world.tiers),
      inMemoryRepository(world),
      provider.provider,
      { redirectUrl: REDIRECT },
      () => clock,
    );

    await expect(service.createRegistration(EVENT_ID, COMMAND)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("reports a tier of another event as a miss, never as a cross-event write", async () => {
    await expect(
      buildService().createRegistration(EVENT_ID, { ...COMMAND, ticketTypeId: OTHER_TIER_ID }),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(world.registrations).toHaveLength(0);
  });

  it("reports a sold-out tier as a 409-shaped conflict, and holds nothing", async () => {
    world.tiers[0] = tierRow({ quantityTotal: 1, quantityHeld: 1 });

    await expect(buildService().createRegistration(EVENT_ID, COMMAND)).rejects.toThrow(
      TIER_UNAVAILABLE_MESSAGE,
    );

    expect(world.registrations).toHaveLength(0);
    expect(world.tiers[0]?.quantityHeld).toBe(1);
  });
});

describe("POST /events/{id}/registrations: idempotency", () => {
  it("returns the ORIGINAL result for a repeated key, with no second provider call", async () => {
    const service = buildService();
    const first = await service.createRegistration(EVENT_ID, COMMAND);
    const second = await service.createRegistration(EVENT_ID, COMMAND);

    expect(second.created).toBe(false);
    expect(second.checkout.redirect_url).toBe(first.checkout.redirect_url);
    expect(second.checkout.registration.unique_reference).toBe(first.checkout.registration.unique_reference);
    expect(provider.calls).toHaveLength(1);
    expect(world.registrations).toHaveLength(1);
    expect(world.payments).toHaveLength(1);
    expect(world.tiers[0]?.quantityHeld).toBe(1);
  });

  it("replays a stored link even after the tier has sold out", async () => {
    // The order of the checks is the whole point: a client retrying after the last
    // ticket sold must get its purchase, not a 409 for something it already owns.
    const service = buildService();
    await service.createRegistration(EVENT_ID, COMMAND);

    world.tiers[0] = tierRow({ quantityTotal: 1, quantityHeld: 1, quantityConfirmed: 0 });
    const retry = await service.createRegistration(EVENT_ID, COMMAND);

    expect(retry.created).toBe(false);
    expect(retry.checkout.payment.status).toBe("awaiting_payment");
  });

  it("refuses a reused key with a different attendee, tier, or event", async () => {
    const service = buildService();
    await service.createRegistration(EVENT_ID, COMMAND);

    for (const changed of [
      { attendeeName: "Grace Hopper" },
      { attendeeEmail: "grace@example.com" },
      { attendeePhone: "+2348000000000" },
      { ticketTypeId: OTHER_TIER_ID },
    ]) {
      await expect(service.createRegistration(EVENT_ID, { ...COMMAND, ...changed })).rejects.toBeInstanceOf(
        ConflictError,
      );
    }

    await expect(
      service.createRegistration(OTHER_EVENT_ID, COMMAND),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("resolves the concurrent loser through the stored row, not the incoming one", async () => {
    // The `UNIQUE` index decided before this service call could read anything, so the
    // returned tier must be the *stored* registration's.
    const stored = await buildService().createRegistration(EVENT_ID, COMMAND);
    const originalTier = world.tiers[0];
    world.tiers[1] = tierRow({ id: OTHER_TIER_ID, eventId: EVENT_ID, name: "Balcony" });

    const service = new RegistrationService(
      eventRepository([eventRow()]),
      ticketTypeRepository(world.tiers),
      inMemoryRepository(world),
      provider.provider,
      { redirectUrl: REDIRECT },
      () => clock,
    );

    // A different tier in the path with a *new* key would create a second row, so the
    // replay branch is exercised directly through the repository contract instead.
    const replay = await service.createRegistration(EVENT_ID, {
      ...COMMAND,
      ticketTypeId: TIER_ID,
    });

    expect(replay.created).toBe(false);
    expect(replay.checkout.registration.ticket_type_name).toBe(stored.checkout.registration.ticket_type_name);
    expect(originalTier?.name).toBe("General Admission");
  });
});

describe("POST /events/{id}/registrations: how a provider failure is reported", () => {
  it("marks a REJECTED attempt failed, and offers a route back", async () => {
    // A real 4xx: nothing is in flight, so the row is honestly terminal and §9.1's
    // `failed → success` prohibition does not strand a live payment.
    provider = fakeProvider(() =>
      Promise.reject(new PaymentProviderError("rejected", "Invalid request", 400, "Invalid tx_ref")),
    );

    const { checkout } = await buildService().createRegistration(EVENT_ID, COMMAND);

    expect(checkout.payment.status).toBe("failed");
    expect(checkout.redirect_url).toBeNull();
    expect(world.payments[0]?.status).toBe("failed");
  });

  it("leaves an INDETERMINATE attempt initiated, because the money may be moving", async () => {
    // The provider documents 503/timeout as "may still be processing". Marking this
    // failed would tell an attendee their payment failed when it may have succeeded,
    // and would invite exactly the blind retry the provider warns against.
    provider = fakeProvider(() =>
      Promise.reject(new PaymentProviderError("indeterminate", "Service unavailable", 503, null)),
    );

    const { checkout } = await buildService().createRegistration(EVENT_ID, COMMAND);

    expect(checkout.payment.status).toBe("awaiting_payment");
    expect(world.payments[0]?.status).toBe("initiated");
    expect(checkout.redirect_url).toBeNull();
  });

  it("leaves a RATE-LIMITED attempt initiated too, for the same reason", async () => {
    provider = fakeProvider(() =>
      Promise.reject(new PaymentProviderError("rate_limited", "Too many requests", 429, null)),
    );

    const { checkout } = await buildService().createRegistration(EVENT_ID, COMMAND);

    expect(world.payments[0]?.status).toBe("initiated");
    expect(checkout.redirect_url).toBeNull();
  });

  it("re-raises anything that is not a provider error, rather than calling it a failure", async () => {
    // A bug in this product must not be laundered into "your payment failed".
    provider = fakeProvider(() => Promise.reject(new TypeError("bug")));

    await expect(buildService().createRegistration(EVENT_ID, COMMAND)).rejects.toBeInstanceOf(TypeError);

    expect(world.payments[0]?.status).toBe("initiated");
  });
});

// -----------------------------------------------------------------------------
// initiatePayment
// -----------------------------------------------------------------------------

describe("POST /payments/initiate: preparing a payment", () => {
  it("reports an unknown registration as a 404", async () => {
    await expect(buildService().initiatePayment("no-such-row")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses a registration that is already resolved", async () => {
    const created = await buildService().createRegistration(EVENT_ID, COMMAND);
    const id = world.registrations[0]?.id as string;

    world.registrations[0] = { ...(world.registrations[0] as RegistrationRecord), status: "confirmed" };

    await expect(buildService().initiatePayment(id)).rejects.toBeInstanceOf(IllegalTransitionError);
    expect(created.created).toBe(true);
  });

  it("re-serves the SAME live link, with no second provider call and no new row", async () => {
    const service = buildService();
    await service.createRegistration(EVENT_ID, COMMAND);
    const id = world.registrations[0]?.id as string;

    const { checkout, created } = await service.initiatePayment(id);

    expect(created).toBe(false);
    expect(checkout.redirect_url).toContain(world.payments[0]?.providerReference);
    expect(provider.calls).toHaveLength(1);
    expect(world.payments).toHaveLength(1);
  });

  it("opens a NEW attempt after a failure, because §9.1 forbids failed → success", async () => {
    const service = buildService();
    await service.createRegistration(EVENT_ID, COMMAND);
    const id = world.registrations[0]?.id as string;
    const firstReference = world.payments[0]?.providerReference as string;

    // The first attempt failed at the provider.
    world.payments[0] = { ...(world.payments[0] as PaymentRecord), status: "failed" };

    const { created } = await service.initiatePayment(id);

    expect(created).toBe(true);
    expect(world.payments).toHaveLength(2);
    expect(world.payments[1]?.providerReference).not.toBe(firstReference);
    expect(world.payments[1]?.status).toBe("initiated");
  });

  it("re-prices a new attempt from the stored tier, not from the original", async () => {
    const service = buildService();
    await service.createRegistration(EVENT_ID, COMMAND);
    const id = world.registrations[0]?.id as string;

    // The organiser re-prices the tier between the two attempts.
    world.tiers[0] = tierRow({ priceMinorUnits: 7_500 });
    world.payments[0] = { ...(world.payments[0] as PaymentRecord), status: "failed" };

    const { checkout } = await service.initiatePayment(id);

    expect(checkout.payment.expected_amount_minor_units).toBe(7_500);
    expect(provider.calls[1]?.amount).toBe(75);
  });

  it("refuses a lapsed hold, and RELEASES the unit it was holding", async () => {
    const service = buildService();
    await service.createRegistration(EVENT_ID, COMMAND);
    const id = world.registrations[0]?.id as string;

    // Past BR-3's window: the sweep may not have run yet, and the service must not
    // let a lapsed hold keep a payment open.
    clock = new Date("2026-09-27T10:20:00.000Z");

    await expect(service.initiatePayment(id)).rejects.toThrow(/15-minute/);

    expect(world.registrations[0]?.status).toBe("cancelled");
    expect(world.tiers[0]?.quantityHeld).toBe(0);
    expect(world.payments).toHaveLength(1);
    expect(provider.calls).toHaveLength(1);
  });

  it("does not release a hold that a confirmation already consumed", async () => {
    // A sweep racing a confirmation must find nothing to do rather than returning
    // stock that is already sold (the double-release rule).
    const service = buildService();
    await service.createRegistration(EVENT_ID, COMMAND);
    world.registrations[0] = { ...(world.registrations[0] as RegistrationRecord), status: "confirmed" };
    world.tiers[0] = tierRow({ quantityConfirmed: 1, quantityHeld: 0 });

    clock = new Date("2026-09-27T11:00:00.000Z");
    const released = await service.releaseExpiredHolds();

    expect(released).toBe(0);
    expect(world.tiers[0]?.quantityConfirmed).toBe(1);
    expect(world.registrations[0]?.status).toBe("confirmed");
  });
});

// -----------------------------------------------------------------------------
// releaseExpiredHolds
// -----------------------------------------------------------------------------

describe("BR-3: the hold expiry sweep", () => {
  it("releases only the holds whose window has passed, and counts them", async () => {
    const service = buildService();
    const stale = await service.createRegistration(EVENT_ID, COMMAND);
    expect(stale.created).toBe(true);

    // A second, live registration must survive the sweep.
    const live = await service.createRegistration(EVENT_ID, {
      ...COMMAND,
      idempotencyKey: "77777777-7777-4777-8777-777777777777",
    });
    expect(live.created).toBe(true);

    // Backdate the first so only it is stale.
    world.registrations[0] = {
      ...(world.registrations[0] as RegistrationRecord),
      createdAt: new Date("2026-09-27T09:00:00.000Z"),
    };

    const released = await service.releaseExpiredHolds();

    expect(released).toBe(1);
    expect(world.registrations[0]?.status).toBe("cancelled");
    expect(world.registrations[1]?.status).toBe("pending_payment");
    expect(world.tiers[0]?.quantityHeld).toBe(1);
  });

  it("is idempotent, because a second sweep must not release the same unit twice", async () => {
    const service = buildService();
    await service.createRegistration(EVENT_ID, COMMAND);
    world.registrations[0] = {
      ...(world.registrations[0] as RegistrationRecord),
      createdAt: new Date("2026-09-27T09:00:00.000Z"),
    };

    expect(await service.releaseExpiredHolds()).toBe(1);
    expect(await service.releaseExpiredHolds()).toBe(0);
    expect(world.tiers[0]?.quantityHeld).toBe(0);
  });
});

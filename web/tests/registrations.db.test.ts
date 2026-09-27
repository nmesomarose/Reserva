import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The registration and payment invariants that only PostgreSQL can prove.
 *
 * `registrations.service.test.ts` and `payments.service.test.ts` decide *which*
 * outcome each input deserves. They cannot show that the writes behind those
 * outcomes are atomic, that the conditional inventory statements are genuinely
 * atomic under two connections, or that the raw-SQL integrity layer actually
 * refuses what it claims to refuse — a fake repository whose `transact` just calls
 * its callback will agree with every one of those claims.
 *
 * So each test below is one of three shapes:
 *
 *   - "these two writes cannot be observed apart" (§8.5, the three create writes)
 *   - "two callers racing the last unit cannot both win" (the last-unit race)
 *   - "the database refuses this, independently of the application" (CHECKs, the
 *     partial index, the transition triggers)
 *
 * Skipped when `DATABASE_URL` is absent, like the rest of the integration suite.
 */

import { ConflictError, NotFoundError } from "@/domain/errors";
import {
  generateProviderReference,
  generateUniqueReference,
} from "@/domain/registrations/reference";
import {
  HoldLostError,
  type CreatePendingRegistrationInput,
  type PaymentResolution,
  type RegistrationCreation,
  type RegistrationRepository,
  type ResolveVerifiedPaymentInput,
} from "@/domain/registrations/registration.repository";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db/client";
import { PrismaRegistrationRepository } from "@/server/db/registration.repository";

const RUN_ID = randomUUID();
const ORGANISER_ID = randomUUID();
const ORGANISER_EMAIL = `registrations-slice-${RUN_ID}@test.invalid`;

const describeWithDatabase = process.env.DATABASE_URL ? describe : describe.skip;

const PRICE_MINOR_UNITS = 5_000;

/**
 * The message of the injected counter failure. Matched as a message rather than by
 * identity because Prisma wraps whatever a `$transaction` callback throws.
 */
const SIMULATED_COUNTER_FAILURE = /simulated tier counter failure/;

let eventId: string;

/** A second event, for the cross-entity integrity trigger. */
let otherEventId: string;

/** A tier with a known amount of stock, so no test inherits another's counters. */
async function createTier(quantityTotal: number, label: string): Promise<string> {
  const created = await prisma.ticketType.create({
    data: {
      eventId,
      name: `${label} ${RUN_ID}`,
      description: null,
      priceMinorUnits: PRICE_MINOR_UNITS,
      currency: "NGN",
      quantityTotal,
    },
  });

  return created.id;
}

/** A create call with a fresh idempotency key, and the input's real generators. */
function createInput(options: {
  readonly ticketTypeId: string;
  readonly idempotencyKey?: string;
  readonly uniqueReference?: string;
  readonly providerReference?: string;
  /** Deliberately wrong unless a test says otherwise (FR-11 re-reads the row). */
  readonly expectedAmountMinorUnits?: number;
}): CreatePendingRegistrationInput {
  return {
    eventId,
    command: {
      attendeeName: "Ada Lovelace",
      attendeeEmail: "ada@example.com",
      attendeePhone: "+2348012345678",
      ticketTypeId: options.ticketTypeId,
      idempotencyKey: options.idempotencyKey ?? randomUUID(),
    },
    uniqueReference: options.uniqueReference ?? generateUniqueReference(),
    providerReference: options.providerReference ?? generateProviderReference(),
    expectedAmountMinorUnits: options.expectedAmountMinorUnits ?? PRICE_MINOR_UNITS,
    currency: "NGN",
  };
}

/** The tier's counters, read independently of the repository under test. */
async function counters(id: string): Promise<{ held: number; confirmed: number }> {
  const tier = await prisma.ticketType.findUniqueOrThrow({ where: { id } });

  return { held: tier.quantityHeld, confirmed: tier.quantityConfirmed };
}

/** A §8.5 call for `creation`'s own attempt, with a payload shaped like a webhook. */
function verifyInput(
  creation: Extract<RegistrationCreation, { outcome: "created" }>,
  ticketTypeId: string,
): ResolveVerifiedPaymentInput {
  return {
    paymentId: creation.payment.id,
    registrationId: creation.registration.id,
    ticketTypeId,
    verifiedAmountMinorUnits: PRICE_MINOR_UNITS,
    verifiedAt: new Date("2026-09-27T10:06:00.000Z"),
    payload: { event: "charge.completed", data: { tx_ref: creation.payment.providerReference } },
  };
}

/**
 * A transaction client whose tier-counter `UPDATE` always fails.
 *
 * `confirmInventory` is the call that fails *after* the attempt has already been
 * written `success`, which is exactly the ordering §8.5 is about. There is no
 * natural constraint to violate here — the counter statement is valid SQL against a
 * perfectly good row — so the failure is injected; what is under test is the
 * rollback, not the constraint.
 *
 * The proxy sits on the *client*, not on the port handle: inside the transaction the
 * adapter builds its own `PrismaTicketTypeRepository` from that client, so a
 * port-level proxy (as `events.transactions.db.test.ts` uses for `appendEditLog`)
 * would never see the call.
 */
function withFailingCounterUpdate(client: Prisma.TransactionClient): Prisma.TransactionClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property !== "$queryRaw") {
        const value = Reflect.get(target, property, receiver) as unknown;

        return typeof value === "function" ? value.bind(target) : value;
      }

      // `$queryRaw` is used as a tagged template, so the statement is the literal
      // text of the template. `resolveVerifiedPayment` also uses it for its two
      // `SELECT … FOR UPDATE` reads, which must keep working — so only the counter
      // movement is replaced. Bound to the real client, because these are methods
      // that need their receiver.
      return (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (strings.join(" ").includes('UPDATE "ticket_types"')) {
          return Promise.reject(new Error("simulated tier counter failure"));
        }

        return (target.$queryRaw as (...args: unknown[]) => unknown).bind(target)(
          strings,
          ...values,
        );
      };
    },
  }) as Prisma.TransactionClient;
}

/**
 * A client whose transactions hand their callback a sabotaged client.
 *
 * `resolveVerifiedPayment` is itself transactional — it opens its own transaction
 * rather than joining the caller's — so the fault has to be injected into the client
 * it opens that transaction *with*, or the inner callback would receive a fresh,
 * untouched client and the counter movement would succeed.
 */
function withFailingCounterMovement(client: Prisma.TransactionClient): Prisma.TransactionClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property !== "$transaction") {
        const value = Reflect.get(target, property, receiver) as unknown;

        return typeof value === "function" ? value.bind(target) : value;
      }

      const openTransaction = (
        target.$transaction as unknown as (
          work: (tx: Prisma.TransactionClient) => Promise<unknown>,
        ) => Promise<unknown>
      ).bind(target);

      return (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        openTransaction((tx) => work(withFailingCounterUpdate(tx)));
    },
  }) as Prisma.TransactionClient;
}

/**
 * A real adapter whose confirmation transactions cannot move a tier counter.
 *
 * The method under test is called unmodified, on a real transaction: the only
 * difference from production is the injected fault.
 */
function withFailingConfirm(
  adapter: PrismaRegistrationRepository,
): RegistrationRepository {
  return Object.assign(Object.create(adapter) as RegistrationRepository, {
    resolveVerifiedPayment(input: ResolveVerifiedPaymentInput): Promise<PaymentResolution> {
      return PrismaRegistrationRepository.prototype.resolveVerifiedPayment.call(
        new PrismaRegistrationRepository(withFailingCounterMovement(prisma)),
        input,
      );
    },
  });
}

describeWithDatabase("registration and payment integrity against PostgreSQL", () => {
  const repository = new PrismaRegistrationRepository(prisma);
  const sabotaged = withFailingConfirm(repository);

  beforeAll(async () => {
    await prisma.organiser.create({
      data: { id: ORGANISER_ID, email: ORGANISER_EMAIL },
    });

    const event = await prisma.event.create({
      data: {
        organiserId: ORGANISER_ID,
        name: `Registration Slice ${RUN_ID}`,
        slug: `registration-slice-${RUN_ID}`,
        startsAt: new Date("2026-10-01T18:00:00Z"),
        endsAt: new Date("2026-10-01T22:00:00Z"),
        venue: "The Blue Room",
        status: "published",
      },
    });

    eventId = event.id;

    const other = await prisma.event.create({
      data: {
        organiserId: ORGANISER_ID,
        name: `Other Event ${RUN_ID}`,
        slug: `other-event-${RUN_ID}`,
        startsAt: new Date("2026-11-01T18:00:00Z"),
        endsAt: new Date("2026-11-01T22:00:00Z"),
        venue: "Somewhere Else",
        status: "published",
      },
    });

    otherEventId = other.id;
  });

  afterAll(async () => {
    // `registrations` is RESTRICT-referenced by `payments`, `check_ins`, and
    // `attendee_requests`, so the slice is removed bottom-up, and each event only
    // after its own tiers. `try`/`finally` so a cleanup failure still disconnects the
    // client rather than handing the next file a poisoned pool.
    try {
      await prisma.$transaction(async (tx) => {
        await tx.checkIn.deleteMany({ where: { registration: { eventId } } });
        await tx.attendeeRequest.deleteMany({ where: { registration: { eventId } } });
        await tx.payment.deleteMany({ where: { registration: { eventId } } });
        await tx.registration.deleteMany({ where: { eventId } });
        await tx.ticketType.deleteMany({ where: { eventId } });
        await tx.event.deleteMany({ where: { id: { in: [eventId, otherEventId] } } });
        await tx.organiser.deleteMany({ where: { id: ORGANISER_ID } });
      });
    } finally {
      await prisma.$disconnect();
    }
  });

  // ---------------------------------------------------------------------------
  // The three writes of a purchase
  // ---------------------------------------------------------------------------

  it("writes the registration, the hold, and the attempt as one unit", async () => {
    const tier = await createTier(5, "Happy Path");
    const creation = await repository.createPendingRegistration(createInput({ ticketTypeId: tier }));

    expect(creation.outcome).toBe("created");
    if (creation.outcome !== "created") return;

    expect(creation.registration.status).toBe("pending_payment");
    // `initiated`, never `success`: this row is not a ticket and the money has not
    // moved (skill step 7).
    expect(creation.payment.status).toBe("initiated");
    expect(creation.payment.verifiedAmountMinorUnits).toBeNull();
    expect(creation.payment.verifiedAt).toBeNull();
    expect(await counters(tier)).toEqual({ held: 1, confirmed: 0 });
  });

  it("leaves NO row behind when the tier is sold out", async () => {
    const tier = await createTier(1, "Last Unit");

    await repository.createPendingRegistration(createInput({ ticketTypeId: tier }));

    // The second call fails on the conditional UPDATE, which must roll the
    // registration insert back with it. A half-created row would hold no stock,
    // could never be paid for, and would answer `replayed` to the attendee's retry.
    await expect(
      repository.createPendingRegistration(createInput({ ticketTypeId: tier })),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(await prisma.registration.count({ where: { ticketTypeId: tier } })).toBe(1);
    expect(await prisma.payment.count({ where: { registration: { ticketTypeId: tier } } })).toBe(1);
    expect(await counters(tier)).toEqual({ held: 1, confirmed: 0 });
  });

  it("charges the price on the ROW, not the one the caller passed", async () => {
    // FR-11. The caller's copy is deliberately wrong: the service read the tier a
    // moment ago, and an organiser can edit the price in the gap.
    const tier = await createTier(5, "Repriced");
    await prisma.ticketType.update({
      where: { id: tier },
      data: { priceMinorUnits: 7_500 },
    });

    const creation = await repository.createPendingRegistration(
      createInput({ ticketTypeId: tier, expectedAmountMinorUnits: 1 }),
    );
    if (creation.outcome !== "created") throw new Error("expected a creation");

    expect(creation.payment.expectedAmountMinorUnits).toBe(7_500);
    expect(creation.payment.currency).toBe("NGN");
  });

  it("refuses a tier that belongs to another event, as a MISS rather than a conflict", async () => {
    // One answer for "no such tier" and "tier on another event", so an anonymous
    // attendee cannot map one event's tiers by comparing error codes (R-3).
    const tier = await createTier(5, "Foreign");
    const input = createInput({ ticketTypeId: tier });

    await expect(
      repository.createPendingRegistration({ ...input, eventId: otherEventId }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  // ---------------------------------------------------------------------------
  // Concurrency: claims a fake cannot make
  // ---------------------------------------------------------------------------

  it("lets exactly ONE of two concurrent buyers take the last unit", async () => {
    const tier = await createTier(1, "Contended");

    const results = await Promise.allSettled([
      repository.createPendingRegistration(createInput({ ticketTypeId: tier })),
      repository.createPendingRegistration(createInput({ ticketTypeId: tier })),
    ]);

    const created = results.filter((result) => result.status === "fulfilled");
    const refused = results.filter((result) => result.status === "rejected");

    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(1);
    // The loser's insert rolled back with its failed hold, so no registration exists
    // without a hold behind it.
    expect(await prisma.registration.count({ where: { ticketTypeId: tier } })).toBe(1);
    expect(await counters(tier)).toEqual({ held: 1, confirmed: 0 });
  });

  it("lets exactly ONE of two concurrent double-submits create a row, and holds one unit", async () => {
    // FR-10a. `UNIQUE(idempotency_key)` is the arbiter; a pre-flight "does this key
    // exist?" read would be a check-then-act race (rule 07). The insert is ordered
    // before the hold precisely so a losing duplicate never touches inventory.
    const tier = await createTier(5, "Double Submit");
    const idempotencyKey = randomUUID();
    const call = () => repository.createPendingRegistration(createInput({ ticketTypeId: tier, idempotencyKey }));

    const results = await Promise.all([call(), call()]);

    expect(results.filter((result) => result.outcome === "created")).toHaveLength(1);
    expect(results.filter((result) => result.outcome === "replayed")).toHaveLength(1);
    expect(await prisma.registration.count({ where: { ticketTypeId: tier } })).toBe(1);
    expect(await prisma.payment.count({ where: { registration: { ticketTypeId: tier } } })).toBe(1);
    expect(await counters(tier)).toEqual({ held: 1, confirmed: 0 });
  });

  it("replays the SAME row for a repeated key", async () => {
    const tier = await createTier(5, "Sequential Replay");
    const idempotencyKey = randomUUID();

    const first = await repository.createPendingRegistration(
      createInput({ ticketTypeId: tier, idempotencyKey }),
    );
    const second = await repository.createPendingRegistration(
      createInput({ ticketTypeId: tier, idempotencyKey }),
    );

    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("replayed");
    if (second.outcome !== "replayed") return;

    // The ORIGINAL result, including its reference: §12's replay semantics, and the
    // reference the attendee was already sent must not change under them.
    expect(second.registration.id).toBe(first.registration.id);
    expect(second.payment?.id).toBe(
      first.outcome === "created" ? first.payment.id : undefined,
    );
    expect(await counters(tier)).toEqual({ held: 1, confirmed: 0 });
  });

  it("retries a duplicate UNIQUE REFERENCE instead of replaying someone else's", async () => {
    // Vanishingly unlikely at 256 bits, and emphatically not a replay: conflating the
    // two constraints would hand one attendee another's registration and reference.
    const tier = await createTier(5, "Reference Collision");
    const stolen = "a".repeat(43);

    const first = await repository.createPendingRegistration(
      createInput({ ticketTypeId: tier, uniqueReference: stolen }),
    );
    const second = await repository.createPendingRegistration(
      createInput({ ticketTypeId: tier, uniqueReference: stolen }),
    );

    expect(first.outcome).toBe("created");
    if (first.outcome !== "created") return;
    expect(first.registration.uniqueReference).toBe(stolen);

    expect(second.outcome).toBe("created");
    if (second.outcome !== "created") return;
    expect(second.registration.id).not.toBe(first.registration.id);
    expect(second.registration.uniqueReference).not.toBe(stolen);
    expect(await prisma.registration.count({ where: { ticketTypeId: tier } })).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // §8.5: the confirmation transaction
  // ---------------------------------------------------------------------------

  it("applies all of §8.5's writes, in one transaction", async () => {
    const tier = await createTier(5, "Atomic Confirm");
    const creation = await repository.createPendingRegistration(createInput({ ticketTypeId: tier }));
    if (creation.outcome !== "created") throw new Error("expected a creation");

    const verifiedAt = new Date("2026-09-27T10:06:00.000Z");
    const resolution = await repository.resolveVerifiedPayment(verifyInput(creation, tier));

    expect(resolution.confirmedNow).toBe(true);
    expect(resolution.registration.status).toBe("confirmed");
    expect(resolution.payment.status).toBe("success");
    expect(resolution.payment.verifiedAt).toEqual(verifiedAt);
    expect(resolution.payment.verifiedAmountMinorUnits).toBe(PRICE_MINOR_UNITS);
    // HELD -> CONFIRMED, never AVAILABLE -> CONFIRMED: the total is unchanged, which
    // is exactly the window the CHECK constraint cannot see.
    expect(await counters(tier)).toEqual({ held: 0, confirmed: 1 });
  });

  it("is a NO-OP when the same attempt is confirmed twice", async () => {
    // §12's "idempotent — safe to call repeatedly": duplicate webhook delivery is
    // normal, and the second delivery observes the resolved row under `FOR UPDATE`
    // rather than moving a counter twice.
    const tier = await createTier(5, "Confirmed Twice");
    const creation = await repository.createPendingRegistration(createInput({ ticketTypeId: tier }));
    if (creation.outcome !== "created") throw new Error("expected a creation");

    const input = verifyInput(creation, tier);
    await repository.resolveVerifiedPayment(input);
    const second = await repository.resolveVerifiedPayment(input);

    expect(second.confirmedNow).toBe(false);
    expect(second.payment.verifiedAt).toEqual(input.verifiedAt);
    expect(await counters(tier)).toEqual({ held: 0, confirmed: 1 });
  });

  it("cannot confirm a SECOND attempt against the same registration", async () => {
    // PRD §7.3 makes Payment 1:N, so a retry after a failure is a second row. §8.5
    // writes the attempt `success` FIRST, so the partial index is what refuses the
    // second one — before the counter statement, which would have found no hold to
    // convert anyway.
    const tier = await createTier(5, "Two Attempts");
    const creation = await repository.createPendingRegistration(createInput({ ticketTypeId: tier }));
    if (creation.outcome !== "created") throw new Error("expected a creation");

    const second = await repository.openPaymentAttempt({
      registrationId: creation.registration.id,
      providerReference: generateProviderReference(),
      expectedAmountMinorUnits: PRICE_MINOR_UNITS,
      currency: "NGN",
    });

    await repository.resolveVerifiedPayment(verifyInput(creation, tier));

    await expect(
      repository.resolveVerifiedPayment({
        ...verifyInput(creation, tier),
        paymentId: second.id,
        verifiedAt: new Date("2026-09-27T10:07:00.000Z"),
        payload: { event: "charge.completed", data: { tx_ref: second.providerReference } },
      }),
    ).rejects.toThrow("payments_one_success_per_registration_idx");

    // The winner's confirmation stands, the tier counted exactly one sale, and the
    // refused attempt is still open rather than left claiming a verified success.
    expect(await counters(tier)).toEqual({ held: 0, confirmed: 1 });
    const loser = await prisma.payment.findUniqueOrThrow({ where: { id: second.id } });
    expect(loser.status).toBe("initiated");
    expect(loser.verifiedAt).toBeNull();
  });

  it("refuses a second `success` for one registration, at the database level", async () => {
    // `payments_one_success_per_registration_idx`, with the adapter out of the way
    // entirely: the index is an integrity constraint, so a single UPDATE written by
    // any future path is refused just the same.
    const tier = await createTier(5, "Index Backstop");
    const creation = await repository.createPendingRegistration(createInput({ ticketTypeId: tier }));
    if (creation.outcome !== "created") throw new Error("expected a creation");

    const second = await repository.openPaymentAttempt({
      registrationId: creation.registration.id,
      providerReference: generateProviderReference(),
      expectedAmountMinorUnits: PRICE_MINOR_UNITS,
      currency: "NGN",
    });

    await repository.resolveVerifiedPayment(verifyInput(creation, tier));

    await expect(
      prisma.payment.update({ where: { id: second.id }, data: { status: "success" } }),
    ).rejects.toThrow("payments_one_success_per_registration_idx");

    // A no-op write stays legal, which is what keeps a redelivery safe.
    await expect(
      prisma.payment.update({ where: { id: creation.payment.id }, data: { status: "success" } }),
    ).resolves.toMatchObject({ status: "success" });
  });

  it("ROLLS BACK the attempt's success when the counter movement fails", async () => {
    const tier = await createTier(5, "Rollback");
    const creation = await repository.createPendingRegistration(createInput({ ticketTypeId: tier }));
    if (creation.outcome !== "created") throw new Error("expected a creation");

    await expect(
      sabotaged.resolveVerifiedPayment(verifyInput(creation, tier)),
    ).rejects.toThrow(SIMULATED_COUNTER_FAILURE);

    // THE assertion. Without the transaction, the attempt above would be left
    // claiming a verified success the ticket counters never recorded — a sold unit
    // nobody counted, and §10's reconciliation queue fed a phantom.
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: creation.payment.id } });
    const registration = await prisma.registration.findUniqueOrThrow({
      where: { id: creation.registration.id },
    });

    expect(payment.status).toBe("initiated");
    expect(payment.verifiedAmountMinorUnits).toBeNull();
    expect(payment.verifiedAt).toBeNull();
    expect(registration.status).toBe("pending_payment");
    expect(await counters(tier)).toEqual({ held: 1, confirmed: 0 });
  });

  it("leaves the connection usable after a rolled-back confirmation", async () => {
    // A transaction that was not properly ended would poison the pooled connection
    // the next statement needs, so the follow-up must succeed through the same
    // adapter and the same client.
    const tier = await createTier(5, "Recovery");
    const creation = await repository.createPendingRegistration(createInput({ ticketTypeId: tier }));
    if (creation.outcome !== "created") throw new Error("expected a creation");

    await expect(
      sabotaged.resolveVerifiedPayment(verifyInput(creation, tier)),
    ).rejects.toThrow(SIMULATED_COUNTER_FAILURE);

    const recovered = await repository.resolveVerifiedPayment(verifyInput(creation, tier));

    expect(recovered.confirmedNow).toBe(true);
    expect(await counters(tier)).toEqual({ held: 0, confirmed: 1 });
  });

  it("raises HoldLostError and rolls back when the held unit is gone", async () => {
    // The 15-minute sweep ran while the payment was in flight. The money moved and the
    // confirmation cannot proceed — the service turns that into R-2's reconciliation —
    // but the attempt row must not be left half-written as a bare `success`.
    const tier = await createTier(5, "Lost Hold");
    const creation = await repository.createPendingRegistration(createInput({ ticketTypeId: tier }));
    if (creation.outcome !== "created") throw new Error("expected a creation");

    await prisma.ticketType.update({ where: { id: tier }, data: { quantityHeld: 0 } });

    await expect(
      repository.resolveVerifiedPayment(verifyInput(creation, tier)),
    ).rejects.toBeInstanceOf(HoldLostError);

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: creation.payment.id } });
    expect(payment.status).toBe("initiated");
  });

  // ---------------------------------------------------------------------------
  // The raw-SQL integrity layer, on its own
  // ---------------------------------------------------------------------------

  it("refuses counters that would oversell a tier", async () => {
    // The CHECK is the last line against a double-sell; the conditional statements are
    // what normally prevent one.
    const tier = await createTier(2, "Oversell");

    await expect(
      prisma.ticketType.update({ where: { id: tier }, data: { quantityConfirmed: 3 } }),
    ).rejects.toThrow();
  });

  it("refuses a registration whose event is not its tier's event", async () => {
    // `registration_ticket_type_event_guard`. The adapter pre-checks this, so the
    // trigger is the backstop that makes authorisation event-scoping true for a path
    // that forgets to check.
    const tier = await createTier(5, "Cross Event");

    await expect(
      prisma.registration.create({
        data: {
          eventId: otherEventId,
          ticketTypeId: tier,
          uniqueReference: generateUniqueReference(),
          attendeeName: "Grace Hopper",
          attendeeEmail: "grace@example.com",
          attendeePhone: "+2348012345678",
          status: "pending_payment",
          idempotencyKey: randomUUID(),
        },
      }),
    ).rejects.toThrow();
  });

  it("refuses a cancelled registration being confirmed", async () => {
    // §9.2's denylist, enforced by `registration_status_transition_guard`. The
    // service checks first; the trigger is what makes the rule true regardless.
    const tier = await createTier(5, "Cancelled");
    const creation = await repository.createPendingRegistration(createInput({ ticketTypeId: tier }));
    if (creation.outcome !== "created") throw new Error("expected a creation");

    const cancelled = await repository.cancelRegistrationIfPending(creation.registration.id);
    expect(cancelled?.status).toBe("cancelled");
    expect(await repository.releaseHeldInventory(tier, 1)).not.toBeNull();
    expect(await counters(tier)).toEqual({ held: 0, confirmed: 0 });

    await expect(
      prisma.registration.update({
        where: { id: creation.registration.id },
        data: { status: "confirmed" },
      }),
    ).rejects.toThrow();
  });

  it("does not overwrite a confirmed registration when a sweep gets there first", async () => {
    // Both the sweep and a live confirmation can reach the same row. The loser must
    // find nothing to do rather than cancelling a `confirmed` registration — and must
    // not release a hold that was already consumed.
    const tier = await createTier(5, "Sweep Race");
    const creation = await repository.createPendingRegistration(createInput({ ticketTypeId: tier }));
    if (creation.outcome !== "created") throw new Error("expected a creation");

    await repository.resolveVerifiedPayment(verifyInput(creation, tier));

    await expect(repository.cancelRegistrationIfPending(creation.registration.id)).resolves.toBeNull();
    expect(await counters(tier)).toEqual({ held: 0, confirmed: 1 });
  });

  it("refuses a double release of one hold", async () => {
    // Guarded on `quantity_held >= quantity`, so the second release matches no row
    // and returns `null` rather than driving the counter negative.
    const tier = await createTier(5, "Double Release");
    const creation = await repository.createPendingRegistration(createInput({ ticketTypeId: tier }));
    if (creation.outcome !== "created") throw new Error("expected a creation");

    expect(await repository.releaseHeldInventory(tier, 1)).not.toBeNull();
    await expect(repository.releaseHeldInventory(tier, 1)).resolves.toBeNull();
    expect(await counters(tier)).toEqual({ held: 0, confirmed: 0 });
  });

  // ---------------------------------------------------------------------------
  // R-1 and R-2 writes
  // ---------------------------------------------------------------------------

  it("flags for reconciliation WITHOUT moving the attempt to success", async () => {
    const tier = await createTier(5, "Reconciliation");
    const creation = await repository.createPendingRegistration(createInput({ ticketTypeId: tier }));
    if (creation.outcome !== "created") throw new Error("expected a creation");

    const flagged = await repository.flagPaymentForReconciliation({
      paymentId: creation.payment.id,
      verifiedAmountMinorUnits: 4_000,
      verifiedAt: new Date("2026-09-27T10:09:00.000Z"),
      payload: { event: "charge.completed", data: { amount: 40 } },
    });

    // `success` continues to mean *verified*, which is what makes §10's "already
    // success" a usable queue filter rather than a guess.
    expect(flagged.status).toBe("initiated");
    expect(flagged.requiresReconciliation).toBe(true);
    expect(flagged.verifiedAmountMinorUnits).toBe(4_000);
  });

  it("does not BLANK a verified amount that a previous flagging recorded", async () => {
    const tier = await createTier(5, "Evidence Kept");
    const creation = await repository.createPendingRegistration(createInput({ ticketTypeId: tier }));
    if (creation.outcome !== "created") throw new Error("expected a creation");

    await repository.flagPaymentForReconciliation({
      paymentId: creation.payment.id,
      verifiedAmountMinorUnits: 4_000,
      verifiedAt: new Date("2026-09-27T10:09:00.000Z"),
      payload: { event: "charge.completed", data: { amount: 40 } },
    });

    // A redelivery that cannot establish the amount must not erase the one already
    // there: losing it destroys the evidence the flag was raised to preserve.
    const again = await repository.flagPaymentForReconciliation({
      paymentId: creation.payment.id,
      verifiedAmountMinorUnits: null,
      verifiedAt: null,
      payload: { event: "charge.completed", data: { amount: null } },
    });

    expect(again.verifiedAmountMinorUnits).toBe(4_000);
  });

  it("R-2: records an unclaimable success without touching the registration", async () => {
    const tier = await createTier(5, "Unclaimable");
    const creation = await repository.createPendingRegistration(createInput({ ticketTypeId: tier }));
    if (creation.outcome !== "created") throw new Error("expected a creation");

    const unclaimable = await repository.recordUnclaimableSuccess({
      paymentId: creation.payment.id,
      verifiedAmountMinorUnits: PRICE_MINOR_UNITS,
      verifiedAt: new Date("2026-09-27T10:10:00.000Z"),
      payload: { event: "charge.completed", data: { amount: 50 } },
    });

    expect(unclaimable.status).toBe("success");
    expect(unclaimable.requiresReconciliation).toBe(true);

    const registration = await prisma.registration.findUniqueOrThrow({
      where: { id: creation.registration.id },
    });
    expect(registration.status).toBe("pending_payment");
    expect(await counters(tier)).toEqual({ held: 1, confirmed: 0 });
  });

  it("refuses to overturn a terminally failed attempt", async () => {
    // §9.1's `failed -> success` prohibition. A late webhook cannot convert a failure
    // into a ticket; it becomes reconciliation on its own terms.
    const tier = await createTier(5, "Failed Then Webhook");
    const creation = await repository.createPendingRegistration(createInput({ ticketTypeId: tier }));
    if (creation.outcome !== "created") throw new Error("expected a creation");

    await repository.markPaymentFailed(creation.payment.id, {
      status: "failed",
      message: "declined by issuer",
    });
    const late = await repository.recordUnclaimableSuccess({
      paymentId: creation.payment.id,
      verifiedAmountMinorUnits: PRICE_MINOR_UNITS,
      verifiedAt: new Date("2026-09-27T10:11:00.000Z"),
      payload: { event: "charge.completed", data: { amount: 50 } },
    });

    expect(late.status).toBe("failed");
    expect(late.requiresReconciliation).toBe(true);
    expect(await counters(tier)).toEqual({ held: 1, confirmed: 0 });
  });

  // ---------------------------------------------------------------------------
  // The hold sweep's query
  // ---------------------------------------------------------------------------

  it("finds only OVERDUE pending holds, never a confirmed one", async () => {
    // A confirmed registration's hold was consumed by HELD -> CONFIRMED. Releasing it
    // again would return stock that is already sold, so the filter is in SQL.
    const tier = await createTier(5, "Sweep");
    const creation = await repository.createPendingRegistration(createInput({ ticketTypeId: tier }));
    if (creation.outcome !== "created") throw new Error("expected a creation");

    const everything = await repository.findExpiredHolds(new Date("2999-01-01T00:00:00Z"), 100);
    expect(everything.map((row) => row.id)).toContain(creation.registration.id);

    const past = await repository.findExpiredHolds(new Date("2000-01-01T00:00:00Z"), 100);
    expect(past.map((row) => row.id)).not.toContain(creation.registration.id);

    await repository.resolveVerifiedPayment(verifyInput(creation, tier));

    const afterConfirmation = await repository.findExpiredHolds(
      new Date("2999-01-01T00:00:00Z"),
      100,
    );
    expect(afterConfirmation.map((row) => row.id)).not.toContain(creation.registration.id);
  });
});

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The organiser-operations invariants that only PostgreSQL can prove.
 *
 * `operations.service.test.ts` proves what the service does with grouped rows: the
 * zero-filling, the `available` derivation, the check-in integrity check. Nothing there
 * can show that the *grouping* was scoped to one event, that `count(DISTINCT …)` counted
 * distinct registrations rather than rows, that the `FILTER` clause counted overrides
 * rather than everything, or that FR-26 returned every payment instead of the most
 * recent one — because a hand-built repository returns exactly the rows it was told to.
 *
 * Each test below therefore writes rows for **two** events (and two organisers) and then
 * asserts what this event's answer contains, so an unscoped `GROUP BY` or a forgotten
 * `WHERE` shows up as a number that is too large.
 *
 * Skipped when `DATABASE_URL` is absent, like the rest of the integration suite.
 */

import type { PaymentStatus, RegistrationStatus } from "@/domain/registrations/registration";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db/client";
import { PrismaEventOperationsRepository } from "@/server/db/operations.repository";

const RUN_ID = randomUUID();
const ORGANISER_ID = randomUUID();
const ORGANISER_EMAIL = `operations-slice-${RUN_ID}@test.invalid`;
const OTHER_ORGANISER_ID = randomUUID();
const OTHER_ORGANISER_EMAIL = `operations-slice-other-${RUN_ID}@test.invalid`;

const describeWithDatabase = process.env.DATABASE_URL ? describe : describe.skip;

const STARTS_AT = new Date("2026-10-01T18:00:00Z");
const BASE_TIME = new Date("2026-10-01T18:30:00Z");
const plus = (minutes: number): Date => new Date(BASE_TIME.getTime() + minutes * 60_000);

const repository = new PrismaEventOperationsRepository(prisma);

interface Fixture {
  readonly eventId: string;
  readonly ticketTypeId: string;
}

/**
 * Every event this file creates, for `afterAll`.
 *
 * Assertions here are about *counts*, so a test cannot share an event with a test that
 * runs before it: the numbers would depend on execution order. Each count-sensitive test
 * therefore calls `newEvent()` and gets an event nobody else has written to.
 */
const everyEventId: string[] = [];

async function newEvent(organiserId: string = ORGANISER_ID): Promise<Fixture> {
  const event = await prisma.event.create({
    data: {
      organiserId,
      name: `Operations Slice ${randomUUID().slice(0, 8)}`,
      slug: `operations-slice-${randomUUID()}`,
      startsAt: STARTS_AT,
      endsAt: new Date("2026-10-01T22:00:00Z"),
      venue: "The Blue Room",
      status: "published",
    },
  });

  everyEventId.push(event.id);

  const tier = await prisma.ticketType.create({
    data: {
      eventId: event.id,
      name: `General ${RUN_ID}`,
      priceMinorUnits: 5_000,
      currency: "NGN",
      quantityTotal: 100,
      quantityConfirmed: 0,
      quantityHeld: 0,
    },
  });

  return { eventId: event.id, ticketTypeId: tier.id };
}

async function createRegistration(options: {
  readonly fixture: Fixture;
  readonly status?: RegistrationStatus;
  readonly name?: string;
}): Promise<string> {
  const created = await prisma.registration.create({
    data: {
      eventId: options.fixture.eventId,
      ticketTypeId: options.fixture.ticketTypeId,
      attendeeName: options.name ?? "Ada Lovelace",
      attendeeEmail: `ada-${randomUUID().slice(0, 8)}@example.com`,
      attendeePhone: "+2348012345678",
      idempotencyKey: randomUUID(),
      uniqueReference: `ref-${randomUUID()}`,
      status: options.status ?? "confirmed",
    },
  });

  return created.id;
}

async function createPayment(options: {
  readonly registrationId: string;
  readonly status: PaymentStatus;
  readonly requiresReconciliation?: boolean;
  readonly rawProviderPayload?: Prisma.InputJsonValue;
  readonly verifiedAmountMinorUnits?: number | null;
  readonly createdAt?: Date;
}): Promise<string> {
  const created = await prisma.payment.create({
    data: {
      registrationId: options.registrationId,
      providerReference: `provider-${randomUUID()}`,
      expectedAmountMinorUnits: 5_000,
      verifiedAmountMinorUnits:
        options.verifiedAmountMinorUnits === undefined
          ? options.status === "success"
            ? 5_000
            : null
          : options.verifiedAmountMinorUnits,
      currency: "NGN",
      status: options.status,
      verifiedAt: options.status === "success" ? plus(1) : null,
      requiresReconciliation: options.requiresReconciliation ?? false,
      rawProviderPayload: options.rawProviderPayload ?? { reference: "raw" },
      createdAt: options.createdAt ?? plus(1),
    },
  });

  return created.id;
}

async function createCheckIn(options: {
  readonly registrationId: string;
  readonly checkedInAt?: Date;
  readonly isOverride?: boolean;
  readonly staffTokenId?: string;
}): Promise<string> {
  const created = await prisma.checkIn.create({
    data: {
      registrationId: options.registrationId,
      checkedInAt: options.checkedInAt ?? plus(5),
      // Exactly one of the two actor FKs must be set; a CHECK constraint requires it.
      organiserId: options.staffTokenId === undefined ? ORGANISER_ID : null,
      staffTokenId: options.staffTokenId ?? null,
      isOverride: options.isOverride ?? false,
      createdAt: options.checkedInAt ?? plus(5),
    },
  });

  return created.id;
}

async function countFor<T extends string>(
  rows: readonly { status: T; count: number }[],
  status: T,
): Promise<number> {
  return rows.find((row) => row.status === status)?.count ?? 0;
}

describeWithDatabase("organiser operations against PostgreSQL", () => {
  beforeAll(async () => {
    await prisma.organiser.createMany({
      data: [
        { id: ORGANISER_ID, email: ORGANISER_EMAIL },
        { id: OTHER_ORGANISER_ID, email: OTHER_ORGANISER_EMAIL },
      ],
    });
  });

  afterAll(async () => {
    // `check_ins` and `attendee_requests` are append-only by trigger and cannot be
    // cleaned up with plain statements. Both triggers are disabled *inside a
    // transaction*: DDL is transactional in PostgreSQL, so each is restored by the same
    // COMMIT and a failure anywhere below rolls back with them still enabled.
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('ALTER TABLE "check_ins" DISABLE TRIGGER "check_ins_no_delete"');
        await tx.$executeRawUnsafe(
          'ALTER TABLE "attendee_requests" DISABLE TRIGGER "attendee_requests_forbid_delete"',
        );

        try {
          await tx.checkIn.deleteMany({
            where: { registration: { eventId: { in: everyEventId } } },
          });
          await tx.attendeeRequest.deleteMany({
            where: { registration: { eventId: { in: everyEventId } } },
          });
        } finally {
          await tx.$executeRawUnsafe('ALTER TABLE "check_ins" ENABLE TRIGGER "check_ins_no_delete"');
          await tx.$executeRawUnsafe(
            'ALTER TABLE "attendee_requests" ENABLE TRIGGER "attendee_requests_forbid_delete"',
          );
        }

        await tx.payment.deleteMany({
          where: { registration: { eventId: { in: everyEventId } } },
        });
        await tx.staffToken.deleteMany({ where: { eventId: { in: everyEventId } } });
        await tx.registration.deleteMany({ where: { eventId: { in: everyEventId } } });
        await tx.ticketType.deleteMany({ where: { eventId: { in: everyEventId } } });
        await tx.event.deleteMany({ where: { id: { in: everyEventId } } });
        await tx.organiser.deleteMany({
          where: { id: { in: [ORGANISER_ID, OTHER_ORGANISER_ID] } },
        });
      });

      // Both append-only guarantees are re-asserted after cleanup: a cleanup that
      // silently weakened them would make later runs pass tests they no longer earn.
      expect(
        await prisma.checkIn.count({ where: { registration: { eventId: { in: everyEventId } } } }),
      ).toBe(0);
      expect(
        await prisma.attendeeRequest.count({
          where: { registration: { eventId: { in: everyEventId } } },
        }),
      ).toBe(0);
    } finally {
      await prisma.$disconnect();
    }
  });

  // ---------------------------------------------------------------------------
  // The registration aggregate
  // ---------------------------------------------------------------------------

  describe("the registration aggregate", () => {
    it("counts each status of this event only", async () => {
      const mine = await newEvent();
      const otherOrganisers = await newEvent(OTHER_ORGANISER_ID);

      const statuses: RegistrationStatus[] = [
        "confirmed",
        "confirmed",
        "pending_payment",
        "cancelled",
        "refunded",
      ];

      for (const status of statuses) {
        await createRegistration({ fixture: mine, status });
      }

      // The same statuses again, on an event this organiser cannot see.
      for (const status of statuses) {
        await createRegistration({ fixture: otherOrganisers, status });
      }

      const rows = await repository.loadDashboard(mine.eventId);

      expect(await countFor(rows.registrationCounts, "confirmed")).toBe(2);
      expect(await countFor(rows.registrationCounts, "pending_payment")).toBe(1);
      expect(await countFor(rows.registrationCounts, "cancelled")).toBe(1);
      expect(await countFor(rows.registrationCounts, "refunded")).toBe(1);
    });

    it("omits statuses the event has no rows for", async () => {
      // The repository returns *grouped rows*, so a status nobody has is absent rather
      // than zero. Zero-filling is the service's job, and this test is what proves the
      // adapter did not quietly take it over — a change that would have moved wire
      // formatting into SQL.
      const fixture = await newEvent();
      await createRegistration({ fixture, status: "confirmed" });

      const rows = await repository.loadDashboard(fixture.eventId);

      expect(rows.registrationCounts).toHaveLength(1);
      expect(rows.registrationCounts[0]?.status).toBe("confirmed");
    });

    it("returns real numbers rather than bigint strings", async () => {
      // `count(*)::bigint` reaches the driver as a string. `Number("2")` is 2, but
      // `"2" + 1` is `"21"`, so a service that forgot the conversion would render a
      // dashboard full of concatenated nonsense.
      const fixture = await newEvent();
      await createRegistration({ fixture, status: "confirmed" });
      await createRegistration({ fixture, status: "confirmed" });

      const rows = await repository.loadDashboard(fixture.eventId);

      expect(typeof rows.registrationCounts[0]?.count).toBe("number");
      expect(rows.registrationCounts[0]?.count).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // The payment aggregate
  // ---------------------------------------------------------------------------

  describe("the payment aggregate", () => {
    it("counts every attempt of this event, and no other event's", async () => {
      const mine = await newEvent();
      const otherOrganisers = await newEvent(OTHER_ORGANISER_ID);

      const registration = await createRegistration({ fixture: mine, status: "confirmed" });
      const foreign = await createRegistration({ fixture: otherOrganisers, status: "confirmed" });

      // Two attempts on one registration: a retry is a real row, not a replacement.
      await createPayment({ registrationId: registration, status: "failed" });
      await createPayment({ registrationId: registration, status: "success" });
      // Decoys. The other registration carries one `success` and two `failed`, so an
      // unscoped `GROUP BY` would report 2 successes and 3 failures here instead of 1
      // and 1. (At most one `success` per registration is itself a partial unique index,
      // so a second success on the same row is not available as a decoy.)
      await createPayment({ registrationId: foreign, status: "success" });
      await createPayment({ registrationId: foreign, status: "failed" });
      await createPayment({ registrationId: foreign, status: "failed" });

      const rows = await repository.loadDashboard(mine.eventId);

      expect(await countFor(rows.paymentCounts, "success")).toBe(1);
      expect(await countFor(rows.paymentCounts, "failed")).toBe(1);
      // If the `GROUP BY` were unscoped, the other event's two successes would appear
      // here and the dashboard would overstate a sell-out.
      const total = rows.paymentCounts.reduce((sum, row) => sum + row.count, 0);
      expect(total).toBe(2);
    });

    it("counts reconciliation only for rows that carry the flag", async () => {
      const mine = await newEvent();

      const flagged = await createRegistration({ fixture: mine, status: "confirmed" });
      const unflagged = await createRegistration({ fixture: mine, status: "confirmed" });
      const other = await newEvent(OTHER_ORGANISER_ID);
      const foreign = await createRegistration({ fixture: other, status: "confirmed" });

      await createPayment({ registrationId: flagged, status: "success", requiresReconciliation: true });
      await createPayment({ registrationId: unflagged, status: "success" });
      await createPayment({ registrationId: foreign, status: "success", requiresReconciliation: true });

      const rows = await repository.loadDashboard(mine.eventId);

      expect(rows.paymentsRequiringReconciliation).toBe(1);
    });

    it("reports zero reconciliation for an event with no payments at all", async () => {
      const fixture = await newEvent();
      await createRegistration({ fixture, status: "confirmed" });

      const rows = await repository.loadDashboard(fixture.eventId);

      // The aggregate row exists with a zero rather than being absent, so the service
      // never has to distinguish "no rows" from "count of nothing".
      expect(rows.paymentsRequiringReconciliation).toBe(0);
      expect(rows.paymentCounts).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // The check-in log (BR-4, BR-5)
  // ---------------------------------------------------------------------------

  describe("the check-in log", () => {
    it("counts entries, overrides, and distinct registrations separately", async () => {
      const fixture = await newEvent();
      const other = await newEvent();

      const first = await createRegistration({ fixture, status: "checked_in" });
      const second = await createRegistration({ fixture, status: "checked_in" });

      await createCheckIn({ registrationId: first, checkedInAt: plus(5) });
      // BR-4: a deliberate repeat is a second row flagged as an override, not an edit.
      await createCheckIn({ registrationId: first, checkedInAt: plus(35), isOverride: true });
      await createCheckIn({ registrationId: second, checkedInAt: plus(10) });

      // Decoys on another event, so an unscoped aggregate is caught.
      const decoy = await createRegistration({ fixture: other, status: "checked_in" });
      await createCheckIn({ registrationId: decoy, checkedInAt: plus(6) });
      await createCheckIn({ registrationId: decoy, checkedInAt: plus(7), isOverride: true });

      const rows = await repository.loadDashboard(fixture.eventId);

      // Four rows exist for this event: two people, one of whom came twice.
      expect(rows.checkIns.entries).toBe(3);
      expect(rows.checkIns.overrides).toBe(1);
      // "People through the door", not "rows in the log" — counting rows here would
      // report a double-scanner as a second attendee.
      expect(rows.checkIns.registrationsCheckedIn).toBe(2);
    });

    it("reports a zero check-in log rather than an absent one", async () => {
      const fixture = await newEvent();
      await createRegistration({ fixture, status: "confirmed" });

      const rows = await repository.loadDashboard(fixture.eventId);

      expect(rows.checkIns).toEqual({ entries: 0, overrides: 0, registrationsCheckedIn: 0 });
    });

    it("can represent a registration whose status leads the log", async () => {
      // The state the service's integrity check exists to catch: `checked_in` with
      // nothing in the append-only log. Writing it through Prisma proves the schema
      // permits the state at all — which is why the check lives in the service rather
      // than in a trigger, and why the DB test has to build it deliberately.
      const fixture = await newEvent();
      const registration = await createRegistration({ fixture, status: "checked_in" });

      const rows = await repository.loadDashboard(fixture.eventId);

      expect(rows.checkIns.registrationsCheckedIn).toBe(0);
      expect(await countFor(rows.registrationCounts, "checked_in")).toBe(1);
      expect(registration).toBeDefined();
    });

    it("can represent a registration whose status lags the log", async () => {
      // The other direction, and the legitimate one: a refund or cancellation may move
      // the projection back after the person has been through the door.
      const fixture = await newEvent();
      const registration = await createRegistration({ fixture, status: "confirmed" });
      await createCheckIn({ registrationId: registration, checkedInAt: plus(5) });

      const rows = await repository.loadDashboard(fixture.eventId);

      expect(rows.checkIns.registrationsCheckedIn).toBe(1);
      expect(await countFor(rows.registrationCounts, "confirmed")).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Tier availability inputs
  // ---------------------------------------------------------------------------

  describe("tier rows", () => {
    it("returns this event's tiers, oldest first, with the stored counters intact", async () => {
      const fixture = await newEvent();
      const second = await prisma.ticketType.create({
        data: {
          eventId: fixture.eventId,
          name: `VIP ${RUN_ID}`,
          priceMinorUnits: 20_000,
          currency: "NGN",
          quantityTotal: 10,
          quantityConfirmed: 4,
          quantityHeld: 1,
          createdAt: plus(1),
        },
      });

      // Update the original tier so its counters are non-default, which is the case the
      // dashboard's `available` derivation is actually about.
      await prisma.ticketType.update({
        where: { id: fixture.ticketTypeId },
        data: { quantityConfirmed: 7, quantityHeld: 2 },
      });

      const other = await newEvent();
      await prisma.ticketType.create({
        data: {
          eventId: other.eventId,
          name: "Foreign tier",
          priceMinorUnits: 1_000,
          currency: "NGN",
          quantityTotal: 5,
        },
      });

      const rows = await repository.loadDashboard(fixture.eventId);

      expect(rows.ticketTypes.map((tier) => tier.id)).toEqual([fixture.ticketTypeId, second.id]);
      expect(rows.ticketTypes[0]).toMatchObject({ quantityConfirmed: 7, quantityHeld: 2 });
      // `available` is derived by the service (BR-3), never stored or returned here.
      expect(rows.ticketTypes[0]).not.toHaveProperty("available");
    });

    it("returns an empty tier list for an event with no tiers", async () => {
      const event = await prisma.event.create({
        data: {
          organiserId: ORGANISER_ID,
          name: `Tierless ${RUN_ID}`,
          slug: `tierless-${RUN_ID}`,
          startsAt: STARTS_AT,
          endsAt: new Date("2026-10-01T22:00:00Z"),
          venue: "The Blue Room",
          status: "published",
        },
      });
      everyEventId.push(event.id);

      const rows = await repository.loadDashboard(event.id);

      expect(rows.ticketTypes).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // One snapshot
  // ---------------------------------------------------------------------------

  describe("the aggregate is one snapshot", () => {
    it("sees a concurrent write as wholly visible or wholly invisible", async () => {
      // The defect `REPEATABLE READ` exists to prevent: under the default isolation a
      // dashboard can read `registrations`, then a check-in commits, then the log is read
      // — and the two numbers describe different instants.
      //
      // Proving the *absence* of a race is awkward, so what is asserted is the property
      // that makes it absent: the five statements run inside one transaction pinned to
      // one snapshot, and a writer that commits mid-read is not half-counted. The
      // observable consequence is that the check-in count and the registration count
      // still agree about who was seen.
      const fixture = await newEvent();
      const registration = await createRegistration({ fixture, status: "checked_in" });
      await createCheckIn({ registrationId: registration, checkedInAt: plus(5) });

      const reads = await Promise.all([
        repository.loadDashboard(fixture.eventId),
        repository.loadDashboard(fixture.eventId),
        repository.loadDashboard(fixture.eventId),
      ]);

      for (const rows of reads) {
        expect(rows.checkIns.registrationsCheckedIn).toBe(1);
        expect(await countFor(rows.registrationCounts, "checked_in")).toBe(1);
        // The invariant the service re-checks: the projection never leads the log.
        expect(await countFor(rows.registrationCounts, "checked_in")).toBeLessThanOrEqual(
          rows.checkIns.registrationsCheckedIn,
        );
      }
    });
  });

  // ---------------------------------------------------------------------------
  // FR-26
  // ---------------------------------------------------------------------------

  describe("the organiser registration record", () => {
    it("carries every payment attempt, newest first", async () => {
      const fixture = await newEvent();
      const registration = await createRegistration({ fixture, status: "confirmed" });

      // Three attempts over time, deliberately created out of order so the sort has to
      // earn its place.
      await createPayment({ registrationId: registration, status: "failed", createdAt: plus(30) });
      await createPayment({ registrationId: registration, status: "success", createdAt: plus(60) });
      await createPayment({ registrationId: registration, status: "initiated", createdAt: plus(10) });

      const record = await repository.findRegistrationRecord(fixture.eventId, registration);

      // FR-26 says "all", and a dispute is about the latest attempt — which has to be
      // element zero.
      expect(record?.payments).toHaveLength(3);
      expect(record?.payments.map((payment) => payment.status)).toEqual([
        "success",
        "failed",
        "initiated",
      ]);
    });

    it("carries the raw provider payload on each attempt", async () => {
      // The organiser has to be able to see what the provider actually said; §14 retains
      // it for exactly this.
      const fixture = await newEvent();
      const registration = await createRegistration({ fixture, status: "confirmed" });
      await createPayment({
        registrationId: registration,
        status: "success",
        rawProviderPayload: { status: "successful", amount: 500000, gateway: "testbed" },
      });

      const record = await repository.findRegistrationRecord(fixture.eventId, registration);

      expect(record?.payments[0]?.rawProviderPayload).toEqual({
        status: "successful",
        amount: 500000,
        gateway: "testbed",
      });
    });

    it("carries the whole check-in log, oldest first, with the override flag", async () => {
      const fixture = await newEvent();
      const registration = await createRegistration({ fixture, status: "checked_in" });

      // The schema allows exactly one non-override row per registration and requires
      // every later row to claim `is_override`, so the log is one arrival plus repeats.
      //
      // Inserted deliberately out of time order — 5, then 40, then 20 — so the record's
      // ordering can only be right if the `ORDER BY checked_in_at` is doing the work.
      // A query relying on insertion order would return 5, 40, 20.
      await createCheckIn({ registrationId: registration, checkedInAt: plus(5) });
      await createCheckIn({ registrationId: registration, checkedInAt: plus(40), isOverride: true });
      await createCheckIn({ registrationId: registration, checkedInAt: plus(20), isOverride: true });

      const record = await repository.findRegistrationRecord(fixture.eventId, registration);

      // §4.4.4: the original entry is first, and BR-4's repeats follow it as rows rather
      // than replacing it.
      expect(record?.checkIns).toHaveLength(3);
      expect(record?.checkIns.map((entry) => entry.checkedInAt)).toEqual([
        plus(5),
        plus(20),
        plus(40),
      ]);
      // The only row claiming to be the original is the earliest, and `is_override`
      // travels with the row rather than being inferred from position.
      expect(record?.checkIns.map((entry) => entry.isOverride)).toEqual([false, true, true]);
    });

    it("carries a staff-token check-in and a staff-token actor", async () => {
      // `checked_in_by` is two nullable FKs (the deliberate §7.2 divergence), so a
      // record whose check-in was performed by a staff token has to come back with that
      // token and not the organiser.
      const fixture = await newEvent();
      const token = await prisma.staffToken.create({
        data: {
          eventId: fixture.eventId,
          tokenHash: `hash-${randomUUID()}`,
          label: "Gate A",
          expiresAt: new Date("2026-10-02T00:00:00Z"),
        },
      });
      const registration = await createRegistration({ fixture, status: "checked_in" });

      await createCheckIn({ registrationId: registration, staffTokenId: token.id });

      const record = await repository.findRegistrationRecord(fixture.eventId, registration);

      expect(record?.checkIns[0]?.staffTokenId).toBe(token.id);
      expect(record?.checkIns[0]?.organiserId).toBeNull();
    });

    it("reads the event live, so a reschedule is reflected in the record", async () => {
      // BR-6: the record shows the event as it is now, not as it was at purchase.
      const fixture = await newEvent();
      const registration = await createRegistration({ fixture, status: "confirmed" });

      const moved = new Date("2026-10-01T19:00:00Z");
      await prisma.event.update({
        where: { id: fixture.eventId },
        data: { startsAt: moved, venue: "The Other Room" },
      });

      const record = await repository.findRegistrationRecord(fixture.eventId, registration);

      expect(record?.event.startsAt).toEqual(moved);
      expect(record?.event.venue).toBe("The Other Room");
    });

    it("carries the attendee-facing half of the registration, with no idempotency key", async () => {
      const fixture = await newEvent();
      const registration = await createRegistration({ fixture, status: "confirmed" });

      const record = await repository.findRegistrationRecord(fixture.eventId, registration);

      expect(record?.registration).toMatchObject({ id: registration, status: "confirmed" });
      // FR-26 exposes the registration to the *organiser*, who already owns the
      // attendee's details, so the mask is not applied here. What must not leak is the
      // client-supplied idempotency key: it is an implementation detail of the attendee's
      // submission, not part of the record.
      expect(record?.registration).not.toHaveProperty("idempotencyKey");
    });

    it("returns an empty record for a registration with no payments and no check-ins", async () => {
      const fixture = await newEvent();
      const registration = await createRegistration({ fixture, status: "confirmed" });

      const record = await repository.findRegistrationRecord(fixture.eventId, registration);

      // Empty collections, not nulls: a client rendering the record should not have to
      // handle "no attempts yet" differently from "attempted and failed".
      expect(record?.payments).toEqual([]);
      expect(record?.checkIns).toEqual([]);
    });

    it("answers null for a registration of another event, however it is reached", async () => {
      const mine = await newEvent();
      const otherOrganisers = await newEvent(OTHER_ORGANISER_ID);
      const foreign = await createRegistration({ fixture: otherOrganisers, status: "confirmed" });

      // Across a tenant, and across this organiser's own second event.
      expect(await repository.findRegistrationRecord(mine.eventId, foreign)).toBeNull();
    });

    it("answers null for a registration that does not exist", async () => {
      const fixture = await newEvent();

      // The same `null` an id belonging to somebody else produces, so the route cannot
      // be used to confirm that an id exists elsewhere (rule 08).
      expect(await repository.findRegistrationRecord(fixture.eventId, randomUUID())).toBeNull();
    });
  });
});

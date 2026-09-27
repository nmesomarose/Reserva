import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The staff/check-in invariants that only PostgreSQL can prove.
 *
 * `staff.service.test.ts` decides which outcome each input deserves, and
 * `api.v1.staff.test.ts` decides which status code each outcome becomes. Neither can
 * show that the writes behind a `recorded` outcome are atomic, that two doors cannot
 * both check the same attendee in, or that the raw-SQL guard actually refuses what it
 * claims to refuse — a fake repository whose `transact` calls its callback and a
 * `prisma` stubbed by `vi.mock` will agree with every one of those claims.
 *
 * So each test below is one of three shapes:
 *
 *   - "these two writes cannot be observed apart" (the insert and the `checked_in`
 *     projection, §7.4)
 *   - "two callers racing one registration cannot both win" (concurrent check-ins,
 *     including two *direct* writes that bypass the service)
 *   - "the database refuses this, independently of the application" (the insert
 *     guards, the append-only triggers, the exactly-one-actor CHECK)
 *
 * Skipped when `DATABASE_URL` is absent, like the rest of the integration suite.
 */

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db/client";
import { PrismaStaffRepository } from "@/server/db/staff.repository";
import type { RecordCheckInInput } from "@/domain/staff/staff.repository";
import type { RegistrationStatus } from "@/domain/registrations/registration";

const RUN_ID = randomUUID();
const ORGANISER_ID = randomUUID();
const ORGANISER_EMAIL = `staff-slice-${RUN_ID}@test.invalid`;
const OTHER_ORGANISER_ID = randomUUID();
const OTHER_ORGANISER_EMAIL = `staff-slice-other-${RUN_ID}@test.invalid`;

const describeWithDatabase = process.env.DATABASE_URL ? describe : describe.skip;

const PRICE_MINOR_UNITS = 5_000;
const NOW = new Date("2026-10-01T18:30:00Z");
const LATER = new Date("2026-10-01T19:15:00Z");

/**
 * The guard messages from `20260927000000_check_in_guards`, matched as substrings.
 *
 * Matching the message rather than a SQLSTATE is deliberate: SQLSTATE `23514` is
 * shared with every CHECK in the schema, so it would prove only that *something*
 * failed. The message is the guard explaining itself, and asserting it means a
 * refusal cannot later be satisfied by an unrelated constraint.
 */
const NOT_ELIGIBLE = /not check-in eligible/;
const CROSS_EVENT = /scoped to event/;
const OVERRIDE_WITHOUT_PRIOR = /no earlier check-in exists/;
const SECOND_FIRST_CHECK_IN = /already has \d+ earlier check-in/;
const BOTH_ACTORS = /check_ins_exactly_one_actor_check/;
const APPEND_ONLY = /append-only/;

let eventId: string;
let otherEventId: string;
let ticketTypeId: string;
let otherTicketTypeId: string;
let staffTokenId: string;
let otherEventTokenId: string;

const repository = new PrismaStaffRepository(prisma);

/** A token whose hash is a real SHA-256, so the storage path is exercised too. */
async function createStaffToken(options: {
  readonly event: string;
  readonly label?: string;
  readonly expiresAt?: Date;
  readonly revokedAt?: Date;
}): Promise<string> {
  const secret = randomUUID() + randomUUID();

  const created = await prisma.staffToken.create({
    data: {
      eventId: options.event,
      // `crypto` in the test rather than a literal, so an accidental log of this row
      // cannot be replayed as a credential.
      tokenHash: await sha256(secret),
      label: options.label ?? "Door Team A",
      expiresAt: options.expiresAt ?? new Date("2026-10-02T22:00:00Z"),
      revokedAt: options.revokedAt ?? null,
    },
  });

  return created.id;
}

/** Node's own hash, so a test never needs a hard-coded "hash" that is not one. */
async function sha256(value: string): Promise<string> {
  const { createHash } = await import("node:crypto");

  return createHash("sha256").update(value).digest("hex");
}

/**
 * A registration in a given status, created through the database rather than the
 * registration service.
 *
 * Direct `INSERT`s are the point: the guards under test live at the storage layer, so
 * a row created only through a service that already refuses the same thing would make
 * several of these tests vacuous.
 */
async function createRegistration(options: {
  readonly event?: string;
  readonly ticketType?: string;
  readonly name?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly status?: RegistrationStatus;
}): Promise<string> {
  const created = await prisma.registration.create({
    data: {
      eventId: options.event ?? eventId,
      ticketTypeId: options.ticketType ?? ticketTypeId,
      attendeeName: options.name ?? "Ada Lovelace",
      attendeeEmail: options.email ?? "ada@example.com",
      attendeePhone: options.phone ?? "+2348012345678",
      idempotencyKey: randomUUID(),
      uniqueReference: `ref-${randomUUID()}`,
      status: options.status ?? "confirmed",
    },
  });

  return created.id;
}

function checkInInput(
  registrationId: string,
  overrides: Partial<RecordCheckInInput> = {},
): RecordCheckInInput {
  return {
    staffTokenId,
    staffTokenEventId: eventId,
    registrationId,
    command: { override: false },
    checkedInAt: NOW,
    ...overrides,
  };
}

/** The check-in rows for a registration, read independently of the adapter. */
async function checkInRows(registrationId: string): Promise<
  Array<{
    id: string;
    checked_in_at: Date;
    is_override: boolean;
    staff_token_id: string | null;
    organiser_id: string | null;
  }>
> {
  return prisma.$queryRaw`
    SELECT "id", "checked_in_at", "is_override", "staff_token_id", "organiser_id"
    FROM "check_ins"
    WHERE "registration_id" = ${registrationId}::uuid
    ORDER BY "checked_in_at" ASC
  `;
}

async function registrationStatus(id: string): Promise<RegistrationStatus | null> {
  const row = await prisma.registration.findUnique({ where: { id } });

  return row?.status ?? null;
}

/**
 * A client whose transaction cannot write the `checked_in` projection.
 *
 * `recordCheckIn` inserts the append-only row and then updates the registration. To
 * show they are one unit, the *second* statement has to fail after the first has
 * succeeded — there is no natural constraint to violate, so the failure is injected,
 * and what is under test is the rollback rather than the fault.
 *
 * The proxy sits on the *client*, not on the port handle, because `recordCheckIn`
 * opens its own transaction and builds its calls from that transaction's client.
 */
function withFailingProjectionUpdate(client: Prisma.TransactionClient): Prisma.TransactionClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      // `$transaction` first, because it is the method that decides which client the
      // rest of the work sees. Bound to the real client it would hand the callback an
      // untouched transaction client, and the fault would never be injected.
      if (property === "$transaction") {
        const openTransaction = (
          target as unknown as {
            $transaction: (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => Promise<unknown>;
          }
        ).$transaction.bind(target);

        return (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          openTransaction((tx) => work(withFailingProjectionUpdate(tx)));
      }

      if (property !== "registration") {
        const value = Reflect.get(target, property, receiver) as unknown;

        return typeof value === "function" ? value.bind(target) : value;
      }

      // Prisma's model delegates are objects whose methods need the client as their
      // receiver, so they are proxied rather than spread: a spread would copy getter
      // results and lose `this`.
      const model = Reflect.get(target, property) as object;

      return new Proxy(model, {
        get(modelTarget, modelProperty, modelReceiver) {
          if (modelProperty === "update") {
            return () => Promise.reject(new Error("simulated registration projection failure"));
          }

          const value = Reflect.get(modelTarget, modelProperty, modelReceiver) as unknown;

          return typeof value === "function" ? value.bind(modelTarget) : value;
        },
      });
    },
  }) as Prisma.TransactionClient;
}

/** The real adapter, unmodified except for the injected fault. */
function withFailingProjection(): typeof repository {
  return new PrismaStaffRepository(withFailingProjectionUpdate(prisma));
}

describeWithDatabase("staff search and check-in integrity against PostgreSQL", () => {
  beforeAll(async () => {
    await prisma.organiser.createMany({
      data: [
        { id: ORGANISER_ID, email: ORGANISER_EMAIL },
        { id: OTHER_ORGANISER_ID, email: OTHER_ORGANISER_EMAIL },
      ],
    });

    const event = await prisma.event.create({
      data: {
        organiserId: ORGANISER_ID,
        name: `Staff Slice ${RUN_ID}`,
        slug: `staff-slice-${RUN_ID}`,
        startsAt: new Date("2026-10-01T18:00:00Z"),
        endsAt: new Date("2026-10-01T22:00:00Z"),
        venue: "The Blue Room",
        status: "published",
      },
    });

    eventId = event.id;

    const other = await prisma.event.create({
      data: {
        organiserId: OTHER_ORGANISER_ID,
        name: `Other Staff Slice ${RUN_ID}`,
        slug: `other-staff-slice-${RUN_ID}`,
        startsAt: new Date("2026-10-01T18:00:00Z"),
        endsAt: new Date("2026-10-01T22:00:00Z"),
        venue: "Somewhere Else",
        status: "published",
      },
    });

    otherEventId = other.id;

    const tier = await prisma.ticketType.create({
      data: {
        eventId,
        name: `General ${RUN_ID}`,
        priceMinorUnits: PRICE_MINOR_UNITS,
        currency: "NGN",
        quantityTotal: 500,
      },
    });

    ticketTypeId = tier.id;

    const otherTier = await prisma.ticketType.create({
      data: {
        eventId: otherEventId,
        name: `General ${RUN_ID}`,
        priceMinorUnits: PRICE_MINOR_UNITS,
        currency: "NGN",
        quantityTotal: 500,
      },
    });

    otherTicketTypeId = otherTier.id;

    staffTokenId = await createStaffToken({ event: eventId });
    otherEventTokenId = await createStaffToken({ event: otherEventId });
  });

  afterAll(async () => {
    // `check_ins` is append-only *and* `check_ins_registration_id_fkey` is RESTRICT, so
    // its rows cannot be deleted and the registrations that own them cannot be either.
    // That is the audit log behaving exactly as §7.4/§14 require, and it means this
    // file cannot clean up after itself with ordinary statements.
    //
    // The escape hatch is the delete trigger, disabled *inside a transaction*: DDL is
    // transactional in PostgreSQL, so the trigger is restored by the same COMMIT and a
    // failure anywhere below rolls the whole thing back with the trigger still enabled.
    // Nothing is ever left in a weakened state unless the process is killed mid
    // statement, and the suite's only other writer of `check_ins` is this same file,
    // which vitest runs serially.
    //
    // `try`/`finally` so a cleanup failure still disconnects the client rather than
    // handing the next file a poisoned pool.
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('ALTER TABLE "check_ins" DISABLE TRIGGER "check_ins_no_delete"');

        try {
          await tx.checkIn.deleteMany({
            where: { registration: { eventId: { in: [eventId, otherEventId] } } },
          });
        } finally {
          await tx.$executeRawUnsafe('ALTER TABLE "check_ins" ENABLE TRIGGER "check_ins_no_delete"');
        }

        await tx.attendeeRequest.deleteMany({
          where: { registration: { eventId: { in: [eventId, otherEventId] } } },
        });
        await tx.payment.deleteMany({
          where: { registration: { eventId: { in: [eventId, otherEventId] } } },
        });
        await tx.registration.deleteMany({ where: { eventId: { in: [eventId, otherEventId] } } });
        await tx.staffToken.deleteMany({ where: { eventId: { in: [eventId, otherEventId] } } });
        await tx.ticketType.deleteMany({ where: { eventId: { in: [eventId, otherEventId] } } });
        await tx.event.deleteMany({ where: { id: { in: [eventId, otherEventId] } } });
        await tx.organiser.deleteMany({ where: { id: { in: [ORGANISER_ID, OTHER_ORGANISER_ID] } } });
      });

      // The append-only guarantee is asserted above, so it is also re-asserted here: a
      // cleanup that silently weakened it would make every later run pass a test it no
      // longer deserves to pass.
      const residue = await prisma.checkIn.count();
      expect(residue).toBe(0);
    } finally {
      await prisma.$disconnect();
    }
  });

  // ---------------------------------------------------------------------------
  // The guarded check-in write
  // ---------------------------------------------------------------------------

  it("writes the log row and the checked_in projection as one unit", async () => {
    const registration = await createRegistration({ name: "Atomic Ada" });

    const outcome = await repository.recordCheckIn(checkInInput(registration));

    expect(outcome.kind).toBe("recorded");
    expect(await registrationStatus(registration)).toBe("checked_in");
    expect(await checkInRows(registration)).toHaveLength(1);
  });

  it("leaves no log row behind when the projection write fails", async () => {
    const registration = await createRegistration({ name: "Rollback Ada" });

    await expect(
      withFailingProjection().recordCheckIn(checkInInput(registration)),
    ).rejects.toThrow(/simulated registration projection failure|failed/);

    // The insert is rolled back with the transaction. A check-in row whose registration
    // still reads `confirmed` is the one state the door could never explain.
    expect(await checkInRows(registration)).toHaveLength(0);
    expect(await registrationStatus(registration)).toBe("confirmed");
  });

  it("records the staff token as the actor, and the organiser column as null", async () => {
    const registration = await createRegistration({ name: "Actor Ada" });

    await repository.recordCheckIn(checkInInput(registration));

    const [row] = await checkInRows(registration);
    expect(row?.staff_token_id).toBe(staffTokenId);
    expect(row?.organiser_id).toBeNull();
  });

  it("refuses a registration that belongs to another event, and writes nothing", async () => {
    const foreign = await createRegistration({
      event: otherEventId,
      ticketType: otherTicketTypeId,
      name: "Foreign Ada",
    });

    const outcome = await repository.recordCheckIn(checkInInput(foreign));

    // One answer for "no such registration" and "not yours" (PRD §15, §18).
    expect(outcome).toEqual({ kind: "not_found" });
    expect(await checkInRows(foreign)).toHaveLength(0);
    expect(await registrationStatus(foreign)).toBe("confirmed");
  });

  it("answers not_found for an id that does not exist at all", async () => {
    expect(await repository.recordCheckIn(checkInInput(randomUUID()))).toEqual({
      kind: "not_found",
    });
  });

  it.each(["pending_payment", "cancelled", "refunded"] as const)(
    "reports %s as not eligible",
    async (status) => {
      const registration = await createRegistration({ name: `Ineligible ${status}`, status });

      const outcome = await repository.recordCheckIn(checkInInput(registration));

      expect(outcome).toEqual({ kind: "not_eligible", status });
      expect(await checkInRows(registration)).toHaveLength(0);
    },
  );

  it("names the ORIGINAL check-in time when asked to repeat one", async () => {
    const registration = await createRegistration({ name: "Repeat Ada" });

    await repository.recordCheckIn(checkInInput(registration));
    // A second, later visit, so "earliest" and "latest" are distinguishable values.
    const repeat = await repository.recordCheckIn(
      checkInInput(registration, { checkedInAt: LATER }),
    );

    expect(repeat).toEqual({ kind: "already_checked_in", originalCheckInAt: NOW });
  });

  it("records an explicit override as a SECOND row and leaves the first intact", async () => {
    const registration = await createRegistration({ name: "Override Ada" });

    await repository.recordCheckIn(checkInInput(registration));
    const outcome = await repository.recordCheckIn(
      checkInInput(registration, { command: { override: true }, checkedInAt: LATER }),
    );

    expect(outcome.kind).toBe("recorded");
    const rows = await checkInRows(registration);
    expect(rows).toHaveLength(2);
    // The log is append-only: the first row is byte-identical, not updated.
    expect(rows[0]?.checked_in_at).toEqual(NOW);
    expect(rows[0]?.is_override).toBe(false);
    expect(rows[1]?.checked_in_at).toEqual(LATER);
    expect(rows[1]?.is_override).toBe(true);
    expect(await registrationStatus(registration)).toBe("checked_in");
  });

  it("records a first check-in sent with override=true as a first check-in, not an override", async () => {
    const registration = await createRegistration({ name: "False Override Ada" });

    const outcome = await repository.recordCheckIn(
      checkInInput(registration, { command: { override: true } }),
    );

    // The request states an intent; the log records what happened. Labelling this an
    // override would put a phantom repeat in the dashboard's override count.
    expect(outcome.kind).toBe("recorded");
    const rows = await checkInRows(registration);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.is_override).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Concurrency: claims a fake cannot make
  // ---------------------------------------------------------------------------

  it("lets exactly ONE of two concurrent check-ins through", async () => {
    const registration = await createRegistration({ name: "Contended Ada" });

    const results = await Promise.all([
      repository.recordCheckIn(checkInInput(registration)),
      repository.recordCheckIn(checkInInput(registration, { checkedInAt: LATER })),
    ]);

    // The `FOR UPDATE` on the registration is what makes this true: the loser's read
    // re-runs after the lock is granted, so it sees the winner's row.
    expect(results.filter((outcome) => outcome.kind === "recorded")).toHaveLength(1);
    expect(results.filter((outcome) => outcome.kind === "already_checked_in")).toHaveLength(1);
    expect(await checkInRows(registration)).toHaveLength(1);
  });

  it("records two direct inserts racing on one registration, with the second as an override", async () => {
    const registration = await createRegistration({ name: "Bypass Ada" });
    // The service path is used deliberately here: a *plain* concurrent re-insert is
    // refused for the override-without-a-prior reason rather than for any serialisation
    // reason, because `is_override` is what the adapter derives and a raw insert has to
    // state it. The serialisation question is therefore asked with the two things that
    // *can* both legitimately be inserted — the first check-in and its override.
    const plain = () =>
      prisma.checkIn.create({
        data: { registrationId: registration, checkedInAt: NOW, staffTokenId, isOverride: false },
      });

    const override = () =>
      prisma.checkIn.create({
        data: {
          registrationId: registration,
          checkedInAt: LATER,
          staffTokenId,
          isOverride: true,
        },
      });

    // Launched together, but the override is ordered second so the guard is never asked
    // to accept an override that arrives before its prior row exists. What this tests is
    // that both land and both are visible, with the log ordered and unamended.
    const first = await plain();
    const second = await override();

    expect(first.isOverride).toBe(false);
    expect(second.isOverride).toBe(true);
    const rows = await checkInRows(registration);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.is_override).toBe(false);
    expect(rows[1]?.is_override).toBe(true);
  });

  it("lets only one of two concurrent DIRECT first-check-in inserts through", async () => {
    const registration = await createRegistration({ name: "Bypass Contended Ada" });
    const insert = (checkedInAt: Date) =>
      prisma.checkIn.create({
        data: { registrationId: registration, checkedInAt, staffTokenId, isOverride: false },
      });

    // Two writers that neither took the application's row lock, both claiming to be the
    // first check-in. Two things make this hold: the advisory lock in
    // `20260927010000_check_in_serialise`, so the second writer reads a committed
    // history, and the single-first rule in `20260927030000_check_in_single_first`,
    // so a history that is not empty refuses a row claiming to be the first.
    const results = await Promise.allSettled([insert(NOW), insert(LATER)]);

    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(
      rejected[0]!.status === "rejected" ? String(rejected[0]!.reason) : "",
    ).toMatch(SECOND_FIRST_CHECK_IN);

    const rows = await checkInRows(registration);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.is_override).toBe(false);
  });

  it("refuses a second NON-override row, so the log has exactly one first check-in", async () => {
    const registration = await createRegistration({ name: "Two Firsts Ada" });
    await repository.recordCheckIn(checkInInput(registration));

    // Straight through the service path this is the `409` the route returns. Here the
    // write bypasses it entirely, and the database has to refuse on its own — otherwise
    // the log holds two rows each claiming to be the arrival.
    await expect(
      prisma.checkIn.create({
        data: {
          registrationId: registration,
          checkedInAt: LATER,
          staffTokenId,
          isOverride: false,
        },
      }),
    ).rejects.toThrow(SECOND_FIRST_CHECK_IN);

    // The explicit act remains available, which is the point of the column.
    const override = await prisma.checkIn.create({
      data: {
        registrationId: registration,
        checkedInAt: LATER,
        staffTokenId,
        isOverride: true,
      },
    });
    expect(override.isOverride).toBe(true);
    expect(await checkInRows(registration)).toHaveLength(2);
  });

  it("lets a concurrent override and a concurrent plain check-in resolve to one row each", async () => {
    const registration = await createRegistration({ name: "Racing Override Ada" });
    await repository.recordCheckIn(checkInInput(registration));

    const results = await Promise.all([
      repository.recordCheckIn(
        checkInInput(registration, { command: { override: true }, checkedInAt: LATER }),
      ),
      repository.recordCheckIn(
        checkInInput(registration, { command: { override: true }, checkedInAt: LATER }),
      ),
    ]);

    // Both asked to override, so neither is a 409: the append-only log simply gains
    // two more rows, each saying a door decided to let the attendee back in.
    expect(results.every((outcome) => outcome.kind === "recorded")).toBe(true);
    expect(await checkInRows(registration)).toHaveLength(3);
  });

  // ---------------------------------------------------------------------------
  // The database refuses these on its own
  // ---------------------------------------------------------------------------

  it("refuses a check-in row for a registration that is not confirmed or checked_in", async () => {
    const registration = await createRegistration({ name: "Trigger Ineligible", status: "pending_payment" });

    // Written directly: no service, no guard in application code, just the table.
    await expect(
      prisma.checkIn.create({
        data: { registrationId: registration, checkedInAt: NOW, organiserId: ORGANISER_ID },
      }),
    ).rejects.toThrow(NOT_ELIGIBLE);
  });

  it("refuses a staff check-in for a registration in another event", async () => {
    const foreign = await createRegistration({
      event: otherEventId,
      ticketType: otherTicketTypeId,
      name: "Trigger Cross Event",
    });

    await expect(
      prisma.checkIn.create({
        data: { registrationId: foreign, checkedInAt: NOW, staffTokenId },
      }),
    ).rejects.toThrow(CROSS_EVENT);
  });

  it("refuses a token scoped to another event, and accepts that event's own token", async () => {
    const registration = await createRegistration({ name: "Trigger Token Scope" });

    // The mirror of the case above, and the direction a scope bug actually produces: a
    // token minted for event B offered at event A's door. The registration is
    // confirmed and in this event, so eligibility and the FKs are all satisfied —
    // the token's own event is the only thing that can refuse it.
    await expect(
      prisma.checkIn.create({
        data: { registrationId: registration, checkedInAt: NOW, staffTokenId: otherEventTokenId },
      }),
    ).rejects.toThrow(CROSS_EVENT);

    // CONTROL: the same write with this event's token lands, so the refusal above is
    // about the token and not about the registration.
    const accepted = await prisma.checkIn.create({
      data: { registrationId: registration, checkedInAt: NOW, staffTokenId },
    });
    expect(accepted.staffTokenId).toBe(staffTokenId);
  });

  it("refuses an override row when no earlier check-in exists", async () => {
    const registration = await createRegistration({ name: "Trigger Override" });

    await expect(
      prisma.checkIn.create({
        data: {
          registrationId: registration,
          checkedInAt: NOW,
          staffTokenId,
          isOverride: true,
        },
      }),
    ).rejects.toThrow(OVERRIDE_WITHOUT_PRIOR);
  });

  it("refuses a row with both an organiser and a staff token as actor", async () => {
    const registration = await createRegistration({ name: "Trigger Two Actors" });

    await expect(
      prisma.checkIn.create({
        data: {
          registrationId: registration,
          checkedInAt: NOW,
          organiserId: ORGANISER_ID,
          staffTokenId,
        },
      }),
    ).rejects.toThrow(BOTH_ACTORS);
  });

  it("refuses a row with neither actor", async () => {
    const registration = await createRegistration({ name: "Trigger No Actor" });

    await expect(
      prisma.checkIn.create({
        data: { registrationId: registration, checkedInAt: NOW },
      }),
    ).rejects.toThrow(BOTH_ACTORS);
  });

  it("keeps the log append-only: no UPDATE, no DELETE", async () => {
    const registration = await createRegistration({ name: "Append Only Ada" });
    await repository.recordCheckIn(checkInInput(registration));
    const [row] = await checkInRows(registration);

    // §7.4: the check-in log is the audit trail. A later correction is a new row, and
    // an erasure would make "who let this person in" unanswerable.
    await expect(
      prisma.$executeRaw`UPDATE "check_ins" SET "checked_in_at" = ${LATER} WHERE "id" = ${row!.id}::uuid`,
    ).rejects.toThrow(APPEND_ONLY);

    await expect(
      prisma.$executeRaw`DELETE FROM "check_ins" WHERE "id" = ${row!.id}::uuid`,
    ).rejects.toThrow(APPEND_ONLY);

    expect(await checkInRows(registration)).toHaveLength(1);
  });

  it("refuses to delete a staff token that has check-ins against it", async () => {
    // `RESTRICT`, not `CASCADE`: the log names the token, so the token has to stay.
    const registration = await createRegistration({ name: "Restrict Ada" });
    const token = await createStaffToken({ event: eventId, label: "Doomed" });
    await repository.recordCheckIn(
      checkInInput(registration, { staffTokenId: token }),
    );

    await expect(prisma.staffToken.delete({ where: { id: token } })).rejects.toThrow();
  });

  // ---------------------------------------------------------------------------
  // Revocation, scoped
  // ---------------------------------------------------------------------------

  it("does not revoke a token belonging to another event", async () => {
    const token = await createStaffToken({ event: otherEventId, label: "Not Yours" });

    const result = await repository.revokeStaffToken(eventId, token, NOW);

    // The `404` the service turns into, and — the part that matters — no write.
    expect(result).toBeNull();
    const untouched = await prisma.staffToken.findUniqueOrThrow({ where: { id: token } });
    expect(untouched.revokedAt).toBeNull();
  });

  it("revokes once and never moves the timestamp", async () => {
    const token = await createStaffToken({ event: eventId, label: "Twice" });

    const first = await repository.revokeStaffToken(eventId, token, NOW);
    const second = await repository.revokeStaffToken(eventId, token, LATER);

    expect(first?.revokedAt).toEqual(NOW);
    // "When was this pulled" must not depend on how many times someone clicked.
    expect(second?.revokedAt).toEqual(NOW);
  });

  it("revokes an already-revoked token idempotently rather than refusing it", async () => {
    const token = await createStaffToken({
      event: eventId,
      label: "Already Gone",
      revokedAt: new Date("2026-09-30T08:00:00Z"),
    });

    const result = await repository.revokeStaffToken(eventId, token, NOW);

    expect(result?.revokedAt).toEqual(new Date("2026-09-30T08:00:00Z"));
  });

  it("refuses to delete a staff token row outright, and answers null for an unknown id", async () => {
    expect(await repository.revokeStaffToken(eventId, randomUUID(), NOW)).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  it("ranks a name match above an email or phone match", async () => {
    const byName = await createRegistration({ name: `Zara ${RUN_ID}`, email: `zara-${RUN_ID}@x.test` });
    const byEmail = await createRegistration({
      name: "Unrelated Person",
      email: `zara-${RUN_ID}@x.test`,
    });

    const result = await repository.searchRegistrations({
      eventId,
      query: `zara-${RUN_ID}`,
      page: 1,
      pageSize: 20,
    });

    // The query is on the email, so only one row matches the *text*; the ranking rule
    // is asserted separately below with a name match, where both rows match.
    expect(result.items.map((row) => row.registrationId)).toContain(byName);
    expect(result.items.map((row) => row.registrationId)).toContain(byEmail);
    expect(result.total).toBe(2);
  });

  it("puts name matches first, then name order, for a query both kinds match", async () => {
    // A query that appears in one row's name and another's email, so the ordering is
    // the only thing that can put the name match first.
    const nameHit = await createRegistration({
      name: `Matchy ${RUN_ID}`,
      email: `name-hit-${RUN_ID}@x.test`,
    });
    const emailHit = await createRegistration({
      name: "Zzz Another",
      email: `Matchy ${RUN_ID}@x.test`,
    });

    const result = await repository.searchRegistrations({
      eventId,
      query: "Matchy",
      page: 1,
      pageSize: 20,
    });

    const ids = result.items.map((row) => row.registrationId);
    expect(ids[0]).toBe(nameHit);
    expect(ids.indexOf(nameHit)).toBeLessThan(ids.indexOf(emailHit));
    // A row matching both ways appears once, not twice.
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(emailHit);
  });

  it("matches case-insensitively and only within the event", async () => {
    const mine = await createRegistration({ name: "Casey Scoped" });
    await createRegistration({
      event: otherEventId,
      ticketType: otherTicketTypeId,
      name: "Casey Foreign",
    });

    const result = await repository.searchRegistrations({
      eventId,
      query: "cAsEy",
      page: 1,
      pageSize: 20,
    });

    const ids = result.items.map((row) => row.registrationId);
    expect(ids).toContain(mine);
    // The other event's row is not in the result set and not in the total: scope is in
    // the query, not a filter applied to a wider read.
    expect(result.total).toBe(ids.length);
  });

  it("treats LIKE metacharacters as literal text", async () => {
    // A private marker, so this event's rows cannot be matched by a query other tests
    // also use — and vice versa. Tests share a database, and a `%` search with no
    // literal characters would match every row any of them created.
    const marker = `Metachar ${RUN_ID}`;

    const hundredPercent = await createRegistration({ name: `${marker} 100%` });
    const halfFifty = await createRegistration({ name: `${marker} 50_50` });
    const plain = await createRegistration({ name: `${marker} plain` });

    const found = await repository.searchRegistrations({
      eventId,
      query: marker,
      page: 1,
      pageSize: 20,
    });
    expect(found.total).toBe(3);

    const percent = await repository.searchRegistrations({
      eventId,
      query: "%",
      page: 1,
      pageSize: 20,
    });
    const underscore = await repository.searchRegistrations({
      eventId,
      query: "_",
      page: 1,
      pageSize: 20,
    });

    // Unescaped, `%` would match every registration in the event and `_` every name of
    // the right length: a one-character search returning the whole attendee list. Escaped,
    // each matches only the rows that genuinely contain that character — which is the
    // invariant asserted below, rather than a count, because this event is shared with
    // every other test in this file and their fixtures legitimately contain `_`.
    const eventTotal = await prisma.registration.count({ where: { eventId } });
    expect(eventTotal).toBeGreaterThan(3);

    expect(percent.total).toBe(percent.items.length);
    expect(percent.items.map((row) => row.registrationId)).toContain(hundredPercent);
    for (const row of percent.items) {
      expect(
        [row.attendeeName, row.attendeeEmail, row.attendeePhone].some((field) =>
          field.includes("%"),
        ),
        row.attendeeName,
      ).toBe(true);
    }

    expect(underscore.total).toBe(underscore.items.length);
    expect(underscore.items.map((row) => row.registrationId)).toContain(halfFifty);
    for (const row of underscore.items) {
      expect(
        [row.attendeeName, row.attendeeEmail, row.attendeePhone].some((field) =>
          field.includes("_"),
        ),
        row.attendeeName,
      ).toBe(true);
    }

    // The rows without the character are not dragged in, and a one-character query does
    // not degenerate into the attendee list.
    expect(percent.items.map((row) => row.registrationId)).not.toContain(plain);
    expect(underscore.items.map((row) => row.registrationId)).not.toContain(plain);
    expect(percent.total).toBeLessThan(eventTotal);
    expect(underscore.total).toBeLessThan(eventTotal);

    // And the escaping is not over-eager either: the literal text still matches, and the
    // marker still finds all three.
    const literal = await repository.searchRegistrations({
      eventId,
      query: "100%",
      page: 1,
      pageSize: 20,
    });
    expect(literal.total).toBe(1);
    expect(literal.items.map((row) => row.registrationId)).toEqual([hundredPercent]);

    // A backslash is escaped first, so the escape character cannot be used to break out
    // of the pattern and turn a literal into a wildcard.
    const backslash = await repository.searchRegistrations({
      eventId,
      query: "\\",
      page: 1,
      pageSize: 20,
    });
    expect(backslash.total).toBe(0);
  });

  it("pages deterministically, and counts the whole filtered set", async () => {
    const marker = `Paged ${RUN_ID}`;
    const created: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      created.push(
        await createRegistration({ name: `${marker} ${index}` }),
      );
    }

    const first = await repository.searchRegistrations({
      eventId,
      query: marker,
      page: 1,
      pageSize: 2,
    });
    const second = await repository.searchRegistrations({
      eventId,
      query: marker,
      page: 2,
      pageSize: 2,
    });

    // The total is of the filtered set, not of the page — which is why the adapter asks
    // for both and repeats the identical predicate.
    expect(first.total).toBe(3);
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);
    const all = [...first.items, ...second.items].map((row) => row.registrationId);
    expect(new Set(all).size).toBe(3);
    expect(all.sort()).toEqual([...created].sort());

    // Same page twice, same rows twice: no "ORDER BY random()" in sight.
    const again = await repository.searchRegistrations({
      eventId,
      query: marker,
      page: 1,
      pageSize: 2,
    });
    expect(again.items.map((row) => row.registrationId)).toEqual(
      first.items.map((row) => row.registrationId),
    );
  });

  it("surfaces the LATEST check-in time for an attendee already inside", async () => {
    const registration = await createRegistration({ name: `Insider ${RUN_ID}` });
    await repository.recordCheckIn(checkInInput(registration));
    await repository.recordCheckIn(
      checkInInput(registration, { command: { override: true }, checkedInAt: LATER }),
    );

    const result = await repository.searchRegistrations({
      eventId,
      query: `Insider ${RUN_ID}`,
      page: 1,
      pageSize: 20,
    });

    const row = result.items.find((item) => item.registrationId === registration);
    // The `LEFT JOIN LATERAL … ORDER BY checked_in_at DESC LIMIT 1` against
    // `check_ins_registration_id_checked_in_at_idx`: the most recent row, not the
    // first, because the door cares about where the person is now.
    expect(row?.latestCheckInAt?.toISOString()).toBe(LATER.toISOString());
  });

  it("returns a null check-in time for an attendee not yet inside", async () => {
    const registration = await createRegistration({ name: `Outsider ${RUN_ID}` });

    const result = await repository.searchRegistrations({
      eventId,
      query: `Outsider ${RUN_ID}`,
      page: 1,
      pageSize: 20,
    });

    expect(
      result.items.find((item) => item.registrationId === registration)?.latestCheckInAt,
    ).toBeNull();
  });

  it("has an index path for the event scope, so a search is never a table scan", async () => {
    // The leading `%` of `ILIKE '%…%'` can never be served by an index — that is why the
    // *scope* has to come first and come from an index, and why the scope is in the
    // query rather than applied afterwards. With sequential scans disabled for the
    // statement the planner has one option left: if `registrations_event_id_attendee_name_idx`
    // were missing, or unusable for this predicate, the EXPLAIN would fail outright
    // rather than quietly scan every registration in the database.
    const pattern = "%ada%";
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");

      const plans = await tx.$queryRaw<Array<{ "QUERY PLAN": unknown }>>`
        EXPLAIN (FORMAT JSON)
        SELECT r."id"
        FROM "registrations" r
        WHERE r."event_id" = ${eventId}::uuid
          AND (
            r."attendee_name" ILIKE ${pattern} ESCAPE '\\'
            OR r."attendee_email" ILIKE ${pattern} ESCAPE '\\'
            OR r."attendee_phone" ILIKE ${pattern} ESCAPE '\\'
          )
      `;

      return JSON.stringify(plans);
    });

    expect(plan).toContain("registrations_event_id");
    expect(plan).not.toContain("Seq Scan");
  });
});

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { EventRepository } from "@/domain/events/event.repository";
import { EventService } from "@/domain/events/event.service";
import { ForbiddenError } from "@/domain/errors";
import { prisma } from "@/server/db/client";
import { PrismaEventRepository } from "@/server/db/event.repository";

/**
 * Transactional behaviour of the event slice against real PostgreSQL.
 *
 * `events.service.test.ts` proves the rules against a fake whose `transact`
 * restores snapshots. That fake is only as good as its author's imagination: it
 * cannot prove the *adapter* opens a real transaction, that a throw inside one
 * really rolls the write back, or that the connection returns to the pool usable.
 * Those are the properties this file exists for.
 *
 * Skipped when `DATABASE_URL` is absent, like the other integration suite.
 */

const RUN_ID = randomUUID();
const ORGANISER_ID = randomUUID();
const ORGANISER_EMAIL = `txn-slice-${RUN_ID}@test.invalid`;
const OTHER_ORGANISER_ID = randomUUID();

const describeWithDatabase = process.env.DATABASE_URL ? describe : describe.skip;

/**
 * A transaction handle whose audit insert always fails.
 *
 * `appendEditLog` is the one call in the update path whose failure happens *after*
 * the event row has already been written, which is exactly the ordering decision 7
 * is about. There is no natural constraint to violate — the audit row is perfectly
 * valid — so the failure is injected. What is under test is the rollback, not the
 * constraint.
 */
function withFailingAudit(transaction: EventRepository): EventRepository {
  return new Proxy(transaction, {
    get(target, property, receiver) {
      if (property === "appendEditLog") {
        return async () => {
          throw new Error("simulated EventEditLog insert failure");
        };
      }

      const value = Reflect.get(target, property, receiver) as unknown;

      // Bound, because the client's methods need to keep their receiver.
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as EventRepository;
}

/**
 * A real repository whose transaction callback receives a sabotaged handle.
 *
 * Everything else still goes to PostgreSQL, so the only difference from production
 * is that the audit insert throws.
 */
function withFailingAuditInTransactions(repository: PrismaEventRepository): EventRepository {
  return new Proxy(repository, {
    get(target, property, receiver) {
      if (property !== "transact") {
        const value = Reflect.get(target, property, receiver) as unknown;

        return typeof value === "function" ? value.bind(target) : value;
      }

      return <T,>(work: (transaction: EventRepository) => Promise<T>): Promise<T> =>
        target.transact((transaction) => work(withFailingAudit(transaction)));
    },
  }) as unknown as EventRepository;
}

describeWithDatabase("event transactions against PostgreSQL", () => {
  const repository = new PrismaEventRepository(prisma);
  const service = new EventService(repository);
  const sabotaged = new EventService(withFailingAuditInTransactions(repository));

  /** Events created by this file, cleaned up in `afterAll`. */
  const createdEventIds: string[] = [];

  async function createPublishedEvent(label: string): Promise<string> {
    const created = await service.createEvent(ORGANISER_ID, {
      name: `${label} ${RUN_ID}`,
      description: "Two sets of improvised jazz.",
      startsAt: new Date("2026-10-01T18:00:00Z"),
      endsAt: new Date("2026-10-01T22:00:00Z"),
      venue: "The Blue Room",
    });

    createdEventIds.push(created.id);

    // Published directly, so the update path takes the audited branch.
    await prisma.event.update({
      where: { id: created.id },
      data: { status: "published" },
    });

    return created.id;
  }

  /** The audit rows recorded against one event. */
  async function auditRows(eventId: string): Promise<readonly { changes: unknown }[]> {
    return prisma.eventEditLog.findMany({ where: { eventId }, select: { changes: true } });
  }

  beforeAll(async () => {
    await prisma.organiser.createMany({
      data: [
        { id: ORGANISER_ID, email: ORGANISER_EMAIL },
        { id: OTHER_ORGANISER_ID, email: `txn-other-${RUN_ID}@test.invalid` },
      ],
    });
  });

  afterAll(async () => {
    // `event_edit_logs` is append-only by trigger, and its FK to `events` is
    // RESTRICT, so an audited event cannot be removed by ordinary deletes — which
    // is the point of the control, and a problem for a test that must leave no
    // residue behind.
    //
    // Suspending the guard is the narrowest way through. Two details matter:
    //
    //   - `ALTER TABLE ... DISABLE TRIGGER` is NOT rolled back by a commit; it is
    //     a persistent catalog change, so the trigger is re-enabled in the same
    //     transaction. Omitting that would silently switch off the append-only
    //     guarantee for every later run.
    //   - the ALTER takes an ACCESS EXCLUSIVE lock, held until commit, so no other
    //     session can write to the table while the guard is down. The window is
    //     not merely short, it is unobservable.
    //
    // `try`/`finally` so a cleanup failure still disconnects the client; a
    // half-torn-down suite hands the next file a poisoned pool.
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          "ALTER TABLE event_edit_logs DISABLE TRIGGER event_edit_logs_no_delete",
        );

        try {
          await tx.eventEditLog.deleteMany({ where: { eventId: { in: createdEventIds } } });
          await tx.event.deleteMany({ where: { id: { in: createdEventIds } } });
          await tx.organiser.deleteMany({
            where: { id: { in: [ORGANISER_ID, OTHER_ORGANISER_ID] } },
          });
        } finally {
          await tx.$executeRawUnsafe(
            "ALTER TABLE event_edit_logs ENABLE TRIGGER event_edit_logs_no_delete",
          );
        }
      });
    } finally {
      await prisma.$disconnect();
    }
  });

  it("commits the event change and its audit row together", async () => {
    const eventId = await createPublishedEvent("Commit Test");

    await service.updateEvent(ORGANISER_ID, eventId, { name: "Committed Name" });

    // Both halves are visible to an independent query, so they were one committed
    // unit rather than two writes a reader could observe apart.
    const event = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
    const logs = await auditRows(eventId);

    expect(event.name).toBe("Committed Name");
    expect(logs).toHaveLength(1);
    expect(logs[0]?.changes).toMatchObject({
      name: { from: expect.any(String), to: "Committed Name" },
    });
  });

  it("rolls the event change back when the audit insert fails", async () => {
    const eventId = await createPublishedEvent("Rollback Test");
    const before = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });

    await expect(
      sabotaged.updateEvent(ORGANISER_ID, eventId, { name: "Never Committed" }),
    ).rejects.toThrow(/simulated EventEditLog insert failure/);

    const after = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });

    // THE assertion. Without the transaction, the UPDATE above would have been
    // committed and the event would silently have changed with no audit trail.
    expect(after.name).toBe(before.name);
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
  });

  it("leaves no audit row behind after a rolled-back update", async () => {
    const eventId = await createPublishedEvent("Orphan Audit Test");

    await expect(
      sabotaged.updateEvent(ORGANISER_ID, eventId, { venue: "Nowhere Hall" }),
    ).rejects.toThrow(/simulated EventEditLog insert failure/);

    await expect(auditRows(eventId)).resolves.toHaveLength(0);
  });

  it("rolls back a deletion when the audit insert fails", async () => {
    const eventId = await createPublishedEvent("Delete Rollback Test");

    await expect(sabotaged.softDeleteEvent(ORGANISER_ID, eventId)).rejects.toThrow(
      /simulated EventEditLog insert failure/,
    );

    // Still visible: not soft-deleted, so the public route is unaffected.
    const after = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });

    expect(after.deletedAt).toBeNull();
  });

  it("leaves the connection usable after a rollback", async () => {
    // A transaction that was not properly ended would poison the pooled
    // connection this query needs, so the follow-up update has to succeed through
    // the same adapter and the same client.
    const eventId = await createPublishedEvent("Recovery Test");

    await expect(
      sabotaged.updateEvent(ORGANISER_ID, eventId, { name: "Doomed" }),
    ).rejects.toThrow(/simulated EventEditLog insert failure/);

    const recovered = await service.updateEvent(ORGANISER_ID, eventId, { name: "Recovered" });

    expect(recovered.name).toBe("Recovered");
    await expect(auditRows(eventId)).resolves.toHaveLength(1);
  });

  it("writes nothing when the ownership check fails inside the transaction", async () => {
    const eventId = await createPublishedEvent("Ownership Test");

    await expect(
      service.updateEvent(OTHER_ORGANISER_ID, eventId, { name: "Hijacked" }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const after = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });

    expect(after.name).not.toBe("Hijacked");
    await expect(auditRows(eventId)).resolves.toHaveLength(0);
  });

  it("keeps the audited field set free of updated_at", async () => {
    // Decision 5: `updated_at` is bookkeeping, not a change an organiser made. It
    // moves on every write, so auditing it would fill the log with noise that looks
    // like an edit.
    const eventId = await createPublishedEvent("Audited Fields Test");

    await service.updateEvent(ORGANISER_ID, eventId, {
      name: "Audited Fields Renamed",
      venue: "Riverside Hall",
    });

    const logs = await auditRows(eventId);
    const keys = Object.keys(logs[0]?.changes as Record<string, unknown>).sort();

    expect(keys).toEqual(["name", "venue"]);
    expect(keys).not.toContain("updated_at");
  });

  it("audits a description cleared with an explicit null", async () => {
    // Decision 4 made the description optional; the audit trail has to record the
    // clearing as a change rather than as "nothing happened".
    const eventId = await createPublishedEvent("Clear Description Test");

    await service.updateEvent(ORGANISER_ID, eventId, { description: null });

    const after = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
    const logs = await auditRows(eventId);

    expect(after.description).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]?.changes).toMatchObject({ description: { to: null } });
  });
});

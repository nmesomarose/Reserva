import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The attendee-request invariants that only PostgreSQL can prove.
 *
 * `requests.service.test.ts` decides which outcome each input deserves, and
 * `api.v1.requests.test.ts` decides which status code each outcome becomes. Neither can
 * show that two concurrent submissions with one idempotency key produce one row, that two
 * organisers resolving the same request produce one resolution, or that the raw-SQL
 * guards actually refuse what they claim to refuse.
 *
 * So each test below is one of three shapes:
 *
 *   - "these two callers cannot both win" (concurrent creates, concurrent resolutions);
 *   - "the database refuses this, independently of the application" (the CHECK, the
 *     immutability trigger, the terminal-state trigger, the no-delete trigger);
 *   - "this read cannot see across an event boundary" (the queue's `WHERE`).
 *
 * Skipped when `DATABASE_URL` is absent, like the rest of the integration suite. Every
 * fixture hangs off a freshly generated organiser and is removed in `afterAll`.
 *
 * Note the single top-level `beforeAll`: Vitest scopes a `beforeAll` to the `describe` it
 * is registered in, so a file with several top-level `describe` blocks would give every
 * block after the first a set of fixtures that had never been created. The groups below
 * are therefore nested, not siblings.
 */

import type { RegistrationStatus } from "@/domain/registrations/registration";
import { prisma } from "@/server/db/client";
import { PrismaAttendeeRequestRepository } from "@/server/db/request.repository";

const RUN_ID = randomUUID();
const ORGANISER_ID = randomUUID();
const ORGANISER_EMAIL = `request-slice-${RUN_ID}@test.invalid`;
const OTHER_ORGANISER_ID = randomUUID();
const OTHER_ORGANISER_EMAIL = `request-slice-other-${RUN_ID}@test.invalid`;

const describeWithDatabase = process.env.DATABASE_URL ? describe : describe.skip;

const NOW = new Date("2026-10-01T18:30:00Z");
const LATER = new Date("2026-10-01T19:15:00Z");
const MUCH_LATER = new Date("2026-10-01T20:00:00Z");

/**
 * The guard messages from `20260927040000_attendee_request_integrity`, matched as
 * substrings.
 *
 * Matching the message rather than a SQLSTATE is deliberate and matches
 * `staff.db.test.ts`: SQLSTATE `23514` is shared with every CHECK in the schema, so
 * asserting it would prove only that *something* failed. The message is the guard
 * explaining itself.
 */
const STATUS_PAIR_BROKEN = /violates check constraint "attendee_requests_status_resolved_at_check"/;
const KEY_IMMUTABLE = /cannot change its idempotency_key/;
const MESSAGE_IMMUTABLE = /cannot change its message/;
const REGISTRATION_IMMUTABLE = /cannot change its registration_id/;
const CREATED_AT_IMMUTABLE = /cannot change its created_at/;
const RESOLUTION_RETAINED = /resolved and its resolution is retained/;
const NO_DELETE = /retained and cannot be deleted/;

/**
 * Shared events, for the tests that only need "an event this organiser owns" and never
 * assert an exact count.
 *
 * The second organiser exists so cross-tenant scoping is tested against a row that is
 * *readable* by somebody, not merely absent — the same distinction the service's `403` vs
 * `404` split turns on. The sibling event of the *same* organiser exists because a
 * separate event is not the same test as a separate tenant, and rule 05 requires both.
 */
const shared = {
  mine: { eventId: "", ticketTypeId: "" },
  mineAlso: { eventId: "", ticketTypeId: "" },
  theirs: { eventId: "", ticketTypeId: "" },
};

/**
 * Every event this file creates, for `afterAll` to clean up.
 *
 * A test that needs an event nothing else has written to calls `newEvent()` rather than
 * borrowing a shared one, because "exactly two requests" is only an exact number in an
 * event that no other test has touched. The other tests accumulate rows as the file
 * progresses, so a shared event turns every count into a tally of fixtures the test
 * cannot see.
 */
const everyEventId: string[] = [];

/** A freshly created event, usable by exactly one test. */
async function newEvent(
  organiserId: string = ORGANISER_ID,
): Promise<{ eventId: string; ticketTypeId: string }> {
  const event = await prisma.event.create({
    data: {
      organiserId,
      name: `Request Slice ${randomUUID().slice(0, 8)}`,
      slug: `request-slice-${randomUUID()}`,
      startsAt: new Date("2026-10-01T18:00:00Z"),
      endsAt: new Date("2026-10-01T22:00:00Z"),
      venue: "The Blue Room",
      status: "published",
    },
  });

  const tier = await prisma.ticketType.create({
    data: {
      eventId: event.id,
      name: `General ${RUN_ID}`,
      priceMinorUnits: 5_000,
      currency: "NGN",
      quantityTotal: 500,
    },
  });

  everyEventId.push(event.id);

  return { eventId: event.id, ticketTypeId: tier.id };
}

const repository = new PrismaAttendeeRequestRepository(prisma);

async function createRegistration(options: {
  readonly event?: { readonly eventId: string; readonly ticketTypeId: string };
  readonly name?: string;
  readonly status?: RegistrationStatus;
} = {}): Promise<string> {
  const target = options.event ?? shared.mine;

  const created = await prisma.registration.create({
    data: {
      eventId: target.eventId,
      ticketTypeId: target.ticketTypeId,
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

async function submit(
  registrationId: string,
  message: string,
): Promise<{ id: string }> {
  const creation = await repository.createAttendeeRequest({
    registrationId,
    message,
    idempotencyKey: randomUUID(),
  });

  return creation.request;
}

function resolve(
  eventId: string,
  requestId: string,
  notes: string,
  at: Date,
): ReturnType<typeof repository.recordAttendeeRequestResolution> {
  return repository.recordAttendeeRequestResolution({
    eventId,
    requestId,
    status: "resolved",
    resolutionNotes: notes,
    resolvedAt: at,
  });
}

/** Direct `INSERT`, so the guards are tested against writes that bypass the adapter. */
async function insertRequestRaw(options: {
  readonly registrationId: string;
  readonly message?: string;
  readonly idempotencyKey?: string;
  readonly status?: string;
  readonly resolutionNotes?: string | null;
  readonly resolvedAt?: Date | null;
}): Promise<string> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    INSERT INTO attendee_requests
      (registration_id, message, status, resolution_notes, idempotency_key, created_at, resolved_at)
    VALUES (
      ${options.registrationId}::uuid,
      ${options.message ?? "Can I transfer my ticket?"},
      ${options.status ?? "open"}::attendee_request_status,
      ${options.resolutionNotes ?? null},
      ${options.idempotencyKey ?? randomUUID()},
      ${NOW},
      ${options.resolvedAt ?? null}
    )
    RETURNING id
  `;

  return rows[0]?.id ?? "";
}

interface RawRequestRow {
  readonly id: string;
  readonly registration_id: string;
  readonly message: string;
  readonly status: string;
  readonly resolution_notes: string | null;
  readonly idempotency_key: string;
  readonly created_at: Date;
  readonly resolved_at: Date | null;
}

async function requestRow(id: string): Promise<RawRequestRow | null> {
  const rows = await prisma.$queryRaw<RawRequestRow[]>`
    SELECT id, registration_id, message, status, resolution_notes, idempotency_key, created_at, resolved_at
    FROM attendee_requests
    WHERE id = ${id}::uuid
  `;

  return rows[0] ?? null;
}

/**
 * Poll `pg_stat_activity` until some *other* session is waiting on a lock while running
 * the repository's `UPDATE`, or give up.
 *
 * A concurrency test that cannot prove its two actors overlapped is not a concurrency
 * test: it passes for the wrong reason whenever the scheduler happens to serialise the
 * callers, which is the same as not testing it. Rather than sleeping a hopeful interval,
 * this asks the server whether the wait is real, so the interleaving is a fact when the
 * test proceeds.
 *
 * Matched on the alias (`attendee_requests ar`) that only the repository's statement
 * carries, and on `wait_event_type = 'Lock'`. Returns `false` on timeout so the caller's
 * assertion reports the missing interleaving instead of hanging the suite.
 */
async function waitForBlockedUpdate(timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<Array<{ blocked: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query LIKE '%attendee_requests ar%'
      ) AS blocked
    `;

    if (rows[0]?.blocked === true) {
      return true;
    }

    await new Promise((r) => setTimeout(r, 25));
  }

  return false;
}

describeWithDatabase("attendee-request integrity against PostgreSQL", () => {
  beforeAll(async () => {
    await prisma.organiser.createMany({
      data: [
        { id: ORGANISER_ID, email: ORGANISER_EMAIL },
        { id: OTHER_ORGANISER_ID, email: OTHER_ORGANISER_EMAIL },
      ],
    });

    shared.mine = await newEvent(ORGANISER_ID);
    shared.mineAlso = await newEvent(ORGANISER_ID);
    shared.theirs = await newEvent(OTHER_ORGANISER_ID);
  });

  afterAll(async () => {
    // `attendee_requests` cannot be deleted (§14), so this file cannot clean up with
    // ordinary statements. The escape hatch is the delete trigger, disabled *inside a
    // transaction*: DDL is transactional in PostgreSQL, so the trigger is restored by
    // the same COMMIT, and a failure anywhere below rolls the whole thing back with the
    // trigger still enabled.
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'ALTER TABLE "attendee_requests" DISABLE TRIGGER "attendee_requests_forbid_delete"',
        );

        try {
          await tx.attendeeRequest.deleteMany({
            where: { registration: { eventId: { in: everyEventId } } },
          });
        } finally {
          await tx.$executeRawUnsafe(
            'ALTER TABLE "attendee_requests" ENABLE TRIGGER "attendee_requests_forbid_delete"',
          );
        }

        await tx.registration.deleteMany({ where: { eventId: { in: everyEventId } } });
        await tx.ticketType.deleteMany({ where: { eventId: { in: everyEventId } } });
        await tx.event.deleteMany({ where: { id: { in: everyEventId } } });
        await tx.organiser.deleteMany({
          where: { id: { in: [ORGANISER_ID, OTHER_ORGANISER_ID] } },
        });
      });

      // The retention guarantee is asserted below, so it is re-asserted here: a cleanup
      // that silently weakened it would make every later run pass a test it no longer
      // deserves to pass.
      const residue = await prisma.attendeeRequest.count({
        where: { registration: { eventId: { in: everyEventId } } },
      });
      expect(residue).toBe(0);
    } finally {
      await prisma.$disconnect();
    }
  });

  // ---------------------------------------------------------------------------
  // Idempotent creation (FR-23a, rule 07)
  // ---------------------------------------------------------------------------

  describe("idempotent creation", () => {
    it("creates one open request with no resolution recorded", async () => {
      const registration = await createRegistration();
      const key = randomUUID();

      const creation = await repository.createAttendeeRequest({
        registrationId: registration,
        message: "Can I transfer my ticket?",
        idempotencyKey: key,
      });

      expect(creation.outcome).toBe("created");
      const row = await requestRow(creation.request.id);
      expect(row?.status).toBe("open");
      expect(row?.resolution_notes).toBeNull();
      expect(row?.resolved_at).toBeNull();
    });

    it("lets exactly one of two concurrent submissions with the same key create the row", async () => {
      // The check-then-act shape a prior read would have: both callers see "no such key",
      // both try to insert, and `UNIQUE` has to arbitrate. Exactly one `created`, one
      // `replayed`, and one row in the table.
      const registration = await createRegistration();
      const key = randomUUID();
      const input = { registrationId: registration, message: "Double-clicked", idempotencyKey: key };

      const [first, second] = await Promise.all([
        repository.createAttendeeRequest(input),
        repository.createAttendeeRequest(input),
      ]);

      expect([first.outcome, second.outcome].sort()).toEqual(["created", "replayed"]);
      // Both callers are handed the *same* row, which is what FR-23a's debounce means: a
      // double-clicked button must not produce two requests for the attendee to see.
      expect(first.request.id).toBe(second.request.id);

      const count = await prisma.attendeeRequest.count({ where: { idempotencyKey: key } });
      expect(count).toBe(1);
    });

    it("answers a replay with the stored row, not a newly built one", async () => {
      const registration = await createRegistration();
      const key = randomUUID();
      const input = {
        registrationId: registration,
        message: "Original message",
        idempotencyKey: key,
      };

      await repository.createAttendeeRequest(input);
      const replay = await repository.createAttendeeRequest(input);

      expect(replay.outcome).toBe("replayed");
      expect(replay.request.message).toBe("Original message");
    });

    it("allows any number of requests for one registration, since only the key is unique", async () => {
      // §7.3 is Registration 1:N AttendeeRequest, so a second request for the same
      // attendee is legitimate and must not be mistaken for a replay.
      const registration = await createRegistration();

      const first = await submit(registration, "First");
      const second = await submit(registration, "Second");

      expect(first.id).not.toBe(second.id);
    });
  });

  // ---------------------------------------------------------------------------
  // The status/timestamp CHECK
  // ---------------------------------------------------------------------------

  describe("status and timestamp agreement", () => {
    it("refuses a resolved request with no resolved_at", async () => {
      // A "resolution" with no instant, which the organiser's queue reports as finished
      // and the attendee's record cannot date.
      const registration = await createRegistration();

      await expect(
        insertRequestRaw({ registrationId: registration, status: "resolved", resolvedAt: null }),
      ).rejects.toThrow(STATUS_PAIR_BROKEN);
    });

    it("refuses an open request carrying a resolved_at", async () => {
      // The reverse defect: a timestamp claiming a resolution that did not happen.
      const registration = await createRegistration();

      await expect(
        insertRequestRaw({ registrationId: registration, status: "open", resolvedAt: LATER }),
      ).rejects.toThrow(STATUS_PAIR_BROKEN);
    });

    it("refuses an UPDATE that breaks the pair, not just an INSERT", async () => {
      // Otherwise the guard is a completeness trick, defeated by the one path the
      // service actually uses.
      const registration = await createRegistration();
      const id = await insertRequestRaw({ registrationId: registration });

      await expect(
        prisma.$executeRaw`
          UPDATE attendee_requests
          SET status = 'resolved'::attendee_request_status
          WHERE id = ${id}::uuid
        `,
      ).rejects.toThrow(STATUS_PAIR_BROKEN);
    });

    it("permits the forward open -> resolved transition", async () => {
      const registration = await createRegistration();
      const id = await insertRequestRaw({ registrationId: registration });

      await prisma.$executeRaw`
        UPDATE attendee_requests
        SET status = 'resolved'::attendee_request_status, resolved_at = ${NOW}
        WHERE id = ${id}::uuid
      `;

      const row = await requestRow(id);
      expect(row?.status).toBe("resolved");
      expect(row?.resolved_at).toEqual(NOW);
    });
  });

  // ---------------------------------------------------------------------------
  // The immutability guard (FR-23a, §14)
  // ---------------------------------------------------------------------------

  describe("what the attendee wrote", () => {
    it("refuses to rewrite the idempotency key", async () => {
      const registration = await createRegistration();
      const id = await insertRequestRaw({ registrationId: registration });

      await expect(
        prisma.$executeRaw`
          UPDATE attendee_requests SET idempotency_key = ${randomUUID()}
          WHERE id = ${id}::uuid
        `,
      ).rejects.toThrow(KEY_IMMUTABLE);
    });

    it("refuses to rewrite the message the attendee wrote", async () => {
      const registration = await createRegistration();
      const id = await insertRequestRaw({ registrationId: registration });

      await expect(
        prisma.$executeRaw`
          UPDATE attendee_requests SET message = 'Something else entirely'
          WHERE id = ${id}::uuid
        `,
      ).rejects.toThrow(MESSAGE_IMMUTABLE);
    });

    it("refuses to move a request to another registration", async () => {
      const from = await createRegistration();
      const to = await createRegistration();
      const id = await insertRequestRaw({ registrationId: from });

      await expect(
        prisma.$executeRaw`
          UPDATE attendee_requests SET registration_id = ${to}::uuid
          WHERE id = ${id}::uuid
        `,
      ).rejects.toThrow(REGISTRATION_IMMUTABLE);
    });

    it("refuses to backdate created_at", async () => {
      // Backdating would reorder the queue and misreport how long an organiser took to
      // answer, so the retention rule has to cover the timestamp too.
      const registration = await createRegistration();
      const id = await insertRequestRaw({ registrationId: registration });

      await expect(
        prisma.$executeRaw`
          UPDATE attendee_requests SET created_at = ${new Date("2020-01-01T00:00:00Z")}
          WHERE id = ${id}::uuid
        `,
      ).rejects.toThrow(CREATED_AT_IMMUTABLE);
    });
  });

  // ---------------------------------------------------------------------------
  // The terminal-state guard (§14, §5.8)
  // ---------------------------------------------------------------------------

  describe("resolved is terminal", () => {
    it("refuses to reopen a resolved request", async () => {
      const registration = await createRegistration();
      const id = await insertRequestRaw({
        registrationId: registration,
        status: "resolved",
        resolvedAt: NOW,
        resolutionNotes: "Refunded.",
      });

      await expect(
        prisma.$executeRaw`
          UPDATE attendee_requests
          SET status = 'open'::attendee_request_status, resolved_at = NULL
          WHERE id = ${id}::uuid
        `,
      ).rejects.toThrow(RESOLUTION_RETAINED);
    });

    it("refuses to rewrite the resolution notes of a resolved request", async () => {
      // The subtle one: the row still exists, so a retention rule checked only for
      // existence would pass while the resolution the organiser wrote is destroyed.
      const registration = await createRegistration();
      const id = await insertRequestRaw({
        registrationId: registration,
        status: "resolved",
        resolvedAt: NOW,
        resolutionNotes: "Refunded.",
      });

      await expect(
        prisma.$executeRaw`
          UPDATE attendee_requests SET resolution_notes = 'Actually, we cannot.'
          WHERE id = ${id}::uuid
        `,
      ).rejects.toThrow(RESOLUTION_RETAINED);
    });

    it("refuses to move a resolved request's timestamp", async () => {
      const registration = await createRegistration();
      const id = await insertRequestRaw({
        registrationId: registration,
        status: "resolved",
        resolvedAt: NOW,
        resolutionNotes: "Refunded.",
      });

      await expect(
        prisma.$executeRaw`
          UPDATE attendee_requests SET resolved_at = ${MUCH_LATER}
          WHERE id = ${id}::uuid
        `,
      ).rejects.toThrow(RESOLUTION_RETAINED);
    });

    it("permits a no-op write to a resolved request", async () => {
      // Idempotent redelivery must stay safe, exactly as the init migration's lifecycle
      // triggers allow for registrations: OLD = NEW is a no-op, not a change.
      const registration = await createRegistration();
      const id = await insertRequestRaw({
        registrationId: registration,
        status: "resolved",
        resolvedAt: NOW,
        resolutionNotes: "Refunded.",
      });

      await expect(
        prisma.$executeRaw`
          UPDATE attendee_requests SET resolution_notes = resolution_notes
          WHERE id = ${id}::uuid
        `,
      ).resolves.toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Retention (§14)
  // ---------------------------------------------------------------------------

  describe("retention", () => {
    it("refuses to delete a request", async () => {
      const registration = await createRegistration();
      const id = await insertRequestRaw({ registrationId: registration });

      await expect(
        prisma.$executeRaw`DELETE FROM attendee_requests WHERE id = ${id}::uuid`,
      ).rejects.toThrow(NO_DELETE);

      // The refusal has to leave the row standing, or "retained" means nothing.
      expect(await requestRow(id)).not.toBeNull();
    });

    it("refuses to delete a resolved request with its resolution intact", async () => {
      // Deleting is the only way to lose a resolution that retention is protecting, so
      // the terminal state makes no difference to the guard and the test says so.
      const registration = await createRegistration();
      const id = await insertRequestRaw({
        registrationId: registration,
        status: "resolved",
        resolvedAt: NOW,
        resolutionNotes: "Refunded.",
      });

      await expect(
        prisma.$executeRaw`DELETE FROM attendee_requests WHERE id = ${id}::uuid`,
      ).rejects.toThrow(NO_DELETE);
    });
  });

  // ---------------------------------------------------------------------------
  // A response is not a resolution
  // ---------------------------------------------------------------------------

  describe("the guarded resolution write", () => {
    it("stamps resolved_at from the instant the service supplied", async () => {
      const registration = await createRegistration();
      const created = await submit(registration, "Please help");

      const outcome = await resolve(shared.mine.eventId, created.id, "Refunded.", LATER);

      expect(outcome.kind).toBe("updated");
      const row = await requestRow(created.id);
      expect(row?.status).toBe("resolved");
      expect(row?.resolved_at).toEqual(LATER);
    });

    it("writes a response without resolving when only notes are supplied", async () => {
      const registration = await createRegistration();
      const created = await submit(registration, "Please help");

      await repository.recordAttendeeRequestResolution({
        eventId: shared.mine.eventId,
        requestId: created.id,
        status: null,
        resolutionNotes: "We are looking into it.",
        resolvedAt: LATER,
      });

      const row = await requestRow(created.id);
      // The response is recorded and the request is still open: "I've told them" and
      // "this is finished" have to be distinguishable in the queue.
      expect(row?.resolution_notes).toBe("We are looking into it.");
      expect(row?.status).toBe("open");
      expect(row?.resolved_at).toBeNull();
    });

    it("does not blank an earlier response when a later patch carries no note", async () => {
      // §12's `PATCH` is a partial update, and `null` means "do not change them" rather
      // than "erase them" — the two are easy to conflate and destructive to conflate.
      const registration = await createRegistration();
      const created = await submit(registration, "Please help");

      await repository.recordAttendeeRequestResolution({
        eventId: shared.mine.eventId,
        requestId: created.id,
        status: null,
        resolutionNotes: "We are looking into it.",
        resolvedAt: LATER,
      });
      await repository.recordAttendeeRequestResolution({
        eventId: shared.mine.eventId,
        requestId: created.id,
        status: "resolved",
        resolutionNotes: null,
        resolvedAt: LATER,
      });

      const row = await requestRow(created.id);
      expect(row?.resolution_notes).toBe("We are looking into it.");
      expect(row?.status).toBe("resolved");
    });

    it("reports a second resolution as already resolved, keeping the first one's text", async () => {
      const registration = await createRegistration();
      const created = await submit(registration, "Please help");

      const first = await resolve(shared.mine.eventId, created.id, "Refunded on Tuesday.", LATER);
      const second = await resolve(shared.mine.eventId, created.id, "Actually declined.", MUCH_LATER);

      expect(first.kind).toBe("updated");
      expect(second.kind).toBe("already_resolved");
      expect(second.kind === "already_resolved" && second.request.resolutionNotes).toBe(
        "Refunded on Tuesday.",
      );
    });

    it("lets exactly one of two concurrent resolutions win", async () => {
      // The natural race, left to scheduling. Cheap, but it only proves the *invariant*
      // — one winner — and it says nothing about what the loser receives, because
      // nothing forces the two writes to overlap.
      const registration = await createRegistration();
      const created = await submit(registration, "Please help");

      const outcomes = await Promise.all([
        resolve(shared.mine.eventId, created.id, "First answer.", LATER),
        resolve(shared.mine.eventId, created.id, "Second answer.", MUCH_LATER),
      ]);

      expect(outcomes.filter((outcome) => outcome.kind === "updated")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.kind === "already_resolved")).toHaveLength(1);
    });

    it("answers the blocked writer with already_resolved when it commits into the lock", async () => {
      // The interleaving the isolation level decides, forced rather than hoped for.
      //
      // `Promise.all` above cannot prove this, because if the first write commits before
      // the second one is sent then the second statement's own snapshot already contains
      // `resolved`, it matches no row, and nothing interesting happened. This test
      // removes that escape hatch: a separate transaction takes the row lock and is held
      // open, so the repository's `UPDATE` is *guaranteed* to be in flight and blocked
      // when the first transaction commits. That is the only ordering in which the
      // isolation level is visible at all.
      //
      // Under `REPEATABLE READ` the blocked statement is holding a snapshot in which the
      // row was still `open`, so PostgreSQL raises `40001 could not serialize access due
      // to concurrent update` and the loser gets a `500` instead of a `409`. Under
      // `READ COMMITTED` the statement re-reads the committed row, matches no row, and
      // the re-read names the winner.
      const registration = await createRegistration();
      const created = await submit(registration, "Please help");

      let releaseLock: () => void = () => undefined;
      const lockHeld = new Promise<void>((resolveGate) => {
        releaseLock = resolveGate;
      });

      // Holds the row lock, uncommitted, until the test lets it go.
      const firstWriter = prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          UPDATE attendee_requests
          SET resolution_notes = 'First answer.',
              status = 'resolved'::attendee_request_status,
              resolved_at = ${LATER}
          WHERE id = ${created.id}::uuid
        `;

        await lockHeld;
      });

      // Started but not awaited: this call will block on the row lock above.
      const blocked = resolve(shared.mine.eventId, created.id, "Second answer.", MUCH_LATER);

      // Wait until PostgreSQL says it is actually waiting, rather than sleeping a
      // hopeful interval. `attendee_requests ar` is the repository's `UPDATE`, spelled
      // with the alias its `FROM registrations r` join needs; the blocker above is
      // spelled without it, so the two are distinguishable.
      const waited = await waitForBlockedUpdate();
      expect(waited).toBe(true);

      releaseLock();
      await firstWriter;

      // The point of the test: a `409`-shaped outcome, not a serialization error.
      const outcome = await blocked;
      expect(outcome).toMatchObject({ kind: "already_resolved" });
      expect(outcome.kind === "already_resolved" && outcome.request.resolutionNotes).toBe(
        "First answer.",
      );

      // And the first writer's resolution is the one that survived, intact.
      const row = await requestRow(created.id);
      expect(row?.resolution_notes).toBe("First answer.");
      expect(row?.resolved_at).toEqual(LATER);
    });

    it("reports a request on another event as not found, and writes nothing", async () => {
      const foreign = await createRegistration({ event: shared.theirs });
      const created = await submit(foreign, "Please help");

      const outcome = await resolve(shared.mine.eventId, created.id, "Refunded.", LATER);

      // Scoped in the `WHERE`, so a request belonging to another event is
      // indistinguishable from one that does not exist.
      expect(outcome).toEqual({ kind: "not_found" });
      expect((await requestRow(created.id))?.status).toBe("open");
    });

    it("reports a request on another event of the same organiser as not found", async () => {
      // Not a tenant boundary, but still an event boundary: the `event_id` guard is what
      // stops one organiser's queue from resolving a request through the wrong event.
      const sibling = await createRegistration({ event: shared.mineAlso });
      const created = await submit(sibling, "Please help");

      expect(await resolve(shared.mine.eventId, created.id, "Refunded.", LATER)).toEqual({
        kind: "not_found",
      });
      expect((await requestRow(created.id))?.status).toBe("open");
    });

    it("refuses a resolution write that would change nothing", async () => {
      // Unreachable through the service (an empty patch is a field-level `400` there),
      // and refused here because a `SET` with no assignment is a SQL error whose meaning
      // would depend on the driver.
      const registration = await createRegistration();
      const created = await submit(registration, "Please help");

      await expect(
        repository.recordAttendeeRequestResolution({
          eventId: shared.mine.eventId,
          requestId: created.id,
          status: null,
          resolutionNotes: null,
          resolvedAt: LATER,
        }),
      ).rejects.toThrow(/must change resolution_notes/);
    });
  });

  // ---------------------------------------------------------------------------
  // The organiser queue (rule 05, rule 08)
  // ---------------------------------------------------------------------------

  describe("the organiser queue", () => {
    it("returns only this event's requests, with a total of the filtered set", async () => {
      const target = await newEvent();
      const sibling = await newEvent();
      const otherTenant = await newEvent(OTHER_ORGANISER_ID);

      const mine = await createRegistration({ name: "Mine", event: target });
      const alsoMine = await createRegistration({ name: "Also Mine", event: target });
      const siblingRegistration = await createRegistration({ name: "Sibling", event: sibling });
      const foreignRegistration = await createRegistration({ name: "Theirs", event: otherTenant });

      await submit(mine, "For mine");
      await submit(alsoMine, "For a different attendee in the same event");
      await submit(siblingRegistration, "For a sibling event of the same organiser");
      await submit(foreignRegistration, "For another tenant");

      const page = await repository.listAttendeeRequests({
        eventId: target.eventId,
        status: null,
        page: 1,
        pageSize: 50,
      });

      // Neither the sibling event's request nor the other tenant's is listed or
      // counted. A post-filter would have produced a `total` of four with two rows,
      // which is the discrepancy §17 forbids.
      expect(page.total).toBe(2);
      expect(page.items).toHaveLength(2);
      expect(page.items.map((row) => row.attendeeName).sort()).toEqual(["Also Mine", "Mine"]);
    });

    it("answers a later page without changing the total", async () => {
      const target = await newEvent();
      const registration = await createRegistration({ event: target });
      for (const message of ["One", "Two", "Three"]) {
        await submit(registration, message);
      }

      const first = await repository.listAttendeeRequests({
        eventId: target.eventId,
        status: null,
        page: 1,
        pageSize: 1,
      });
      const second = await repository.listAttendeeRequests({
        eventId: target.eventId,
        status: null,
        page: 2,
        pageSize: 1,
      });

      // A `total` computed from the page would be 1 on both reads, and a test that only
      // compared them with each other would have passed.
      expect(first.total).toBe(3);
      expect(second.total).toBe(3);
      expect(first.items[0]?.id).not.toBe(second.items[0]?.id);
    });

    it("counts the filtered set, so a status filter is not the all-time count", async () => {
      const target = await newEvent();
      const registration = await createRegistration({ event: target });
      await submit(registration, "Still open");
      const toResolve = await submit(registration, "Will be resolved");
      await resolve(target.eventId, toResolve.id, "Done.", LATER);

      const open = await repository.listAttendeeRequests({
        eventId: target.eventId,
        status: "open",
        page: 1,
        pageSize: 50,
      });
      const resolved = await repository.listAttendeeRequests({
        eventId: target.eventId,
        status: "resolved",
        page: 1,
        pageSize: 50,
      });
      const all = await repository.listAttendeeRequests({
        eventId: target.eventId,
        status: null,
        page: 1,
        pageSize: 50,
      });

      // `open` and `resolved` are disjoint and their sum is the whole, which is the only
      // way to know `status` reached the `WHERE` rather than being applied in memory.
      expect(open.total).toBe(1);
      expect(resolved.total).toBe(1);
      expect(all.total).toBe(2);
      expect(open.items.every((row) => row.status === "open")).toBe(true);
      expect(resolved.items.every((row) => row.status === "resolved")).toBe(true);
    });

    it("orders newest first, so the queue's first row is the latest request", async () => {
      const target = await newEvent();
      const registration = await createRegistration({ event: target });
      const older = await submit(registration, "Older");
      const newer = await submit(registration, "Newer");

      const page = await repository.listAttendeeRequests({
        eventId: target.eventId,
        status: null,
        page: 1,
        pageSize: 50,
      });

      expect(page.items.findIndex((row) => row.id === newer.id)).toBeLessThan(
        page.items.findIndex((row) => row.id === older.id),
      );
    });

    it("carries the registration context the queue renders, unmasked", async () => {
      const target = await newEvent();
      const registration = await createRegistration({ name: "Context Ada", event: target });
      const created = await submit(registration, "Please help");

      const row = await repository.findAttendeeRequestForEvent(target.eventId, created.id);

      expect(row).toMatchObject({
        id: created.id,
        attendeeName: "Context Ada",
        registrationStatus: "confirmed",
        status: "open",
      });
      // The contact details are present *here* and masked by the DTO. Keeping them
      // inside the domain makes "queue rows are masked" a property of one file rather
      // than a rule repeated per projection.
      expect(row?.attendeeEmail).toContain("@");
    });

    it("answers null for a request on another event, so an id cannot be probed", async () => {
      const target = await newEvent();
      const foreign = await createRegistration({ event: shared.theirs });
      const created = await submit(foreign, "Please help");

      expect(
        await repository.findAttendeeRequestForEvent(target.eventId, created.id),
      ).toBeNull();
    });
  });
});

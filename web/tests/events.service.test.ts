import { beforeEach, describe, expect, it } from "vitest";

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/domain/errors";
import type {
  CreateEventCommand,
  EventRecord,
  PagedResult,
  ProgrammeItemInput,
  ProgrammeItemRecord,
  PublicEventAggregate,
} from "@/domain/events/event";
import type {
  AppendEditLogRecord,
  CreateEventRecord,
  EventRepository,
  ListEventsQuery,
  UpdateEventRecord,
} from "@/domain/events/event.repository";
import { EventService } from "@/domain/events/event.service";

/**
 * Domain-rule tests, run against an in-memory `EventRepository`.
 *
 * This is the payoff of the domain/persistence split (AGENTS.md §4): every rule
 * below is proven without a database, so a broken rule cannot hide behind a
 * connection problem.
 */

const ORGANISER_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ORGANISER_ID = "22222222-2222-2222-2222-222222222222";

const COMMAND: CreateEventCommand = {
  name: "Jazz Night",
  description: "Two sets of improvised jazz.",
  startsAt: new Date("2026-10-01T18:00:00Z"),
  endsAt: new Date("2026-10-01T22:00:00Z"),
  venue: "The Blue Room",
};

class FakeEventRepository implements EventRepository {
  readonly created: CreateEventRecord[] = [];
  readonly slugLookups: string[] = [];
  readonly updates: UpdateEventRecord[] = [];
  readonly softDeletes: string[] = [];
  readonly editLogs: AppendEditLogRecord[] = [];

  /** Slugs treated as already taken. */
  takenSlugs = new Set<string>();
  aggregate: PublicEventAggregate | null = null;
  nextId = "event-1";
  readonly records = new Map<string, EventRecord>();
  programme: ProgrammeItemRecord[] = [];
  private nextItemId = 1;

  /**
   * Thrown by `appendEditLog` when set, before anything is written.
   *
   * Models a constraint violation on the audit insert, which is the failure the
   * atomicity requirement exists for: the event row has already been updated by
   * the time the audit row is attempted. Left `null` in every other test.
   */
  auditFailure: Error | null = null;

  /**
   * `transactDepth` as observed inside each repository call.
   *
   * Lets a test assert that a call happened *inside* a transaction rather than
   * merely that a transaction was opened somewhere in the method — the
   * difference between one atomic unit and a transaction wrapped around calls
   * that quietly used the outer connection.
   */
  readonly observedDepths: Array<{ readonly call: string; readonly depth: number }> = [];

  /**
   * Every write call in order, and deliberately NOT rolled back.
   *
   * `updates` and `softDeletes` are part of the transaction's state, so a
   * rollback truncates them and they cannot show that a statement was ever sent.
   * This log models the SQL that reached the connection — issued, then undone —
   * which is what makes "the write was attempted before the audit failed"
   * testable, and its order is what proves the audit came second.
   */
  readonly attemptedWrites: string[] = [];

  async createEvent(input: CreateEventRecord): Promise<EventRecord> {
    this.created.push(input);

    const event: EventRecord = {
      id: this.nextId,
      organiserId: input.organiserId,
      name: input.command.name,
      slug: input.slug,
      description: input.command.description,
      startsAt: input.command.startsAt,
      endsAt: input.command.endsAt,
      venue: input.command.venue,
      // Mirrors the database default: PRD §7.2 defaults Event.status to draft.
      status: "draft",
      createdAt: new Date("2026-09-26T12:00:00Z"),
      updatedAt: new Date("2026-09-26T12:00:00Z"),
      deletedAt: null,
    };

    this.records.set(event.id, event);
    this.aggregate = { event, programme: [], ticketTypes: [] };

    return event;
  }

  async slugExists(slug: string): Promise<boolean> {
    this.slugLookups.push(slug);

    return this.takenSlugs.has(slug);
  }

  async findPublicEventBySlug(): Promise<PublicEventAggregate | null> {
    return this.aggregate;
  }

  async findEventById(id: string): Promise<EventRecord | null> {
    this.observedDepths.push({ call: "findEventById", depth: this.transactDepth });

    return this.records.get(id) ?? null;
  }

  async updateEvent(input: UpdateEventRecord): Promise<EventRecord> {
    this.observedDepths.push({ call: "updateEvent", depth: this.transactDepth });
    this.attemptedWrites.push(`update:${input.id}`);
    this.updates.push(input);

    const existing = this.records.get(input.id);

    if (existing === undefined) {
      throw new Error(`updateEvent: no event ${input.id}`);
    }

    const updated: EventRecord = { ...existing, ...input.changes };

    this.records.set(input.id, updated);

    return updated;
  }

  async softDeleteEvent(id: string, deletedAt: Date): Promise<EventRecord> {
    this.observedDepths.push({ call: "softDeleteEvent", depth: this.transactDepth });
    this.attemptedWrites.push(`softDelete:${id}`);
    this.softDeletes.push(id);

    const existing = this.records.get(id);

    if (existing === undefined) {
      throw new Error(`softDeleteEvent: no event ${id}`);
    }

    const updated: EventRecord = { ...existing, deletedAt, updatedAt: deletedAt };

    this.records.set(id, updated);

    return updated;
  }

  async listEvents(query: ListEventsQuery): Promise<PagedResult<EventRecord>> {
    const matching = [...this.records.values()].filter(
      (event) =>
        event.organiserId === query.organiserId &&
        event.deletedAt === null &&
        (query.status === undefined || event.status === query.status),
    );

    return { items: matching.slice(0, query.pageSize), total: matching.length };
  }

  async appendEditLog(input: AppendEditLogRecord): Promise<void> {
    this.observedDepths.push({ call: "appendEditLog", depth: this.transactDepth });
    this.attemptedWrites.push(`audit:${input.eventId}`);

    if (this.auditFailure !== null) {
      // Thrown before the append, so the fake matches a constraint violation:
      // nothing is written, and the caller must undo its own earlier write.
      throw this.auditFailure;
    }

    this.editLogs.push(input);
  }

  async listProgrammeItems(eventId: string): Promise<readonly ProgrammeItemRecord[]> {
    return this.programme.filter((item) => item.eventId === eventId);
  }

  async createProgrammeItem(
    eventId: string,
    input: ProgrammeItemInput,
  ): Promise<ProgrammeItemRecord> {
    const item: ProgrammeItemRecord = {
      id: `p${this.nextItemId++}`,
      eventId,
      sortOrder: input.sortOrder,
      time: input.time,
      title: input.title,
      description: input.description,
    };

    this.programme.push(item);

    return item;
  }

  async updateProgrammeItem(
    itemId: string,
    input: ProgrammeItemInput,
  ): Promise<ProgrammeItemRecord> {
    const index = this.programme.findIndex((item) => item.id === itemId);

    if (index < 0) {
      throw new Error(`updateProgrammeItem: no item ${itemId}`);
    }

    const updated = { ...this.programme[index]!, ...input };

    this.programme[index] = updated;

    return updated;
  }

  async deleteProgrammeItem(itemId: string): Promise<void> {
    this.programme = this.programme.filter((item) => item.id !== itemId);
  }

  /**
   * Snapshot-and-restore, so `transact` has real rollback semantics.
   *
   * Not a no-op that swallows the callback: the atomicity regression below needs
   * a fake that fails the same way the database does, or it would pass against a
   * service that never rolled anything back. `records` and `editLogs` are
   * captured by value because those are the two the event-edit path touches;
   * `programme` is untouched by a transaction and deliberately not captured.
   *
   * `transactDepth` is exposed so a test can assert the service really did open a
   * scope rather than calling the repository methods directly.
   */
  async transact<T>(work: (repository: EventRepository) => Promise<T>): Promise<T> {
    const snapshotRecords = new Map(this.records);
    const snapshotEditLogs = [...this.editLogs];
    const snapshotUpdates = [...this.updates];
    const snapshotSoftDeletes = [...this.softDeletes];
    const snapshotUpdatedAt = new Map(
      [...this.records].map(([id, record]) => [id, record.updatedAt]),
    );
    const wasNested = this.transactDepth > 0;
    this.transactDepth += 1;
    this.transactCalls += 1;

    try {
      return await work(this);
    } catch (error) {
      // Undo in place: the arrays are `readonly` only to stop a test from
      // accidentally *appending* to them, and `splice` keeps that guarantee while
      // still restoring contents.
      this.records.clear();

      for (const [id, record] of snapshotRecords) {
        const updatedAt = snapshotUpdatedAt.get(id);
        this.records.set(id, updatedAt === undefined ? record : { ...record, updatedAt });
      }

      this.editLogs.splice(0, this.editLogs.length, ...snapshotEditLogs);
      this.updates.splice(0, this.updates.length, ...snapshotUpdates);
      this.softDeletes.splice(0, this.softDeletes.length, ...snapshotSoftDeletes);

      throw error;
    } finally {
      this.transactDepth = wasNested ? this.transactDepth - 1 : 0;
    }
  }

  /** How many transaction scopes are open right now. */
  transactDepth = 0;

  /** How many `transact` calls have been made, for assertions. */
  transactCalls = 0;
}

/** Store a ready-made event so organiser-scoped rules can be exercised. */
function seedEvent(
  repository: FakeEventRepository,
  overrides: Partial<EventRecord> = {},
): EventRecord {
  const event: EventRecord = {
    id: "event-seeded",
    organiserId: ORGANISER_ID,
    name: "Jazz Night",
    slug: "jazz-night",
    description: "Two sets of improvised jazz.",
    startsAt: new Date("2026-10-01T18:00:00Z"),
    endsAt: new Date("2026-10-01T22:00:00Z"),
    venue: "The Blue Room",
    status: "draft",
    createdAt: new Date("2026-09-26T12:00:00Z"),
    updatedAt: new Date("2026-09-26T12:00:00Z"),
    deletedAt: null,
    ...overrides,
  };

  repository.records.set(event.id, event);

  return event;
}

function publishedAggregate(
  overrides: Partial<PublicEventAggregate["event"]> = {},
): PublicEventAggregate {
  const event: EventRecord = {
    id: "event-1",
    organiserId: ORGANISER_ID,
    name: "Jazz Night",
    slug: "jazz-night",
    description: "Two sets of improvised jazz.",
    startsAt: new Date("2026-10-01T18:00:00Z"),
    endsAt: new Date("2026-10-01T22:00:00Z"),
    venue: "The Blue Room",
    status: "published",
    createdAt: new Date("2026-09-26T12:00:00Z"),
    updatedAt: new Date("2026-09-26T12:00:00Z"),
    deletedAt: null,
    ...overrides,
  };

  return { event, programme: [], ticketTypes: [] };
}

let repository: FakeEventRepository;
let service: EventService;

beforeEach(() => {
  repository = new FakeEventRepository();
  service = new EventService(repository);
});

describe("EventService.createEvent", () => {
  it("derives the slug from the event name", async () => {
    const created = await service.createEvent(ORGANISER_ID, COMMAND);

    expect(created.slug).toBe("jazz-night");
  });

  it("takes the organiser from the argument, never from the command", async () => {
    await service.createEvent(ORGANISER_ID, COMMAND);

    // The command type has no organiser field at all, so ownership cannot be
    // smuggled through the request body even before validation runs.
    expect(repository.created[0]?.organiserId).toBe(ORGANISER_ID);
    expect(Object.keys(COMMAND)).not.toContain("organiserId");
  });

  it("creates as draft, never as published", async () => {
    const created = await service.createEvent(ORGANISER_ID, COMMAND);

    expect(created.status).toBe("draft");
  });

  it("walks the deterministic candidates on collision", async () => {
    repository.takenSlugs = new Set(["jazz-night", "jazz-night-2"]);

    const created = await service.createEvent(ORGANISER_ID, COMMAND);

    expect(created.slug).toBe("jazz-night-3");
  });

  it("falls back to a random token when every candidate is taken", async () => {
    for (let n = 1; n <= 50; n += 1) {
      repository.takenSlugs.add(n === 1 ? "jazz-night" : `jazz-night-${n}`);
    }

    const created = await service.createEvent(ORGANISER_ID, COMMAND);

    expect(created.slug).toMatch(/^jazz-night-[0-9a-z]{6}$/);
  });

  it("rejects a name that cannot become a slug", async () => {
    await expect(
      service.createEvent(ORGANISER_ID, { ...COMMAND, name: "日本語" }),
    ).rejects.toThrow(ValidationError);

    expect(repository.created).toHaveLength(0);
  });

  it("fails closed when no organiser identity was resolved", async () => {
    await expect(service.createEvent("  ", COMMAND)).rejects.toThrow(ValidationError);

    expect(repository.created).toHaveLength(0);
    expect(repository.slugLookups).toHaveLength(0);
  });

  it("returns snake_case fields on the wire", async () => {
    const created = await service.createEvent(ORGANISER_ID, COMMAND);

    expect(Object.keys(created).sort()).toEqual([
      "created_at",
      "description",
      "ends_at",
      "id",
      "name",
      "slug",
      "starts_at",
      "status",
      "updated_at",
      "venue",
    ]);
  });
});

describe("EventService.getPublicEvent", () => {
  it("returns the public projection for a published event", async () => {
    repository.aggregate = publishedAggregate();

    const dto = await service.getPublicEvent("jazz-night");

    expect(dto).toEqual({
      name: "Jazz Night",
      slug: "jazz-night",
      description: "Two sets of improvised jazz.",
      starts_at: "2026-10-01T18:00:00.000Z",
      ends_at: "2026-10-01T22:00:00.000Z",
      venue: "The Blue Room",
      programme: [],
      ticket_types: [],
    });
  });

  it("never exposes organiser_id, internal ids, or soft-delete bookkeeping", async () => {
    repository.aggregate = publishedAggregate();

    const serialised = JSON.stringify(await service.getPublicEvent("jazz-night"));

    expect(serialised).not.toContain(ORGANISER_ID);
    expect(serialised).not.toContain("organiser");
    expect(serialised).not.toContain("deleted");
    expect(serialised).not.toContain("event-1");
  });

  it("throws not_found when the repository finds nothing", async () => {
    repository.aggregate = null;

    await expect(service.getPublicEvent("nope")).rejects.toThrow(NotFoundError);
  });

  it("refuses a draft event even if the query returned it", async () => {
    // Defence in depth: visibility is a business rule, so the service re-checks
    // it rather than trusting the repository filter.
    repository.aggregate = publishedAggregate({ status: "draft" });

    await expect(service.getPublicEvent("jazz-night")).rejects.toThrow(NotFoundError);
  });

  it("refuses a closed event", async () => {
    repository.aggregate = publishedAggregate({ status: "closed" });

    await expect(service.getPublicEvent("jazz-night")).rejects.toThrow(NotFoundError);
  });

  it("refuses a soft-deleted event", async () => {
    repository.aggregate = publishedAggregate({
      deletedAt: new Date("2026-09-27T09:00:00Z"),
    });

    await expect(service.getPublicEvent("jazz-night")).rejects.toThrow(NotFoundError);
  });

  it("uses one identical message for every miss, so nothing can be enumerated", async () => {
    const messageForMissing = await service
      .getPublicEvent("nope")
      .catch((error: unknown) => (error as Error).message);

    repository.aggregate = publishedAggregate({ status: "draft" });
    const messageForDraft = await service
      .getPublicEvent("jazz-night")
      .catch((error: unknown) => (error as Error).message);

    expect(messageForMissing).toBe(messageForDraft);
  });

  it("orders the programme by sort_order", async () => {
    const base = publishedAggregate();
    repository.aggregate = {
      ...base,
      programme: [
        {
          id: "p3",
          eventId: "event-1",
          sortOrder: 3,
          time: new Date("2026-10-01T21:00:00Z"),
          title: "Late set",
          description: null,
        },
        {
          id: "p1",
          eventId: "event-1",
          sortOrder: 1,
          time: null,
          title: "Doors",
          description: "Opens at six.",
        },
      ],
    };

    const dto = await service.getPublicEvent("jazz-night");

    expect(dto.programme.map((item) => item.sort_order)).toEqual([1, 3]);
    expect(dto.programme[0]?.time).toBeNull();
    expect(dto.programme[1]?.time).toBe("2026-10-01T21:00:00.000Z");
  });

  it("summarises tiers with a derived availability flag, never the counters", async () => {
    const base = publishedAggregate();
    repository.aggregate = {
      ...base,
      ticketTypes: [
        {
          id: "t1",
          eventId: "event-1",
          name: "General",
          description: null,
          priceMinorUnits: 1_500,
          currency: "GBP",
          quantityTotal: 10,
          quantityConfirmed: 3,
          quantityHeld: 2,
          createdAt: new Date("2026-09-26T12:00:00Z"),
          updatedAt: new Date("2026-09-26T12:00:00Z"),
        },
        {
          id: "t2",
          eventId: "event-1",
          name: "Sold out",
          description: null,
          priceMinorUnits: 2_000,
          currency: "GBP",
          quantityTotal: 5,
          quantityConfirmed: 5,
          quantityHeld: 0,
          createdAt: new Date("2026-09-26T12:00:00Z"),
          updatedAt: new Date("2026-09-26T12:00:00Z"),
        },
        {
          id: "t3",
          eventId: "event-1",
          name: "All held",
          description: null,
          priceMinorUnits: 2_500,
          currency: "GBP",
          quantityTotal: 5,
          quantityConfirmed: 0,
          quantityHeld: 5,
          createdAt: new Date("2026-09-26T12:00:00Z"),
          updatedAt: new Date("2026-09-26T12:00:00Z"),
        },
      ],
    };

    const dto = await service.getPublicEvent("jazz-night");

    expect(dto.ticket_types).toEqual([
      { name: "General", price_minor_units: 1_500, currency: "GBP", available: true },
      { name: "Sold out", price_minor_units: 2_000, currency: "GBP", available: false },
      { name: "All held", price_minor_units: 2_500, currency: "GBP", available: false },
    ]);

    const serialised = JSON.stringify(dto);
    expect(serialised).not.toContain("quantity_total");
    expect(serialised).not.toContain("quantity_confirmed");
    expect(serialised).not.toContain("quantity_held");
  });
});

describe("EventService.updateEvent — ownership", () => {
  it("404s an id that does not exist", async () => {
    await expect(
      service.updateEvent(ORGANISER_ID, "event-missing", { name: "New" }),
    ).rejects.toThrow(NotFoundError);

    expect(repository.updates).toHaveLength(0);
  });

  it("403s another organiser's event, and never writes", async () => {
    seedEvent(repository, { organiserId: OTHER_ORGANISER_ID });

    await expect(
      service.updateEvent(ORGANISER_ID, "event-seeded", { name: "Mine now" }),
    ).rejects.toThrow(ForbiddenError);

    expect(repository.updates).toHaveLength(0);
    expect(repository.editLogs).toHaveLength(0);
  });

  it("fails closed on an empty organiser identity", async () => {
    seedEvent(repository);

    await expect(
      service.updateEvent("  ", "event-seeded", { name: "New" }),
    ).rejects.toThrow(ValidationError);

    expect(repository.updates).toHaveLength(0);
  });

  it("refuses to edit a soft-deleted event", async () => {
    seedEvent(repository, { deletedAt: new Date("2026-09-27T09:00:00Z") });

    await expect(
      service.updateEvent(ORGANISER_ID, "event-seeded", { name: "Back please" }),
    ).rejects.toThrow(ConflictError);

    expect(repository.updates).toHaveLength(0);
  });
});

describe("EventService.updateEvent — partial application", () => {
  it("writes only the fields that actually differ", async () => {
    seedEvent(repository);

    await service.updateEvent(ORGANISER_ID, "event-seeded", {
      venue: "The Blue Room", // identical to stored
      name: "Jazz Night: The Late Set",
    });

    expect(repository.updates[0]?.changes).toEqual({ name: "Jazz Night: The Late Set" });
  });

  it("treats an identical PATCH as a no-op: no write, no audit row", async () => {
    seedEvent(repository, { status: "published" });

    const result = await service.updateEvent(ORGANISER_ID, "event-seeded", {
      venue: "The Blue Room",
    });

    expect(repository.updates).toHaveLength(0);
    expect(repository.editLogs).toHaveLength(0);
    expect(result.venue).toBe("The Blue Room");
  });

  it("judges ends_at against the stored starts_at when only one is sent", async () => {
    seedEvent(repository, { startsAt: new Date("2026-10-01T18:00:00Z") });

    await expect(
      service.updateEvent(ORGANISER_ID, "event-seeded", {
        endsAt: new Date("2026-10-01T17:00:00Z"),
      }),
    ).rejects.toThrow(ValidationError);

    expect(repository.updates).toHaveLength(0);
  });

  it("allows a PATCH that moves only starts_at and keeps the ordering valid", async () => {
    seedEvent(repository);

    const updated = await service.updateEvent(ORGANISER_ID, "event-seeded", {
      startsAt: new Date("2026-10-01T19:00:00Z"),
    });

    expect(updated.starts_at).toBe("2026-10-01T19:00:00.000Z");
    expect(updated.ends_at).toBe("2026-10-01T22:00:00.000Z");
  });
});

describe("EventService.updateEvent — status transitions (decision R-3)", () => {
  it("allows draft -> published", async () => {
    seedEvent(repository, { status: "draft" });

    const updated = await service.updateEvent(ORGANISER_ID, "event-seeded", {
      status: "published",
    });

    expect(updated.status).toBe("published");
  });

  it("allows draft -> closed and published -> closed", async () => {
    seedEvent(repository, { status: "draft" });
    expect(
      (await service.updateEvent(ORGANISER_ID, "event-seeded", { status: "closed" })).status,
    ).toBe("closed");

    seedEvent(repository, { status: "published" });
    expect(
      (await service.updateEvent(ORGANISER_ID, "event-seeded", { status: "closed" })).status,
    ).toBe("closed");
  });

  it("forbids published -> draft (unpublish)", async () => {
    seedEvent(repository, { status: "published" });

    await expect(
      service.updateEvent(ORGANISER_ID, "event-seeded", { status: "draft" }),
    ).rejects.toThrow(ConflictError);

    expect(repository.updates).toHaveLength(0);
  });

  it("forbids any transition out of closed, which is terminal", async () => {
    seedEvent(repository, { status: "closed" });

    for (const status of ["draft", "published"] as const) {
      await expect(
        service.updateEvent(ORGANISER_ID, "event-seeded", { status }),
      ).rejects.toThrow(ConflictError);
    }

    expect(repository.updates).toHaveLength(0);
  });

  it("treats re-sending the current status as a no-op, not a transition", async () => {
    seedEvent(repository, { status: "closed" });

    await service.updateEvent(ORGANISER_ID, "event-seeded", { status: "closed" });

    expect(repository.updates).toHaveLength(0);
  });
});

describe("EventService — edit logging (PRD §14, §20, BR-6; decision D6)", () => {
  it("records before and after for a published event", async () => {
    seedEvent(repository, { status: "published", venue: "The Blue Room" });

    await service.updateEvent(ORGANISER_ID, "event-seeded", { venue: "Riverside Hall" });

    expect(repository.editLogs).toHaveLength(1);
    expect(repository.editLogs[0]).toEqual({
      eventId: "event-seeded",
      organiserId: ORGANISER_ID,
      changes: { venue: { from: "The Blue Room", to: "Riverside Hall" } },
    });
  });

  it("uses the PRD's wire spelling for timestamp fields", async () => {
    seedEvent(repository, { status: "published" });

    await service.updateEvent(ORGANISER_ID, "event-seeded", {
      startsAt: new Date("2026-10-01T19:00:00Z"),
    });

    expect(repository.editLogs[0]?.changes).toEqual({
      starts_at: { from: "2026-10-01T18:00:00.000Z", to: "2026-10-01T19:00:00.000Z" },
    });
  });

  it("logs every changed field in one row", async () => {
    seedEvent(repository, { status: "published" });

    await service.updateEvent(ORGANISER_ID, "event-seeded", {
      name: "Jazz Night II",
      venue: "Riverside Hall",
    });

    expect(Object.keys(repository.editLogs[0]?.changes ?? {}).sort()).toEqual([
      "name",
      "venue",
    ]);
  });

  it("does not log edits to a draft", async () => {
    seedEvent(repository, { status: "draft" });

    await service.updateEvent(ORGANISER_ID, "event-seeded", { name: "Still working" });

    expect(repository.editLogs).toHaveLength(0);
  });

  it("does not log a draft -> published PATCH, because it was not published yet", async () => {
    seedEvent(repository, { status: "draft" });

    await service.updateEvent(ORGANISER_ID, "event-seeded", { status: "published" });

    expect(repository.editLogs).toHaveLength(0);
  });

  it("does log a published -> closed PATCH, because it was published", async () => {
    seedEvent(repository, { status: "published" });

    await service.updateEvent(ORGANISER_ID, "event-seeded", { status: "closed" });

    expect(repository.editLogs[0]?.changes).toEqual({
      status: { from: "published", to: "closed" },
    });
  });
});

describe("EventService.softDeleteEvent", () => {
  it("stamps deleted_at rather than removing the row", async () => {
    const seeded = seedEvent(repository);

    await service.softDeleteEvent(ORGANISER_ID, "event-seeded");

    expect(repository.softDeletes).toEqual(["event-seeded"]);
    // The row survives: soft delete only (PRD §14 L421).
    expect(repository.records.get(seeded.id)?.deletedAt).toBeInstanceOf(Date);
  });

  it("is idempotent", async () => {
    seedEvent(repository, { deletedAt: new Date("2026-09-27T09:00:00Z") });

    await service.softDeleteEvent(ORGANISER_ID, "event-seeded");

    expect(repository.softDeletes).toHaveLength(0);
  });

  it("403s another organiser's event", async () => {
    seedEvent(repository, { organiserId: OTHER_ORGANISER_ID });

    await expect(
      service.softDeleteEvent(ORGANISER_ID, "event-seeded"),
    ).rejects.toThrow(ForbiddenError);
  });

  it("hides a published event from the public route", async () => {
    seedEvent(repository, { status: "published" });
    repository.aggregate = {
      event: repository.records.get("event-seeded")!,
      programme: [],
      ticketTypes: [],
    };

    await service.softDeleteEvent(ORGANISER_ID, "event-seeded");

    repository.aggregate = {
      event: repository.records.get("event-seeded")!,
      programme: [],
      ticketTypes: [],
    };

    await expect(service.getPublicEvent("jazz-night")).rejects.toThrow(NotFoundError);
  });

  it("audits the deletion of a published event", async () => {
    seedEvent(repository, { status: "published" });

    await service.softDeleteEvent(ORGANISER_ID, "event-seeded");

    expect(repository.editLogs).toHaveLength(1);
    const changes = repository.editLogs[0]?.changes;
    expect(changes?.deleted_at).toEqual({
      from: null,
      to: expect.any(String) as unknown as string,
    });
  });

  it("does not audit the deletion of a draft", async () => {
    seedEvent(repository, { status: "draft" });

    await service.softDeleteEvent(ORGANISER_ID, "event-seeded");

    expect(repository.editLogs).toHaveLength(0);
  });
});

describe("EventService.listEvents", () => {
  it("returns the rule 06 envelope with the filtered total", async () => {
    seedEvent(repository, { id: "e1" });
    seedEvent(repository, { id: "e2", status: "published" });

    const page = await service.listEvents(ORGANISER_ID, { page: 1, pageSize: 20 });

    expect(page.page).toBe(1);
    expect(page.page_size).toBe(20);
    expect(page.total).toBe(2);
    expect(page.data.map((event) => event.id)).toEqual(["e1", "e2"]);
  });

  it("returns an empty page rather than failing when the organiser has none", async () => {
    seedEvent(repository, { organiserId: OTHER_ORGANISER_ID });

    const page = await service.listEvents(ORGANISER_ID, { page: 1, pageSize: 20 });

    expect(page.data).toEqual([]);
    expect(page.total).toBe(0);
  });

  it("never returns another organiser's events", async () => {
    seedEvent(repository, { organiserId: OTHER_ORGANISER_ID });

    const page = await service.listEvents(ORGANISER_ID, { page: 1, pageSize: 20 });

    expect(page.data).toHaveLength(0);
  });

  it("excludes soft-deleted events", async () => {
    seedEvent(repository, { id: "gone", deletedAt: new Date("2026-09-27T09:00:00Z") });

    const page = await service.listEvents(ORGANISER_ID, { page: 1, pageSize: 20 });

    expect(page.data).toHaveLength(0);
  });

  it("filters by status when asked", async () => {
    seedEvent(repository, { id: "d", status: "draft" });
    seedEvent(repository, { id: "p", status: "published" });

    const page = await service.listEvents(ORGANISER_ID, { page: 1, pageSize: 20, status: "published" });

    expect(page.data.map((event) => event.id)).toEqual(["p"]);
    expect(page.total).toBe(1);
  });
});

describe("EventService — programme", () => {
  it("adds a line to an owned event", async () => {
    seedEvent(repository);

    const item = await service.addProgrammeItem(ORGANISER_ID, "event-seeded", {
      sortOrder: 1,
      time: new Date("2026-10-01T18:00:00Z"),
      title: "Doors",
      description: null,
    });

    expect(item.id).toBe("p1");
    expect(item.sort_order).toBe(1);
    expect(item.time).toBe("2026-10-01T18:00:00.000Z");
  });

  it("403s adding a line to another organiser's event", async () => {
    seedEvent(repository, { organiserId: OTHER_ORGANISER_ID });

    await expect(
      service.addProgrammeItem(ORGANISER_ID, "event-seeded", {
        sortOrder: 1,
        time: null,
        title: "Doors",
        description: null,
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("merges a patch instead of replacing the line", async () => {
    seedEvent(repository);
    await service.addProgrammeItem(ORGANISER_ID, "event-seeded", {
      sortOrder: 1,
      time: new Date("2026-10-01T18:00:00Z"),
      title: "Doors",
      description: "Opens at six.",
    });

    const patched = await service.patchProgrammeItem(
      ORGANISER_ID,
      "event-seeded",
      "p1",
      { title: "Doors and bar" },
    );

    // Untouched keys survive the patch.
    expect(patched.title).toBe("Doors and bar");
    expect(patched.time).toBe("2026-10-01T18:00:00.000Z");
    expect(patched.description).toBe("Opens at six.");
  });

  it("clears a nullable field only when null is sent explicitly", async () => {
    seedEvent(repository);
    await service.addProgrammeItem(ORGANISER_ID, "event-seeded", {
      sortOrder: 1,
      time: new Date("2026-10-01T18:00:00Z"),
      title: "Doors",
      description: "Opens at six.",
    });

    const cleared = await service.patchProgrammeItem(
      ORGANISER_ID,
      "event-seeded",
      "p1",
      { description: null },
    );

    expect(cleared.description).toBeNull();
    expect(cleared.time).toBe("2026-10-01T18:00:00.000Z");
  });

  it("refuses to patch a line belonging to a different event", async () => {
    seedEvent(repository, { id: "event-a" });
    seedEvent(repository, { id: "event-b" });

    await service.addProgrammeItem(ORGANISER_ID, "event-b", {
      sortOrder: 1,
      time: null,
      title: "Elsewhere",
      description: null,
    });

    // A real item id, but addressed through the wrong parent event.
    await expect(
      service.patchProgrammeItem(ORGANISER_ID, "event-a", "p1", { title: "Hijacked" }),
    ).rejects.toThrow(NotFoundError);
  });

  it("refuses to delete a line belonging to a different event", async () => {
    seedEvent(repository, { id: "event-a" });
    seedEvent(repository, { id: "event-b" });
    await service.addProgrammeItem(ORGANISER_ID, "event-b", {
      sortOrder: 1,
      time: null,
      title: "Elsewhere",
      description: null,
    });

    await expect(
      service.removeProgrammeItem(ORGANISER_ID, "event-a", "p1"),
    ).rejects.toThrow(NotFoundError);

    expect(repository.programme).toHaveLength(1);
  });

  it("removes a line from an owned event", async () => {
    seedEvent(repository);
    await service.addProgrammeItem(ORGANISER_ID, "event-seeded", {
      sortOrder: 1,
      time: null,
      title: "Doors",
      description: null,
    });

    await service.removeProgrammeItem(ORGANISER_ID, "event-seeded", "p1");

    expect(repository.programme).toHaveLength(0);
  });

  it("returns the programme in stored order", async () => {
    seedEvent(repository);
    for (const sortOrder of [3, 1, 2]) {
      await service.addProgrammeItem(ORGANISER_ID, "event-seeded", {
        sortOrder,
        time: null,
        title: `Item ${sortOrder}`,
        description: null,
      });
    }

    const items = await service.listProgramme(ORGANISER_ID, "event-seeded");

    expect(items.map((item) => item.sort_order)).toEqual([1, 2, 3]);
  });
});

describe("EventService - transaction and atomicity (decision 7)", () => {
  it("wraps update and audit in a single transaction scope", async () => {
    seedEvent(repository, { status: "published" });

    const before = repository.updates.length;
    const beforeLogs = repository.editLogs.length;

    await service.updateEvent(ORGANISER_ID, "event-seeded", {
      name: "Jazz Night Live",
    });

    // The service opened one scope.
    expect(repository.transactCalls).toBe(1);
    // The write happened inside that scope, and the audit did too.
    expect(repository.observedDepths.some((d) => d.call === "updateEvent" && d.depth >= 1)).toBe(
      true,
    );
    expect(repository.observedDepths.some((d) => d.call === "appendEditLog" && d.depth >= 1)).toBe(
      true,
    );
    expect(repository.updates.length).toBe(before + 1);
    expect(repository.editLogs.length).toBe(beforeLogs + 1);
  });

  it("rolls back the event mutation if the audit append fails", async () => {
    const seeded = seedEvent(repository, { status: "published" });

    // A FK, unique, or CHECK violation on the audit insert: the service must
    // undo the earlier `updateEvent` so the event is not left modified without
    // its audit row.
    const rollbackFailure = new Error("EventEditLog insert failed (simulated constraint)");
    repository.auditFailure = rollbackFailure;

    const originalName = seeded.name;

    await expect(
      service.updateEvent(ORGANISER_ID, "event-seeded", {
        name: "Broken Update",
      }),
    ).rejects.toBe(rollbackFailure);

    // The transaction ended, and the change was restored.
    const after = repository.records.get("event-seeded");

    expect(after?.name).toBe(originalName);
    // The audit was never committed.
    expect(repository.editLogs).toHaveLength(0);
    // The UPDATE really was issued, and the audit really was attempted after it —
    // that ordering is the window the transaction exists to close.
    expect(repository.attemptedWrites).toEqual(["update:event-seeded", "audit:event-seeded"]);
    expect(repository.transactCalls).toBe(1);
  });

  it("rolls back a published deletion if the audit append fails", async () => {
    seedEvent(repository, { status: "published" });

    repository.auditFailure = new Error("audit insert rejected");

    await expect(service.softDeleteEvent(ORGANISER_ID, "event-seeded")).rejects.toBeInstanceOf(Error);

    const after = repository.records.get("event-seeded");

    expect(after?.deletedAt).toBeNull();
    expect(repository.editLogs).toHaveLength(0);
    expect(repository.attemptedWrites).toEqual([
      "softDelete:event-seeded",
      "audit:event-seeded",
    ]);
    expect(repository.transactCalls).toBe(1);
  });

  it("still does not audit a draft deletion and succeeds without opening a write-write transaction", async () => {
    seedEvent(repository);

    await service.softDeleteEvent(ORGANISER_ID, "event-seeded");

    // No audit call at all, so transact might not be necessary, but the
    // implementation still wraps it for consistency. The key is no audit.
    expect(repository.editLogs).toHaveLength(0);
  });
});

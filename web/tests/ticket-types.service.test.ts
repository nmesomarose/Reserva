import { beforeEach, describe, expect, it } from "vitest";

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/domain/errors";
import type { EventRecord, PageRequest, TicketTypeRecord } from "@/domain/events/event";
import type { EventRepository } from "@/domain/events/event.repository";
import {
  availableQuantity,
  holdExpiresAt,
  HOLD_WINDOW_MINUTES,
  type CreateTicketTypeCommand,
  type TicketTypePatch,
} from "@/domain/tickets/ticket-type";
import type {
  CreateTicketTypeRecord,
  ListTicketTypesQuery,
  TicketTypeRepository,
  UpdateTicketTypeRecord,
} from "@/domain/tickets/ticket-type.repository";
import { TicketTypeService } from "@/domain/tickets/ticket-type.service";

/**
 * Tier business rules against an in-memory repository (AGENTS.md §4).
 *
 * The rules proven here are the ones a database cannot be asked about: which
 * outcome maps to which error code, that ownership is checked before any write is
 * attempted, that a no-op PATCH writes nothing, and that a counter move is refused
 * rather than silently ignored.
 *
 * What the fake deliberately CANNOT prove is stated at each place it matters, and is
 * proven in `ticket-types.db.test.ts` instead: the atomicity of the counter
 * statements, the `UNIQUE(event_id, name)` index, and the CHECK that refuses a
 * `quantity_total` reduction. The fake models those outcomes so the *service's*
 * handling of them is testable; it is not evidence they happen.
 */

const ORGANISER_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ORGANISER_ID = "22222222-2222-2222-2222-222222222222";
const EVENT_ID = "33333333-3333-3333-3333-333333333333";
const OTHER_EVENT_ID = "44444444-4444-4444-4444-444444444444";

const TIER_ID = "55555555-5555-5555-5555-555555555555";
const OTHER_TIER_ID = "66666666-6666-6666-6666-666666666666";

const CREATED_AT = new Date("2026-09-26T12:00:00Z");
const UPDATED_AT = new Date("2026-09-26T13:00:00Z");

const COMMAND: CreateTicketTypeCommand = {
  name: "General Admission",
  description: "Standing entry, unreserved seating.",
  priceMinorUnits: 5_000,
  currency: "NGN",
  quantityTotal: 100,
};

const PAGE: PageRequest = { page: 1, pageSize: 20 };

/** A tier record with the counters a test needs, defaulting to a full tier. */
function tier(overrides: Partial<TicketTypeRecord> = {}): TicketTypeRecord {
  return {
    id: TIER_ID,
    eventId: EVENT_ID,
    name: COMMAND.name,
    description: COMMAND.description,
    priceMinorUnits: COMMAND.priceMinorUnits,
    currency: COMMAND.currency,
    quantityTotal: COMMAND.quantityTotal,
    quantityConfirmed: 0,
    quantityHeld: 0,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

const eventRow = (id: string, organiserId: string): EventRecord => ({
  id,
  organiserId,
  name: "Jazz Night",
  slug: `jazz-${id.slice(0, 4)}`,
  description: null,
  startsAt: new Date("2026-10-01T18:00:00Z"),
  endsAt: new Date("2026-10-01T22:00:00Z"),
  venue: "The Blue Room",
  status: "draft",
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  deletedAt: null,
});

/**
 * An `EventRepository` exposing only the read the tier slice performs.
 *
 * The proxy turns any *other* method into a loud failure, so if a future change
 * starts depending on a second event operation the test says so instead of
 * silently returning `undefined`.
 */
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

      throw new Error(
        `EventRepository.${String(property)} was called, but this slice must only read ` +
          `findEventById for ownership. Add a stub if that is now required.`,
      );
    },
  });
}

class FakeTicketTypeRepository implements TicketTypeRepository {
  readonly records = new Map<string, TicketTypeRecord>();
  readonly created: CreateTicketTypeRecord[] = [];
  readonly updates: UpdateTicketTypeRecord[] = [];
  readonly deleted: string[] = [];
  /** Every counter call in order, so a test can assert a write was never attempted. */
  readonly counterCalls: Array<{ readonly move: string; readonly quantity: number }> = [];

  /**
   * Tiers that a `Registration` still references.
   *
   * Models `Registration.ticket_type_id ON DELETE RESTRICT` (PRD §7.2) so the
   * service's handling of the refusal is testable without inventing registration
   * rows in this slice.
   */
  restrictedTierIds = new Set<string>();

  private nextId = 1;

  async transact<T>(work: (repository: TicketTypeRepository) => Promise<T>): Promise<T> {
    return work(this);
  }

  async createTicketType(input: CreateTicketTypeRecord): Promise<TicketTypeRecord> {
    this.created.push(input);

    const clash = [...this.records.values()].find(
      (existing) => existing.eventId === input.eventId && existing.name === input.command.name,
    );

    if (clash !== undefined) {
      // Models the `ticket_types_event_id_name_key` unique index, which is the real
      // arbiter. A pre-flight existence check in the service would be a
      // check-then-act race (rule 07), so there is deliberately no `nameExists` here.
      throw new ConflictError("This event already has a ticket tier with that name.");
    }

    const row = tier({
      id: `tier-${this.nextId++}`,
      eventId: input.eventId,
      name: input.command.name,
      description: input.command.description,
      priceMinorUnits: input.command.priceMinorUnits,
      currency: input.command.currency,
      quantityTotal: input.command.quantityTotal,
      // Counters start at the column default, not at a value the service chose.
      quantityConfirmed: 0,
      quantityHeld: 0,
    });

    this.records.set(row.id, row);

    return row;
  }

  async findTicketTypeById(id: string): Promise<TicketTypeRecord | null> {
    return this.records.get(id) ?? null;
  }

  async updateTicketType(input: UpdateTicketTypeRecord): Promise<TicketTypeRecord> {
    this.updates.push(input);

    const existing = this.records.get(input.id);

    if (existing === undefined) {
      throw new Error(`updateTicketType: no tier ${input.id}`);
    }

    // Models the CHECK, which is what actually decides an illegal reduction
    // (skill step 9). The adapter turns this rejection into a `400` naming the
    // field; modelled here so the service's pass-through of it is testable.
    const quantityTotal = input.changes.quantityTotal ?? existing.quantityTotal;
    const committed = existing.quantityConfirmed + existing.quantityHeld;

    if (quantityTotal < committed) {
      throw new ValidationError("The request body failed validation.", {
        quantityTotal: [
          `Cannot be below the ${committed} unit(s) already confirmed or held.`,
        ],
      });
    }

    const updated: TicketTypeRecord = { ...existing, ...input.changes, updatedAt: UPDATED_AT };
    this.records.set(updated.id, updated);

    return updated;
  }

  async deleteTicketType(id: string): Promise<void> {
    if (this.restrictedTierIds.has(id)) {
      // Models the `ON DELETE RESTRICT` refusal; the adapter reports it as `409`.
      throw new ConflictError("This ticket tier cannot be deleted while registrations reference it.");
    }

    this.deleted.push(id);
    this.records.delete(id);
  }

  async listTicketTypes(query: ListTicketTypesQuery) {
    const matching = [...this.records.values()]
      .filter((row) => row.eventId === query.eventId)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

    const start = (query.page - 1) * query.pageSize;

    return {
      items: matching.slice(start, start + query.pageSize),
      total: matching.length,
    };
  }

  async holdInventory(id: string, quantity: number): Promise<TicketTypeRecord | null> {
    this.counterCalls.push({ move: "hold", quantity });

    return this.move(id, (row) => {
      if (row.quantityConfirmed + row.quantityHeld + quantity > row.quantityTotal) {
        return null;
      }

      return { ...row, quantityHeld: row.quantityHeld + quantity };
    });
  }

  async releaseInventory(id: string, quantity: number): Promise<TicketTypeRecord | null> {
    this.counterCalls.push({ move: "release", quantity });

    return this.move(id, (row) => {
      if (row.quantityHeld < quantity) {
        return null;
      }

      return { ...row, quantityHeld: row.quantityHeld - quantity };
    });
  }

  async confirmInventory(id: string, quantity: number): Promise<TicketTypeRecord | null> {
    this.counterCalls.push({ move: "confirm", quantity });

    // Both counters in one step, mirroring the single-statement requirement: a
    // two-step version would expose a window where the units are neither held nor
    // confirmed, and the sum CHECK cannot see it.
    return this.move(id, (row) => {
      if (row.quantityHeld < quantity) {
        return null;
      }

      return {
        ...row,
        quantityConfirmed: row.quantityConfirmed + quantity,
        quantityHeld: row.quantityHeld - quantity,
      };
    });
  }

  private move(
    id: string,
    apply: (row: TicketTypeRecord) => TicketTypeRecord | null,
  ): TicketTypeRecord | null {
    const existing = this.records.get(id);

    if (existing === undefined) {
      throw new Error(`counter move: no tier ${id}`);
    }

    const updated = apply(existing);

    if (updated !== null) {
      this.records.set(id, { ...updated, updatedAt: UPDATED_AT });
    }

    return updated;
  }
}

function setup(events: readonly EventRecord[] = [eventRow(EVENT_ID, ORGANISER_ID)]) {
  const tiers = new FakeTicketTypeRepository();
  const service = new TicketTypeService(eventRepository(events), tiers);

  return { service, tiers };
}

describe("TicketTypeService.createTicketType", () => {
  let fixture: ReturnType<typeof setup>;
  let tiers: FakeTicketTypeRepository;

  beforeEach(() => {
    fixture = setup();
    tiers = fixture.tiers;
  });

  it("creates a tier on an owned event and returns the organiser projection", async () => {
    const dto = await fixture.service.createTicketType(ORGANISER_ID, EVENT_ID, COMMAND);

    expect(dto).toMatchObject({
      name: COMMAND.name,
      description: COMMAND.description,
      price_minor_units: 5_000,
      currency: "NGN",
      quantity_total: 100,
      quantity_confirmed: 0,
      quantity_held: 0,
      available: 100,
    });
  });

  it("starts both counters at zero, leaving the choice to the column default", async () => {
    const dto = await fixture.service.createTicketType(ORGANISER_ID, EVENT_ID, COMMAND);

    // A service that initialised inventory itself would be asserting a business
    // fact the schema already owns.
    expect(tiers.records.get(dto.id)?.quantityHeld).toBe(0);
    expect(tiers.records.get(dto.id)?.quantityConfirmed).toBe(0);
  });

  it("omits event_id from the response: the path already names the event", async () => {
    const dto = await fixture.service.createTicketType(ORGANISER_ID, EVENT_ID, COMMAND);

    // PRD §13/rule 06: an allow-list, so a field with no reader is not shipped.
    expect(Object.keys(dto)).not.toContain("event_id");
  });

  it("refuses an unknown event with 404", async () => {
    await expect(
      fixture.service.createTicketType(ORGANISER_ID, "no-such-event", COMMAND),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses another organiser's event with 403 and writes nothing", async () => {
    const promise = fixture.service.createTicketType(OTHER_ORGANISER_ID, EVENT_ID, COMMAND);

    await expect(promise).rejects.toBeInstanceOf(ForbiddenError);
    // Ownership first: a foreign event must not even reach the insert, or a caller
    // could use an insert error to probe for a tier name on somebody else's event.
    expect(tiers.created).toHaveLength(0);
  });

  it("surfaces a duplicate name on the same event as 409", async () => {
    await fixture.service.createTicketType(ORGANISER_ID, EVENT_ID, COMMAND);

    await expect(
      fixture.service.createTicketType(ORGANISER_ID, EVENT_ID, COMMAND),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("allows the same tier name on a different event", async () => {
    const { service, tiers } = setup([
      eventRow(EVENT_ID, ORGANISER_ID),
      eventRow(OTHER_EVENT_ID, ORGANISER_ID),
    ]);

    await service.createTicketType(ORGANISER_ID, EVENT_ID, COMMAND);
    const second = await service.createTicketType(ORGANISER_ID, OTHER_EVENT_ID, COMMAND);

    // The unique index is (event_id, name), not name alone: per-event tier names
    // are how a venue lists "General Admission" at several of its events.
    expect(second.id).not.toBe("");
    expect(tiers.records.size).toBe(2);
  });
});

describe("TicketTypeService.listTicketTypes", () => {
  it("returns the pagination envelope for an owned event", async () => {
    const { service, tiers } = setup();
    tiers.records.set("a", tier({ id: "a", name: "Alpha" }));
    tiers.records.set("b", tier({ id: "b", name: "Beta" }));

    const page = await service.listTicketTypes(ORGANISER_ID, EVENT_ID, PAGE);

    expect(page).toEqual({
      data: [
        expect.objectContaining({ id: "a", name: "Alpha" }),
        expect.objectContaining({ id: "b", name: "Beta" }),
      ],
      page: 1,
      page_size: 20,
      total: 2,
    });
  });

  it("orders by name so paging cannot repeat or drop a row", async () => {
    const { service, tiers } = setup();
    for (const name of ["Zulu", "alpha", "Mike", "Bravo"]) {
      tiers.records.set(name, tier({ id: name, name }));
    }

    const page = await service.listTicketTypes(ORGANISER_ID, EVENT_ID, PAGE);

    expect(page.data.map((row) => row.name)).toEqual(["alpha", "Bravo", "Mike", "Zulu"]);
  });

  it("returns an empty page rather than 404 for an event with no tiers", async () => {
    const { service } = setup();

    const page = await service.listTicketTypes(ORGANISER_ID, EVENT_ID, PAGE);

    expect(page.data).toEqual([]);
    expect(page.total).toBe(0);
  });

  it("scopes the result to the event in the path", async () => {
    const { service, tiers } = setup();
    tiers.records.set("mine", tier({ id: "mine", name: "Mine" }));
    tiers.records.set("theirs", tier({ id: "theirs", name: "Theirs", eventId: OTHER_EVENT_ID }));

    const page = await service.listTicketTypes(ORGANISER_ID, EVENT_ID, PAGE);

    expect(page.data.map((row) => row.id)).toEqual(["mine"]);
  });

  it("refuses to list another organiser's event", async () => {
    const { service, tiers } = setup([eventRow(EVENT_ID, OTHER_ORGANISER_ID)]);
    tiers.records.set("a", tier({ id: "a" }));

    await expect(service.listTicketTypes(ORGANISER_ID, EVENT_ID, PAGE)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("exposes numeric available to the organiser", async () => {
    const { service, tiers } = setup();
    tiers.records.set("a", tier({ id: "a", quantityTotal: 10, quantityHeld: 3 }));

    const page = await service.listTicketTypes(ORGANISER_ID, EVENT_ID, PAGE);

    // The public tier DTO reduces this to a boolean; an organiser needs the number
    // to know which quantity_total reductions are legal.
    expect(page.data[0]?.available).toBe(7);
  });
});

describe("TicketTypeService.updateTicketType", () => {
  let fixture: ReturnType<typeof setup>;
  let tiers: FakeTicketTypeRepository;

  beforeEach(() => {
    fixture = setup();
    tiers = fixture.tiers;
    tiers.records.set(TIER_ID, tier());
  });

  it("merges a sparse patch, leaving absent fields alone", async () => {
    const updated = await fixture.service.updateTicketType(ORGANISER_ID, EVENT_ID, TIER_ID, {
      priceMinorUnits: 7_500,
    });

    expect(updated).toMatchObject({
      name: COMMAND.name,
      description: COMMAND.description,
      price_minor_units: 7_500,
      currency: "NGN",
      quantity_total: 100,
    });
  });

  it("clears a description only on an explicit null", async () => {
    const updated = await fixture.service.updateTicketType(ORGANISER_ID, EVENT_ID, TIER_ID, {
      description: null,
    });

    expect(updated.description).toBeNull();
  });

  it("writes nothing and does not bump updated_at for a no-op patch", async () => {
    const before = tiers.records.get(TIER_ID);

    const updated = await fixture.service.updateTicketType(ORGANISER_ID, EVENT_ID, TIER_ID, {
      name: COMMAND.name,
      priceMinorUnits: COMMAND.priceMinorUnits,
    });

    // updated_at is supposed to say when the tier last actually changed. A PATCH
    // that rewrote identical values would make it a lie.
    expect(tiers.updates).toHaveLength(0);
    expect(updated.updated_at).toBe(before?.updatedAt.toISOString());
  });

  it("refuses to patch a tier belonging to a different event", async () => {
    const { service, tiers: otherTiers } = setup();
    otherTiers.records.set("foreign", tier({ id: "foreign", eventId: OTHER_EVENT_ID }));

    await expect(
      service.updateTicketType(ORGANISER_ID, EVENT_ID, "foreign", { name: "Hijacked" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(otherTiers.updates).toHaveLength(0);
  });

  it("refuses an unknown tier id", async () => {
    await expect(
      fixture.service.updateTicketType(ORGANISER_ID, EVENT_ID, OTHER_TIER_ID, { name: "X" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses to patch through another organiser's event", async () => {
    const foreign = setup([eventRow(EVENT_ID, OTHER_ORGANISER_ID)]);
    foreign.tiers.records.set(TIER_ID, tier());

    await expect(
      foreign.service.updateTicketType(ORGANISER_ID, EVENT_ID, TIER_ID, { name: "X" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("cannot write the inventory counters through a patch", async () => {
    // The write set has no `quantityConfirmed`/`quantityHeld` at all, so there is
    // nothing for a patch to smuggle them into. Proven against the type by the
    // compiler; proven at runtime here by the shape of what reached the adapter.
    const patch: TicketTypePatch = { quantityTotal: 50 };

    await fixture.service.updateTicketType(ORGANISER_ID, EVENT_ID, TIER_ID, patch);

    expect(Object.keys(tiers.updates[0]?.changes ?? {})).toEqual(["quantityTotal"]);
  });

  it("lets the database refuse a quantity_total below committed stock", async () => {
    tiers.records.set(
      TIER_ID,
      tier({ quantityTotal: 100, quantityConfirmed: 60, quantityHeld: 20 }),
    );

    const promise = fixture.service.updateTicketType(ORGANISER_ID, EVENT_ID, TIER_ID, {
      quantityTotal: 50,
    });

    await expect(promise).rejects.toBeInstanceOf(ValidationError);
    // The service deliberately does NOT pre-check this: skill step 9 requires the
    // CHECK to be the arbiter, and a pre-check would be a second rule free to
    // disagree with the first. Proof it reached the adapter at all is that the
    // adapter's call is on record.
    expect(tiers.updates).toHaveLength(1);
    expect(tiers.records.get(TIER_ID)?.quantityTotal).toBe(100);
  });

  it("allows a reduction to exactly the committed total", async () => {
    tiers.records.set(TIER_ID, tier({ quantityTotal: 100, quantityConfirmed: 60, quantityHeld: 20 }));

    const updated = await fixture.service.updateTicketType(ORGANISER_ID, EVENT_ID, TIER_ID, {
      quantityTotal: 80,
    });

    expect(updated.quantity_total).toBe(80);
    expect(updated.available).toBe(0);
  });
});

describe("TicketTypeService.deleteTicketType", () => {
  let fixture: ReturnType<typeof setup>;
  let tiers: FakeTicketTypeRepository;

  beforeEach(() => {
    fixture = setup();
    tiers = fixture.tiers;
    tiers.records.set(TIER_ID, tier());
  });

  it("removes an unreferenced tier", async () => {
    await fixture.service.deleteTicketType(ORGANISER_ID, EVENT_ID, TIER_ID);

    expect(tiers.deleted).toEqual([TIER_ID]);
    expect(tiers.records.has(TIER_ID)).toBe(false);
  });

  it("answers 409 when a registration still references the tier", async () => {
    tiers.restrictedTierIds.add(TIER_ID);

    await expect(
      fixture.service.deleteTicketType(ORGANISER_ID, EVENT_ID, TIER_ID),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(tiers.deleted).toEqual([]);
  });

  it("refuses to delete a tier of a different event", async () => {
    const { service, tiers: otherTiers } = setup();
    otherTiers.records.set("foreign", tier({ id: "foreign", eventId: OTHER_EVENT_ID }));

    await expect(
      service.deleteTicketType(ORGANISER_ID, EVENT_ID, "foreign"),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(otherTiers.deleted).toEqual([]);
  });

  it("refuses to delete through another organiser's event", async () => {
    const foreign = setup([eventRow(EVENT_ID, OTHER_ORGANISER_ID)]);
    foreign.tiers.records.set(TIER_ID, tier());

    await expect(
      foreign.service.deleteTicketType(ORGANISER_ID, EVENT_ID, TIER_ID),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(foreign.tiers.deleted).toEqual([]);
  });
});

describe("§9.3 inventory transitions", () => {
  let fixture: ReturnType<typeof setup>;
  let tiers: FakeTicketTypeRepository;

  beforeEach(() => {
    fixture = setup();
    tiers = fixture.tiers;
  });

  it("moves AVAILABLE to HELD and lowers availability by exactly the amount", async () => {
    tiers.records.set(TIER_ID, tier({ quantityTotal: 10, quantityHeld: 2 }));

    const held = await fixture.service.holdInventory(TIER_ID, 3);

    expect(held.quantityHeld).toBe(5);
    expect(availableQuantity(held)).toBe(5);
  });

  it("answers 409 when the tier cannot supply the units", async () => {
    tiers.records.set(TIER_ID, tier({ quantityTotal: 10, quantityConfirmed: 8, quantityHeld: 2 }));

    await expect(fixture.service.holdInventory(TIER_ID, 1)).rejects.toBeInstanceOf(ConflictError);
  });

  it("allows a hold of exactly the last remaining unit", async () => {
    tiers.records.set(TIER_ID, tier({ quantityTotal: 10, quantityConfirmed: 7, quantityHeld: 2 }));

    const held = await fixture.service.holdInventory(TIER_ID, 1);

    expect(availableQuantity(held)).toBe(0);
  });

  it("moves HELD back to AVAILABLE on release", async () => {
    tiers.records.set(TIER_ID, tier({ quantityTotal: 10, quantityHeld: 4, quantityConfirmed: 2 }));

    const released = await fixture.service.releaseInventory(TIER_ID, 4);

    expect(released.quantityHeld).toBe(0);
    expect(availableQuantity(released)).toBe(8);
  });

  it("answers 409 when releasing more than is held", async () => {
    tiers.records.set(TIER_ID, tier({ quantityTotal: 10, quantityHeld: 2 }));

    await expect(fixture.service.releaseInventory(TIER_ID, 3)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("moves HELD to CONFIRMED in one step", async () => {
    tiers.records.set(TIER_ID, tier({ quantityTotal: 10, quantityHeld: 4, quantityConfirmed: 1 }));

    const confirmed = await fixture.service.confirmInventory(TIER_ID, 3);

    expect(confirmed.quantityConfirmed).toBe(4);
    expect(confirmed.quantityHeld).toBe(1);
    // Confirmation does not create or destroy availability: it changes who holds
    // the units, so a held-then-confirmed sale is still one sold seat.
    expect(availableQuantity(confirmed)).toBe(5);
  });

  it("answers 409 when confirming more than is held", async () => {
    tiers.records.set(TIER_ID, tier({ quantityTotal: 10, quantityHeld: 2 }));

    await expect(fixture.service.confirmInventory(TIER_ID, 3)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("refuses a counter move of zero, a negative, or a fraction before writing", async () => {
    for (const quantity of [0, -1, 1.5, Number.NaN]) {
      await expect(fixture.service.holdInventory(TIER_ID, quantity)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }

    // `held - 0` would satisfy every CHECK and succeed, which is the danger: a
    // silent no-op that looks successful is how a registration ends up recorded as
    // holding stock it does not hold.
    expect(tiers.counterCalls).toHaveLength(0);
  });

  it("holds inventory without an organiser identity", async () => {
    tiers.records.set(TIER_ID, tier({ quantityTotal: 10 }));

    // A public attendee causes a hold, so requiring an organiser here would make
    // the rule unimplementable. What authorises it is the conditional statement,
    // not an identity check.
    const held = await fixture.service.holdInventory(TIER_ID, 1);

    expect(held.quantityHeld).toBe(1);
  });
});

describe("the 15-minute hold window", () => {
  it("is 15 minutes", () => {
    expect(HOLD_WINDOW_MINUTES).toBe(15);
  });

  it("expires a hold exactly 15 minutes after it is taken", () => {
    const taken = new Date("2026-09-26T12:00:00Z");

    expect(holdExpiresAt(taken).toISOString()).toBe("2026-09-26T12:15:00.000Z");
  });

  it("does not mutate the instant it was given", () => {
    const taken = new Date("2026-09-26T12:00:00Z");

    holdExpiresAt(taken);

    // Returning the same Date would let a caller advance the expiry by reading it.
    expect(taken.toISOString()).toBe("2026-09-26T12:00:00.000Z");
  });
});

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EventService } from "@/domain/events/event.service";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/domain/errors";
import {
  availableQuantity,
  type CreateTicketTypeCommand,
} from "@/domain/tickets/ticket-type";
import { TicketTypeService } from "@/domain/tickets/ticket-type.service";
import { prisma } from "@/server/db/client";
import { PrismaEventRepository } from "@/server/db/event.repository";
import { PrismaTicketTypeRepository } from "@/server/db/ticket-type.repository";

/**
 * Tier integration tests against real PostgreSQL.
 *
 * The service tests prove the rules with a fake repository. These prove the claims a
 * fake structurally cannot, and every one of them is a claim the implementation
 * makes in a comment:
 *
 *   - the conditional `UPDATE` really is one statement, so the last-unit race is
 *     resolved by the database and not by timing;
 *   - the `UNIQUE(event_id, name)` index, not application code, produces the 409;
 *   - the CHECK, not application code, refuses a `quantity_total` reduction;
 *   - `ON DELETE RESTRICT` really refuses a tier a registration references;
 *   - the raw `$queryRaw` statements return the same shape the query-builder path
 *     does, aliases and all.
 *
 * Skipped when `DATABASE_URL` is absent so the suite still runs without a database.
 * Every fixture hangs off two freshly generated organisers and is removed in
 * `afterAll`; no seed data is left behind.
 */

const RUN_ID = randomUUID();
const TAG = RUN_ID.slice(0, 8);

const ORGANISER_ID = randomUUID();
const OTHER_ORGANISER_ID = randomUUID();

const describeWithDatabase = process.env.DATABASE_URL ? describe : describe.skip;

describeWithDatabase("ticket tiers against PostgreSQL", () => {
  const events = new PrismaEventRepository(prisma);
  const tiers = new PrismaTicketTypeRepository(prisma);
  const eventService = new EventService(events);
  const service = new TicketTypeService(events, tiers);

  /** Event ids created by the fixtures, removed in `afterAll`. */
  const eventIds: string[] = [];

  /**
   * An event owned by `organiserId`, created through the real `EventService`.
   *
   * Deliberately not a raw insert: the tier slice's ownership read has to agree with
   * the slice that wrote the row, and a hand-made row would not prove that.
   */
  async function makeEvent(organiserId: string, label: string): Promise<string> {
    const event = await eventService.createEvent(organiserId, {
      name: `${label} ${TAG}`,
      description: null,
      startsAt: new Date("2026-10-01T18:00:00Z"),
      endsAt: new Date("2026-10-01T22:00:00Z"),
      venue: "The Blue Room",
    });

    eventIds.push(event.id);

    return event.id;
  }

  async function makeTier(
    organiserId: string,
    eventId: string,
    command: Partial<CreateTicketTypeCommand> = {},
  ) {
    return service.createTicketType(organiserId, eventId, {
      name: `General ${TAG}`,
      description: "Standing entry, unreserved seating.",
      priceMinorUnits: 5_000,
      currency: "NGN",
      quantityTotal: 100,
      ...command,
    });
  }

  const command = (overrides: Partial<CreateTicketTypeCommand> = {}): CreateTicketTypeCommand => ({
    name: `General ${TAG}`,
    description: "Standing entry, unreserved seating.",
    priceMinorUnits: 5_000,
    currency: "NGN",
    quantityTotal: 100,
    ...overrides,
  });

  beforeAll(async () => {
    await prisma.organiser.createMany({
      data: [
        { id: ORGANISER_ID, email: `tt-owner-${RUN_ID}@test.invalid` },
        { id: OTHER_ORGANISER_ID, email: `tt-other-${RUN_ID}@test.invalid` },
      ],
    });
  });

  afterAll(async () => {
    // Events cascade to their tiers; organisers go last because Event.organiser_id
    // is RESTRICT.
    await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
    await prisma.organiser.deleteMany({
      where: { id: { in: [ORGANISER_ID, OTHER_ORGANISER_ID] } },
    });
    await prisma.$disconnect();
  });

  describe("create", () => {
    it("leaves both counters at the column default of zero", async () => {
      const eventId = await makeEvent(ORGANISER_ID, "Defaults");

      const created = await makeTier(ORGANISER_ID, eventId);

      const stored = await prisma.ticketType.findUniqueOrThrow({ where: { id: created.id } });
      expect(stored.quantityConfirmed).toBe(0);
      expect(stored.quantityHeld).toBe(0);
      expect(stored.eventId).toBe(eventId);
    });

    it("stores an id the database generated, not one the client supplied", async () => {
      const eventId = await makeEvent(ORGANISER_ID, "Generated Id");

      const created = await makeTier(ORGANISER_ID, eventId);

      // PRD Â§7.2 defaults `id`; a service that generated one would collide with the
      // database's sequence and is not entitled to choose an identifier.
      expect(created.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it("round-trips a null description", async () => {
      const eventId = await makeEvent(ORGANISER_ID, "Null Description");

      const created = await makeTier(ORGANISER_ID, eventId, { description: null });

      expect(created.description).toBeNull();
    });

    it("refuses a lower-case currency at the database too, not only in validation", async () => {
      // Defence in depth. Normalisation to upper case is the validation layer's job
      // (and is proven in `ticket-types.validation.test.ts`), but the CHECK states
      // the same rule, so a write that bypassed the parser still cannot store a
      // lower-case code. Both layers agreeing is deliberate: AGENTS.md §5 treats a
      // rule that lives only in application code as a gap.
      const eventId = await makeEvent(ORGANISER_ID, "Lower Currency");

      await expect(
        tiers.createTicketType({
          eventId,
          command: command({ name: "Lower", currency: "gbp" }),
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("reports a name-length CHECK against the name field, not the quantity fields", async () => {
      // Proves the constraint-name mapping: a 201-character name must be blamed on
      // `name`, or the client would be sent to fix a field that was never wrong.
      const eventId = await makeEvent(ORGANISER_ID, "Bad Name");

      const promise = tiers.createTicketType({
        eventId,
        command: command({ name: "n".repeat(201) }),
      });

      await expect(promise).rejects.toMatchObject({
        issues: { name: ["Must be at most 200 characters."] },
      });
    });

    it("turns a duplicate (event_id, name) into 409 via the unique index", async () => {
      const eventId = await makeEvent(ORGANISER_ID, "Duplicate");
      await makeTier(ORGANISER_ID, eventId, { name: "Duplicate Me" });

      // The service has no pre-flight existence check, so this 409 can only have come
      // from the index itself.
      await expect(
        makeTier(ORGANISER_ID, eventId, { name: "Duplicate Me" }),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("allows the same name on a different event, as the (event_id, name) index implies", async () => {
      const first = await makeEvent(ORGANISER_ID, "Same Name A");
      const second = await makeEvent(ORGANISER_ID, "Same Name B");

      const a = await makeTier(ORGANISER_ID, first, { name: "Shared Name" });
      const b = await makeTier(ORGANISER_ID, second, { name: "Shared Name" });

      expect(a.id).not.toBe(b.id);
    });

    it("refuses another organiser's event with 403 and stores nothing", async () => {
      const eventId = await makeEvent(ORGANISER_ID, "Foreign");

      await expect(
        makeTier(OTHER_ORGANISER_ID, eventId, { name: "Foreign" }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(await prisma.ticketType.count({ where: { eventId } })).toBe(0);
    });

    it("answers 404 for an unknown event", async () => {
      await expect(
        makeTier(ORGANISER_ID, randomUUID(), { name: "Ghost" }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("update", () => {
    it("lets the CHECK refuse a quantity_total reduction below committed stock", async () => {
      const eventId = await makeEvent(ORGANISER_ID, "Reduction");
      const created = await makeTier(ORGANISER_ID, eventId, {
        name: "Reduction",
        quantityTotal: 100,
      });

      await service.holdInventory(created.id, 30);
      await service.confirmInventory(created.id, 10);

      // 40 committed. Reducing to 20 is illegal, and the service does not pre-check
      // it, so the only thing that can refuse this is the database.
      await expect(
        service.updateTicketType(ORGANISER_ID, eventId, created.id, { quantityTotal: 20 }),
      ).rejects.toBeInstanceOf(ValidationError);

      const stored = await prisma.ticketType.findUniqueOrThrow({ where: { id: created.id } });
      expect(stored.quantityTotal).toBe(100);
      expect(stored.quantityConfirmed).toBe(10);
      expect(stored.quantityHeld).toBe(20);
    });

    it("allows a reduction to exactly the committed total", async () => {
      const eventId = await makeEvent(ORGANISER_ID, "Exact Reduction");
      const created = await makeTier(ORGANISER_ID, eventId, {
        name: "Exact",
        quantityTotal: 100,
      });

      // 40 units in play: 10 confirmed and 30 still held.
      await service.holdInventory(created.id, 40);
      await service.confirmInventory(created.id, 10);

      const updated = await service.updateTicketType(ORGANISER_ID, eventId, created.id, {
        quantityTotal: 40,
      });

      expect(updated.quantity_total).toBe(40);
      expect(updated.available).toBe(0);
    });

    it("refuses a reduction one below the committed total", async () => {
      const eventId = await makeEvent(ORGANISER_ID, "One Below");
      const created = await makeTier(ORGANISER_ID, eventId, {
        name: "One Below",
        quantityTotal: 100,
      });

      await service.holdInventory(created.id, 40);
      await service.confirmInventory(created.id, 10);

      // The boundary in the other direction: 39 < 40 committed, so this must fail.
      // Without both sides of the boundary a CHECK written `<=` instead of `<` would
      // pass every rejection test above and still be wrong.
      await expect(
        service.updateTicketType(ORGANISER_ID, eventId, created.id, { quantityTotal: 39 }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("renames a tier", async () => {
      const eventId = await makeEvent(ORGANISER_ID, "Rename");
      const created = await makeTier(ORGANISER_ID, eventId, { name: "Before" });

      const updated = await service.updateTicketType(ORGANISER_ID, eventId, created.id, {
        name: "After",
      });

      expect(updated.name).toBe("After");
    });

    it("clears a description on an explicit null", async () => {
      const eventId = await makeEvent(ORGANISER_ID, "Clear Blurb");
      const created = await makeTier(ORGANISER_ID, eventId, { name: "Blurb" });

      const updated = await service.updateTicketType(ORGANISER_ID, eventId, created.id, {
        description: null,
      });

      expect(updated.description).toBeNull();
    });

    it("turns a rename onto an existing tier name into 409", async () => {
      const eventId = await makeEvent(ORGANISER_ID, "Rename Clash");
      await makeTier(ORGANISER_ID, eventId, { name: "Taken" });
      const other = await makeTier(ORGANISER_ID, eventId, { name: "Free" });

      await expect(
        service.updateTicketType(ORGANISER_ID, eventId, other.id, { name: "Taken" }),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("advances updated_at on a real change and leaves it alone on a no-op", async () => {
      const eventId = await makeEvent(ORGANISER_ID, "Timestamps");
      const created = await makeTier(ORGANISER_ID, eventId, { name: "Timestamps" });

      const before = await prisma.ticketType.findUniqueOrThrow({ where: { id: created.id } });

      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await service.updateTicketType(ORGANISER_ID, eventId, created.id, { name: "Renamed" });

      const afterChange = await prisma.ticketType.findUniqueOrThrow({ where: { id: created.id } });
      expect(afterChange.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());

      // A PATCH that rewrites identical values would make updated_at a lie about when
      // the tier last actually changed.
      await service.updateTicketType(ORGANISER_ID, eventId, created.id, { name: "Renamed" });

      const afterNoOp = await prisma.ticketType.findUniqueOrThrow({ where: { id: created.id } });
      expect(afterNoOp.updatedAt.getTime()).toBe(afterChange.updatedAt.getTime());
    });

    it("refuses a patch to a tier belonging to a different event", async () => {
      const first = await makeEvent(ORGANISER_ID, "Cross A");
      const second = await makeEvent(ORGANISER_ID, "Cross B");
      const created = await makeTier(ORGANISER_ID, first, { name: "Cross" });

      await expect(
        service.updateTicketType(ORGANISER_ID, second, created.id, { name: "Hijacked" }),
      ).rejects.toBeInstanceOf(NotFoundError);

      const stored = await prisma.ticketType.findUniqueOrThrow({ where: { id: created.id } });
      expect(stored.name).toBe("Cross");
    });
  });

  describe("delete", () => {
    it("removes a tier nothing references", async () => {
      const eventId = await makeEvent(ORGANISER_ID, "Deletable");
      const created = await makeTier(ORGANISER_ID, eventId, { name: "Deletable" });

      await service.deleteTicketType(ORGANISER_ID, eventId, created.id);

      expect(await prisma.ticketType.findUnique({ where: { id: created.id } })).toBeNull();
    });

    it("refuses a tier a registration references, as 409", async () => {
      const eventId = await makeEvent(ORGANISER_ID, "Restricted");
      const created = await makeTier(ORGANISER_ID, eventId, {
        name: "Restricted",
        quantityTotal: 5,
      });

      // A minimal Registration row, written with the model rather than raw SQL. The
      // registration slice is not implemented, so this stands in for "a registration
      // exists" using only columns PRD Â§7.2 already fixes.
      const registration = await prisma.registration.create({
        data: {
          eventId,
          ticketTypeId: created.id,
          uniqueReference: `ref-${RUN_ID}`,
          attendeeName: "Test Attendee",
          attendeeEmail: "attendee@test.invalid",
          attendeePhone: "+2340000000000",
          status: "pending_payment",
          idempotencyKey: `idem-${RUN_ID}`,
        },
      });

      try {
        // `Registration.ticket_type_id` is RESTRICT (PRD Â§7.2): sales history cannot
        // be orphaned through this route.
        await expect(
          service.deleteTicketType(ORGANISER_ID, eventId, created.id),
        ).rejects.toBeInstanceOf(ConflictError);
        expect(await prisma.ticketType.count({ where: { id: created.id } })).toBe(1);
      } finally {
        await prisma.registration.delete({ where: { id: registration.id } });
      }

      // With the registration gone the same delete succeeds, so the 409 really was
      // the foreign key and not a coincidence of the fixture.
      await service.deleteTicketType(ORGANISER_ID, eventId, created.id);
      expect(await prisma.ticketType.findUnique({ where: { id: created.id } })).toBeNull();
    });

    it("refuses to delete a tier through another organiser's event", async () => {
      const eventId = await makeEvent(ORGANISER_ID, "Foreign Delete");
      const created = await makeTier(ORGANISER_ID, eventId, { name: "Foreign Delete" });

      await expect(
        service.deleteTicketType(OTHER_ORGANISER_ID, eventId, created.id),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(await prisma.ticketType.count({ where: { id: created.id } })).toBe(1);
    });

    it("takes a tier with its event when the event goes", async () => {
      const eventId = await makeEvent(ORGANISER_ID, "Cascade");
      const created = await makeTier(ORGANISER_ID, eventId, { name: "Cascade" });

      await prisma.event.delete({ where: { id: eventId } });

      // `TicketType.event_id` is CASCADE (PRD Â§7.2), so removing the event must not
      // leave an orphan tier that no organiser can ever delete through the API.
      expect(await prisma.ticketType.findUnique({ where: { id: created.id } })).toBeNull();
    });
  });

  describe("list", () => {
    it("returns the event's tiers in a stable order", async () => {
      const eventId = await makeEvent(ORGANISER_ID, "Paging");
      for (const name of ["Zulu", "Alpha", "Mike"]) {
        await makeTier(ORGANISER_ID, eventId, { name });
      }

      const first = await service.listTicketTypes(ORGANISER_ID, eventId, { page: 1, pageSize: 2 });
      const second = await service.listTicketTypes(ORGANISER_ID, eventId, { page: 2, pageSize: 2 });

      expect(first.total).toBe(3);
      expect(first.data.map((row) => row.name)).toEqual(["Alpha", "Mike"]);
      expect(second.data.map((row) => row.name)).toEqual(["Zulu"]);
    });

    it("returns the same page twice, so paging cannot repeat or drop a row", async () => {
      const eventId = await makeEvent(ORGANISER_ID, "Stable");
      for (const name of ["Delta", "Charlie", "Bravo", "Echo", "Alpha"]) {
        await makeTier(ORGANISER_ID, eventId, { name });
      }

      const a = await service.listTicketTypes(ORGANISER_ID, eventId, { page: 2, pageSize: 2 });
      const b = await service.listTicketTypes(ORGANISER_ID, eventId, { page: 2, pageSize: 2 });

      expect(a.data.map((row) => row.id)).toEqual(b.data.map((row) => row.id));
    });

    it("counts only the tiers of the event in the path", async () => {
      const eventA = await makeEvent(ORGANISER_ID, "Count A");
      const eventB = await makeEvent(ORGANISER_ID, "Count B");

      await makeTier(ORGANISER_ID, eventA, { name: "Only A" });
      await makeTier(ORGANISER_ID, eventB, { name: "Only B" });

      const page = await service.listTicketTypes(ORGANISER_ID, eventA, { page: 1, pageSize: 20 });

      expect(page.total).toBe(1);
      expect(page.data.map((row) => row.name)).toEqual(["Only A"]);
    });

    it("returns an empty page for an event with no tiers", async () => {
      const eventId = await makeEvent(ORGANISER_ID, "No Tiers");

      const page = await service.listTicketTypes(ORGANISER_ID, eventId, { page: 1, pageSize: 20 });

      expect(page.data).toEqual([]);
      expect(page.total).toBe(0);
    });

    it("refuses to list another organiser's event", async () => {
      const eventId = await makeEvent(OTHER_ORGANISER_ID, "Foreign List");
      await makeTier(OTHER_ORGANISER_ID, eventId, { name: "Hidden" });

      await expect(
        service.listTicketTypes(ORGANISER_ID, eventId, { page: 1, pageSize: 20 }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("exposes counters to the organiser but no event_id", async () => {
      const eventId = await makeEvent(ORGANISER_ID, "Counters");
      const created = await makeTier(ORGANISER_ID, eventId, {
        name: "Counters",
        quantityTotal: 10,
      });
      await service.holdInventory(created.id, 3);

      const page = await service.listTicketTypes(ORGANISER_ID, eventId, { page: 1, pageSize: 20 });

      expect(page.data[0]).toMatchObject({
        quantity_total: 10,
        quantity_held: 3,
        quantity_confirmed: 0,
        available: 7,
      });
      expect(Object.keys(page.data[0] ?? {})).not.toContain("event_id");
    });
  });

  describe("Â§9.3 inventory transitions", () => {
    /** A tier on a fresh event, addressed by repository rather than service. */
    async function makeRawTier(quantityTotal: number, label: string): Promise<string> {
      const eventId = await makeEvent(ORGANISER_ID, label);
      const created = await tiers.createTicketType({ eventId, command: command({ quantityTotal }) });

      return created.id;
    }

    it("holds units and lowers availability by exactly the amount", async () => {
      const id = await makeRawTier(10, "Hold");

      const held = await tiers.holdInventory(id, 4);

      expect(held?.quantityHeld).toBe(4);
      expect(availableQuantity(held!)).toBe(6);
    });

    it("does not oversell, and refuses by not matching rather than by throwing", async () => {
      const id = await makeRawTier(3, "Oversell");

      const first = await tiers.holdInventory(id, 2);
      const second = await tiers.holdInventory(id, 2);

      expect(first).not.toBeNull();
      // A no-op, not an exception: this is the mechanism the last-unit race depends
      // on, and it is why the service can answer 409 instead of surfacing a 500.
      expect(second).toBeNull();

      const stored = await prisma.ticketType.findUniqueOrThrow({ where: { id } });
      expect(stored.quantityHeld).toBe(2);
    });

    it("allows a hold of exactly the last remaining unit", async () => {
      const id = await makeRawTier(3, "Last Unit");
      await tiers.holdInventory(id, 2);

      const held = await tiers.holdInventory(id, 1);

      expect(availableQuantity(held!)).toBe(0);
    });

    it("releases units back to available", async () => {
      const id = await makeRawTier(10, "Release");
      await tiers.holdInventory(id, 4);

      const released = await tiers.releaseInventory(id, 4);

      expect(released?.quantityHeld).toBe(0);
      expect(availableQuantity(released!)).toBe(10);
    });

    it("refuses a release larger than the hold instead of clamping it", async () => {
      const id = await makeRawTier(10, "Over Release");
      await tiers.holdInventory(id, 2);

      const released = await tiers.releaseInventory(id, 5);

      expect(released).toBeNull();
      const stored = await prisma.ticketType.findUniqueOrThrow({ where: { id } });
      expect(stored.quantityHeld).toBe(2);
    });

    it("confirms held units by moving both counters together", async () => {
      const id = await makeRawTier(10, "Confirm");
      await tiers.holdInventory(id, 4);

      const confirmed = await tiers.confirmInventory(id, 3);

      expect(confirmed?.quantityConfirmed).toBe(3);
      expect(confirmed?.quantityHeld).toBe(1);
      // The sum of the two counters is unchanged, so a seat that was held and then
      // confirmed is still exactly one seat sold.
      expect(availableQuantity(confirmed!)).toBe(6);
    });

    it("refuses a confirmation larger than the hold", async () => {
      const id = await makeRawTier(10, "Over Confirm");
      await tiers.holdInventory(id, 2);

      expect(await tiers.confirmInventory(id, 3)).toBeNull();
    });

    it("does not change what is sellable when a hold becomes a confirmation", async () => {
      // The whole point of the two-counter model: a seat in payment must not briefly
      // look sellable again. Availability is identical either side of the transition —
      // what changes is which counter holds the units.
      const id = await makeRawTier(10, "Round Trip");

      const held = await tiers.holdInventory(id, 3);
      const confirmed = await tiers.confirmInventory(id, 3);

      expect(availableQuantity(confirmed!)).toBe(availableQuantity(held!));
      expect(availableQuantity(confirmed!)).toBe(7);
      // And the sum of the two counters is unchanged by the transition itself.
      expect(confirmed!.quantityConfirmed + confirmed!.quantityHeld).toBe(3);
    });

    it("gives the last unit to exactly one of two concurrent holders", async () => {
      // THE race PRD Â§10 and rule 07 exist for. A read-then-write implementation
      // would let both callers observe 1 available and both write held = 1, selling
      // two units of a one-unit tier. Both statements are issued concurrently here and
      // the loser must match zero rows.
      const id = await makeRawTier(1, "Race");

      const [resultA, resultB] = await Promise.all([
        new PrismaTicketTypeRepository(prisma).holdInventory(id, 1),
        new PrismaTicketTypeRepository(prisma).holdInventory(id, 1),
      ]);

      expect([resultA, resultB].filter((row) => row !== null)).toHaveLength(1);

      const stored = await prisma.ticketType.findUniqueOrThrow({ where: { id } });
      expect(stored.quantityHeld).toBe(1);
      expect(availableQuantity(stored)).toBe(0);
    });

    it("does not exceed the total under 25 concurrent holds for 5 units", async () => {
      // A single two-way race can pass by luck; a stampede cannot. Every holder asks
      // for a unit on a tier with fewer units than holders.
      const id = await makeRawTier(5, "Stampede");

      const attempts = await Promise.all(
        Array.from({ length: 25 }, () =>
          new PrismaTicketTypeRepository(prisma).holdInventory(id, 1),
        ),
      );

      expect(attempts.filter((row) => row !== null)).toHaveLength(5);

      const stored = await prisma.ticketType.findUniqueOrThrow({ where: { id } });
      expect(stored.quantityHeld).toBe(5);
      expect(availableQuantity(stored)).toBe(0);
    });

    it("lets concurrent releases and confirms of the same hold resolve to one winner", async () => {
      // The mirror image of the race above: a hold released and confirmed at the same
      // instant must not both apply, or the units would be counted twice.
      const id = await makeRawTier(10, "Double Spend");
      await tiers.holdInventory(id, 2);

      const [released, confirmed] = await Promise.all([
        new PrismaTicketTypeRepository(prisma).releaseInventory(id, 2),
        new PrismaTicketTypeRepository(prisma).confirmInventory(id, 2),
      ]);

      const applied = [released, confirmed].filter((row) => row !== null);
      expect(applied).toHaveLength(1);

      const stored = await prisma.ticketType.findUniqueOrThrow({ where: { id } });
      // Whichever won, the 2 units are either back on sale or sold once â€” never both
      // and never neither.
      const committedOrHeld = stored.quantityConfirmed + stored.quantityHeld;
      expect(committedOrHeld).toBe(0);
    });

    it("returns the same row shape from a raw statement as from the query builder", async () => {
      // The raw statements alias their columns to camelCase by hand. If that alias
      // list drifted, `fromRow` would quietly produce `undefined` fields, which
      // surface only as a DTO with missing keys.
      const id = await makeRawTier(10, "Shape");

      const viaRaw = await tiers.holdInventory(id, 1);
      const viaBuilder = await prisma.ticketType.findUniqueOrThrow({ where: { id } });

      expect(Object.keys(viaRaw!).sort()).toEqual(Object.keys(viaBuilder).sort());
      expect(viaRaw?.id).toBe(viaBuilder.id);
      expect(viaRaw?.eventId).toBe(viaBuilder.eventId);
      expect(viaRaw?.name).toBe(viaBuilder.name);
      expect(viaRaw?.priceMinorUnits).toBe(viaBuilder.priceMinorUnits);
      expect(viaRaw?.quantityTotal).toBe(viaBuilder.quantityTotal);
      // A `string` here instead of a `Date` would produce a DTO whose timestamps are
      // already serialised in one code path and not the other.
      expect(viaRaw?.createdAt).toBeInstanceOf(Date);
    });

    it("returns null for a tier that does not exist rather than throwing", async () => {
      expect(await tiers.holdInventory(randomUUID(), 1)).toBeNull();
    });
  });
});

import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EventService } from "@/domain/events/event.service";
import { NotFoundError } from "@/domain/errors";
import { prisma } from "@/server/db/client";
import { PrismaEventRepository } from "@/server/db/event.repository";

/**
 * Integration tests for the event slice against real PostgreSQL.
 *
 * The unit tests prove the rules with a fake repository; these prove the Prisma
 * adapter and the schema actually agree — in particular the `UNIQUE(slug)`
 * index, the `status` default, and the soft-delete filter, none of which a fake
 * can exercise.
 *
 * Skipped when `DATABASE_URL` is absent so the suite still runs without a
 * database. Every fixture is created under a freshly generated organiser and
 * removed in `afterAll`; no seed data is left behind.
 */

const RUN_ID = randomUUID();
const ORGANISER_EMAIL = `events-slice-${RUN_ID}@test.invalid`;
const ORGANISER_ID = randomUUID();

const describeWithDatabase = process.env.DATABASE_URL ? describe : describe.skip;

describeWithDatabase("event CRUD against PostgreSQL", () => {
  const service = new EventService(new PrismaEventRepository(prisma));

  beforeAll(async () => {
    await prisma.organiser.create({
      data: { id: ORGANISER_ID, email: ORGANISER_EMAIL },
    });
  });

  afterAll(async () => {
    // Events cascade to their tiers and programme items; the organiser is
    // deleted last because Event.organiser_id is RESTRICT.
    await prisma.event.deleteMany({ where: { organiserId: ORGANISER_ID } });
    await prisma.organiser.deleteMany({ where: { id: ORGANISER_ID } });
    await prisma.$disconnect();
  });

  const command = (name: string) => ({
    name,
    description: "Two sets of improvised jazz.",
    startsAt: new Date("2026-10-01T18:00:00Z"),
    endsAt: new Date("2026-10-01T22:00:00Z"),
    venue: "The Blue Room",
  });

  it("creates a draft event with a slug derived from the name", async () => {
    const created = await service.createEvent(ORGANISER_ID, command(`Slug Test ${RUN_ID}`));

    const stored = await prisma.event.findUniqueOrThrow({ where: { id: created.id } });

    expect(stored.status).toBe("draft");
    expect(stored.organiserId).toBe(ORGANISER_ID);
    expect(stored.deletedAt).toBeNull();
  });

  it("stores the instant the organiser actually submitted", async () => {
    // REGRESSION GUARD. A round-trip assertion through Prisma alone is NOT
    // enough here: Prisma's write path sends the UTC wall clock as a *naive*
    // timestamp, and its read path reinterprets the server's text the same way,
    // so write-then-read is symmetric and a wrong value looks correct. On a host
    // whose PostgreSQL session zone was not UTC this stored every event one hour
    // early while every Prisma-level test still passed.
    //
    // So this asserts against ground truth read by an INDEPENDENT client, and
    // also pins the session zone, because a UTC session is what makes the two
    // paths agree in absolute terms.
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();

    try {
      const { rows: sessionRows } = await client.query(
        "select current_setting('TimeZone') as tz",
      );
      expect(sessionRows[0]?.tz).toBe("UTC");

      const created = await service.createEvent(
        ORGANISER_ID,
        command(`Instant Test ${RUN_ID}`),
      );

      const { rows } = await client.query(
        "select extract(epoch from starts_at) as starts, extract(epoch from ends_at) as ends from events where id = $1",
        [created.id],
      );

      expect(new Date(Number(rows[0]?.starts) * 1000).toISOString()).toBe(
        "2026-10-01T18:00:00.000Z",
      );
      expect(new Date(Number(rows[0]?.ends) * 1000).toISOString()).toBe(
        "2026-10-01T22:00:00.000Z",
      );
    } finally {
      await client.end();
    }
  });

  it("preserves an offset-aware input instant rather than a wall clock", async () => {
    // The public contract is tz-aware input (PRD §12/§11). 19:00+01:00 and
    // 18:00Z are the same instant and must be stored identically.
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();

    try {
      const created = await service.createEvent(ORGANISER_ID, {
        ...command(`Offset Test ${RUN_ID}`),
        startsAt: new Date("2026-10-01T19:00:00+01:00"),
        endsAt: new Date("2026-10-01T23:00:00+01:00"),
      });

      const { rows } = await client.query(
        "select extract(epoch from starts_at) as starts from events where id = $1",
        [created.id],
      );

      expect(new Date(Number(rows[0]?.starts) * 1000).toISOString()).toBe(
        "2026-10-01T18:00:00.000Z",
      );
    } finally {
      await client.end();
    }
  });

  it("reserves a colliding slug with a suffix instead of failing", async () => {
    const name = `Collision Test ${RUN_ID}`;
    const first = await service.createEvent(ORGANISER_ID, command(name));
    const second = await service.createEvent(ORGANISER_ID, command(name));

    const base = first.slug;
    expect(second.slug).toBe(`${base}-2`);

    const rows = await prisma.event.findMany({
      where: { slug: { startsWith: base } },
      select: { slug: true },
    });
    expect(rows).toHaveLength(2);
  });

  it("keeps a soft-deleted event's slug reserved, as the unique index does", async () => {
    // The UNIQUE(events_slug_key) index covers soft-deleted rows too, so the
    // availability check must as well — otherwise the insert would collide.
    const name = `Soft Delete Test ${RUN_ID}`;
    const first = await service.createEvent(ORGANISER_ID, command(name));

    await prisma.event.update({
      where: { id: first.id },
      data: { deletedAt: new Date("2026-09-27T09:00:00Z") },
    });

    const second = await service.createEvent(ORGANISER_ID, command(name));

    expect(second.slug).toBe(`${first.slug}-2`);
  });

  describe("public read visibility", () => {
    const name = `Visibility Test ${RUN_ID}`;
    let slug: string;
    let eventId: string;

    beforeAll(async () => {
      const created = await service.createEvent(ORGANISER_ID, command(name));
      slug = created.slug;
      eventId = created.id;

      await prisma.programmeItem.createMany({
        data: [
          { eventId, sortOrder: 2, time: new Date("2026-10-01T21:00:00Z"), title: "Late set" },
          { eventId, sortOrder: 1, time: null, title: "Doors", description: "Opens at six." },
        ],
      });

      await prisma.ticketType.createMany({
        data: [
          {
            eventId,
            name: "General",
            priceMinorUnits: 1_500,
            currency: "GBP",
            quantityTotal: 10,
            quantityConfirmed: 3,
            quantityHeld: 2,
          },
          {
            eventId,
            name: "Sold out",
            priceMinorUnits: 2_000,
            currency: "GBP",
            quantityTotal: 5,
            quantityConfirmed: 5,
          },
        ],
      });
    });

    it("is 404 while the event is still a draft", async () => {
      await expect(service.getPublicEvent(slug)).rejects.toThrow(NotFoundError);
    });

    it("is 200 once published, with ordered programme and derived availability", async () => {
      await prisma.event.update({ where: { id: eventId }, data: { status: "published" } });

      const dto = await service.getPublicEvent(slug);

      expect(dto.slug).toBe(slug);
      expect(dto.starts_at).toBe("2026-10-01T18:00:00.000Z");
      expect(dto.programme.map((item) => item.sort_order)).toEqual([1, 2]);
      expect(dto.programme[0]?.time).toBeNull();
      expect(dto.ticket_types).toEqual([
        { name: "General", price_minor_units: 1_500, currency: "GBP", available: true },
        { name: "Sold out", price_minor_units: 2_000, currency: "GBP", available: false },
      ]);

      // The public payload must not disclose the owning organiser.
      expect(JSON.stringify(dto)).not.toContain(ORGANISER_ID);
      expect(JSON.stringify(dto)).not.toContain("quantity_confirmed");
    });

    it("is 404 again once the event is closed", async () => {
      await prisma.event.update({ where: { id: eventId }, data: { status: "closed" } });

      await expect(service.getPublicEvent(slug)).rejects.toThrow(NotFoundError);

      await prisma.event.update({ where: { id: eventId }, data: { status: "published" } });
    });

    it("is 404 again once the event is soft-deleted", async () => {
      await prisma.event.update({
        where: { id: eventId },
        data: { deletedAt: new Date("2026-09-27T09:00:00Z") },
      });

      await expect(service.getPublicEvent(slug)).rejects.toThrow(NotFoundError);
    });
  });
});

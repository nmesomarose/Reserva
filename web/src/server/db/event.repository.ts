/**
 * Prisma implementation of the event persistence port.
 *
 * This adapter is the ONLY place that knows both Prisma and the domain event
 * types. Its job is mapping, not rules: every filter below exists either because
 * a column requires it or because the domain's `EventRepository` contract states
 * the guarantee, and all of it is re-asserted by `EventService`.
 */

import "server-only";

import type {
  Event as PrismaEventModel,
  Prisma,
  ProgrammeItem as PrismaProgrammeItemModel,
  TicketType as PrismaTicketTypeModel,
} from "@/generated/prisma/client";

import { ConflictError } from "@/domain/errors";
import type {
  EventRecord,
  EventStatus,
  PagedResult,
  ProgrammeItemInput,
  ProgrammeItemRecord,
  PublicEventAggregate,
  TicketTypeRecord,
} from "@/domain/events/event";
import type {
  AppendEditLogRecord,
  CreateEventRecord,
  EventRepository,
  ListEventsQuery,
  UpdateEventRecord,
} from "@/domain/events/event.repository";

/**
 * Prisma's code for a unique-constraint violation.
 *
 * Checked structurally rather than by importing the generated error class so the
 * adapter does not depend on Prisma's runtime error namespace staying stable.
 */
const UNIQUE_VIOLATION = "P2002";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

function toEventRecord(model: PrismaEventModel): EventRecord {
  return {
    id: model.id,
    organiserId: model.organiserId,
    name: model.name,
    slug: model.slug,
    description: model.description,
    startsAt: model.startsAt,
    endsAt: model.endsAt,
    venue: model.venue,
    status: model.status as EventStatus,
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
    deletedAt: model.deletedAt,
  };
}

function toProgrammeItemRecord(model: PrismaProgrammeItemModel): ProgrammeItemRecord {
  return {
    id: model.id,
    eventId: model.eventId,
    sortOrder: model.sortOrder,
    time: model.time,
    title: model.title,
    description: model.description,
  };
}

function toTicketTypeRecord(model: PrismaTicketTypeModel): TicketTypeRecord {
  return {
    id: model.id,
    eventId: model.eventId,
    name: model.name,
    description: model.description,
    priceMinorUnits: model.priceMinorUnits,
    currency: model.currency,
    quantityTotal: model.quantityTotal,
    quantityConfirmed: model.quantityConfirmed,
    quantityHeld: model.quantityHeld,
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
  };
}

type EventWithChildren = Prisma.EventGetPayload<{
  include: { programmeItems: true; ticketTypes: true };
}>;

export class PrismaEventRepository implements EventRepository {
  /**
   * Typed as the transaction client so the SAME class serves both the
   * pool-backed handle and a handle scoped to an open transaction. That is what
   * makes `transact` a one-liner that cannot drift: the nested handle is
   * constructed by the same adapter, so it maps rows identically and shares the
   * port contract by construction rather than by remembering to keep two classes
   * in sync.
   */
  constructor(private readonly prisma: Prisma.TransactionClient) {}

  /**
   * Product-owner decision 7 (2026-09-26): event edits and their audit rows
   * commit together or not at all.
   *
   * `$transaction` with a *callback* is the interactive form, which is required
   * here — the batch form would need the statements hoisted into an array, and
   * they cannot be: the audit's `changes` depend on the row as the update left
   * it, and the checks that decide whether to write at all depend on a read.
   *
   * `work` is handed a fresh adapter over the transaction handle. Nothing here
   * catches: an error propagates so Prisma rolls back, and re-throwing would
   * risk committing a partially-applied change.
   */
  async transact<T>(work: (repository: EventRepository) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => work(new PrismaEventRepository(tx)));
  }

  async createEvent(input: CreateEventRecord): Promise<EventRecord> {
    try {
      const created = await this.prisma.event.create({
        data: {
          organiserId: input.organiserId,
          name: input.command.name,
          slug: input.slug,
          description: input.command.description,
          startsAt: input.command.startsAt,
          endsAt: input.command.endsAt,
          venue: input.command.venue,
          // `status` is intentionally omitted: PRD §7.2 defaults it to `draft`
          // and PRD §12 does not list status among the request fields, so the
          // client can neither set nor influence it.
        },
      });

      return toEventRecord(created);
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Reachable only if two creates race past `allocateSlug` for the same
        // slug; the unique index is the real arbiter.
        throw new ConflictError("An event already uses this slug.");
      }

      throw error;
    }
  }

  async slugExists(slug: string): Promise<boolean> {
    const found = await this.prisma.event.findFirst({
      where: { slug },
      select: { id: true },
    });

    return found !== null;
  }

  async findPublicEventBySlug(slug: string): Promise<PublicEventAggregate | null> {
    // `status: published` and `deletedAt: null` are the soft-delete (§14) and
    // visibility rules. Applying them in the query means a draft event is never
    // even loaded, let alone serialised.
    const found = (await this.prisma.event.findFirst({
      where: { slug, status: "published", deletedAt: null },
      include: {
        programmeItems: { orderBy: { sortOrder: "asc" } },
        // Tier ordering is not specified by the PRD, but the response must be
        // deterministic, so it is pinned here (name, then id) rather than left
        // to the planner.
        ticketTypes: { orderBy: [{ name: "asc" }, { id: "asc" }] },
      },
    })) as EventWithChildren | null;

    if (found === null) {
      return null;
    }

    return {
      event: toEventRecord(found),
      programme: found.programmeItems.map(toProgrammeItemRecord),
      ticketTypes: found.ticketTypes.map(toTicketTypeRecord),
    };
  }

  async findEventById(id: string): Promise<EventRecord | null> {
    // Intentionally unscoped by organiser: the service must be able to tell
    // "unknown id" from "someone else's event" because those are 404 and 403.
    const found = await this.prisma.event.findUnique({ where: { id } });

    return found === null ? null : toEventRecord(found);
  }

  async updateEvent(input: UpdateEventRecord): Promise<EventRecord> {
    const updated = await this.prisma.event.update({
      where: { id: input.id },
      data: {
        ...input.changes,
        // `updated_at` is maintained here rather than by a column default: a
        // default only applies on INSERT, so without this every PATCH would
        // leave a stale timestamp.
        updatedAt: new Date(),
      },
    });

    return toEventRecord(updated);
  }

  async softDeleteEvent(id: string, deletedAt: Date): Promise<EventRecord> {
    const updated = await this.prisma.event.update({
      where: { id },
      data: { deletedAt, updatedAt: deletedAt },
    });

    return toEventRecord(updated);
  }

  async listEvents(query: ListEventsQuery): Promise<PagedResult<EventRecord>> {
    // Soft-deleted events are excluded: a deleted event is not part of the
    // organiser's working set. `organiser_id` scopes the whole thing, so no
    // caller can page through another organiser's events.
    const where = {
      organiserId: query.organiserId,
      deletedAt: null,
      ...(query.status === undefined ? {} : { status: query.status }),
    };

    // `count` must count the *filtered* set, not the table (rule 06), and both
    // queries have to share one filter or the page total lies.
    const [rows, total] = await Promise.all([
      this.prisma.event.findMany({
        where,
        orderBy: [{ startsAt: "asc" }, { id: "asc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.event.count({ where }),
    ]);

    return { items: rows.map(toEventRecord), total };
  }

  async appendEditLog(input: AppendEditLogRecord): Promise<void> {
    // `changes` is handed to Prisma as `Prisma.InputJsonValue`; the adapter is
    // the boundary where a domain shape becomes a driver payload.
    await this.prisma.eventEditLog.create({
      data: {
        eventId: input.eventId,
        organiserId: input.organiserId,
        changes: input.changes as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async listProgrammeItems(eventId: string): Promise<readonly ProgrammeItemRecord[]> {
    const rows = await this.prisma.programmeItem.findMany({
      where: { eventId },
      orderBy: { sortOrder: "asc" },
    });

    return rows.map(toProgrammeItemRecord);
  }

  async createProgrammeItem(
    eventId: string,
    input: ProgrammeItemInput,
  ): Promise<ProgrammeItemRecord> {
    const created = await this.prisma.programmeItem.create({
      data: {
        eventId,
        sortOrder: input.sortOrder,
        time: input.time,
        title: input.title,
        description: input.description,
      },
    });

    return toProgrammeItemRecord(created);
  }

  async updateProgrammeItem(
    itemId: string,
    input: ProgrammeItemInput,
  ): Promise<ProgrammeItemRecord> {
    const updated = await this.prisma.programmeItem.update({
      where: { id: itemId },
      data: {
        sortOrder: input.sortOrder,
        time: input.time,
        title: input.title,
        description: input.description,
        updatedAt: new Date(),
      },
    });

    return toProgrammeItemRecord(updated);
  }

  async deleteProgrammeItem(itemId: string): Promise<void> {
    await this.prisma.programmeItem.delete({ where: { id: itemId } });
  }
}

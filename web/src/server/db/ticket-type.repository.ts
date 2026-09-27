/**
 * Prisma implementation of the ticket-tier persistence port.
 *
 * This adapter is the only place that knows both Prisma and the domain tier types.
 * Its job is mapping plus faithful translation of database rejections into domain
 * errors — the service turns those into status codes.
 *
 * The three inventory methods use `$queryRaw` rather than the query builder, and
 * that is not a style choice: `quantity_confirmed + quantity_held + $n <=
 * quantity_total` is an expression *across columns*, which Prisma's `where` cannot
 * express at all. Writing it any other way would mean reading the row first and
 * then writing — the read-then-write shape that rule 07 and PRD §10's last-unit
 * race specifically exist to forbid. One conditional `UPDATE ... RETURNING` is the
 * only formulation where the check and the write are the same statement, so a
 * concurrent holder cannot pass the check first and overwrite afterwards.
 */

import "server-only";

import {
  Prisma,
  type TicketType as PrismaTicketTypeModel,
} from "@/generated/prisma/client";

import { ConflictError, ValidationError, type FieldIssues } from "@/domain/errors";
import type { PagedResult, TicketTypeRecord } from "@/domain/events/event";
import type {
  CreateTicketTypeRecord,
  ListTicketTypesQuery,
  TicketTypeRepository,
  UpdateTicketTypeRecord,
} from "@/domain/tickets/ticket-type.repository";

/**
 * Prisma's codes for the constraint families this adapter translates.
 *
 * Checked structurally rather than by importing Prisma's error classes, so the
 * adapter does not depend on its runtime error namespace staying stable — the same
 * reasoning as `PrismaEventRepository`.
 */
const UNIQUE_VIOLATION = "P2002";
const FOREIGN_KEY_VIOLATION = "P2003";

/**
 * CHECK-constraint violation codes, which differ by Prisma engine path.
 *
 * `P2004` is what the Rust query engine reported historically. `P2039` is what this
 * project actually gets: it runs Prisma 7 on the `@prisma/adapter-pg` *driver
 * adapter*, which passes the PostgreSQL error through to Prisma's error translation
 * as a generic "failed constraint" without the engine-specific remapping the older
 * code depended on. The nested `23514` is PostgreSQL's own `check_violation`.
 *
 * Both are accepted, and the underlying `23514` is checked as a third fallback, so
 * this keeps working whichever engine path is configured. Written as a set rather
 * than one constant because guessing wrong here is not a compile error: it is a
 * `500` where the contract promises a `400`, which is exactly the kind of bug a
 * unit test with a fake repository cannot see.
 */
const CHECK_VIOLATIONS: ReadonlySet<string> = new Set(["P2004", "P2039", "23514"]);

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;

    return typeof code === "string" ? code : undefined;
  }

  return undefined;
}

function isViolation(error: unknown, code: string): boolean {
  return errorCode(error) === code;
}

/**
 * The name of the CHECK that was violated, or `null` if this was not a CHECK failure.
 *
 * Identifies *which* rule failed rather than merely that one did, so the adapter can
 * name the offending request field. Reporting a name-length failure as a
 * `quantity_total` failure would send the client to fix the wrong field, so a
 * constraint this adapter does not recognise deliberately falls through as `null`
 * and is rethrown instead of being mislabelled.
 */
function violatedCheckName(error: unknown): string | null {
  const constraint = /violates check constraint "([^"]+)"/.exec(errorText(error));

  if (constraint !== null) {
    return constraint[1] ?? null;
  }

  return CHECK_VIOLATIONS.has(errorCode(error) ?? "") ? "" : null;
}

/** The message from anywhere in Prisma's error nesting, or `""`. */
function errorText(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return "";
  }

  const outer = "message" in error ? String((error as { message?: unknown }).message ?? "") : "";
  const meta = (error as { meta?: { driverAdapterError?: unknown } }).meta;
  const adapterCause = (
    meta?.driverAdapterError as { cause?: { originalMessage?: unknown } } | undefined
  )?.cause;

  return [outer, String(adapterCause?.originalMessage ?? "")].join("\n");
}

/**
 * Field-level detail for a CHECK the database refused.
 *
 * One entry per constraint this migration adds, mapped to the request field that
 * caused it. The two quantity rules collapse into the same message because they
 * describe one rule from the organiser's point of view: a `quantity_total` that does
 * not fit the stock already committed or held.
 */
const CHECK_FIELD_ISSUES: Readonly<Record<string, FieldIssues>> = {
  ticket_types_quantity_within_total_check: {
    quantity_total: ["Cannot be reduced below the number of units already confirmed or held."],
  },
  ticket_types_quantity_total_positive_check: {
    quantity_total: ["Must be 1 or greater."],
  },
  ticket_types_quantity_non_negative_check: {
    quantity_total: ["Cannot be reduced below the number of units already confirmed or held."],
  },
  ticket_types_name_length_check: { name: ["Must be at most 200 characters."] },
  ticket_types_description_length_check: {
    description: ["Must be at most 5000 characters."],
  },
  ticket_types_price_non_negative_check: {
    price_minor_units: ["Must be 0 or greater."],
  },
  ticket_types_currency_iso4217_check: {
    currency: ["Must be a three-letter ISO 4217 code."],
  },
};

const UNKNOWN_CHECK_ISSUES: FieldIssues = {
  quantity_total: ["Cannot be reduced below the number of units already confirmed or held."],
};

/**
 * Turn a CHECK violation into the `400` rule 06 requires, naming the field.
 *
 * `400`, not `409`: the request field is not acceptable for this tier, and the client
 * needs field-level detail to attribute the failure. Decided here and stated in the
 * skill's terms, and applied consistently — the same illegal write arriving through a
 * different path hits the same CHECK and gets the same code.
 *
 * A `null` return means the error was not a CHECK violation this adapter recognises,
 * and the caller rethrows the original error rather than inventing a `400` for a
 * failure it cannot explain.
 */
function toCheckValidationError(error: unknown): ValidationError | null {
  const check = violatedCheckName(error);

  if (check === null) {
    return null;
  }

  // `check === ""` means the failure was a CHECK violation whose name could not be
  // read from the message. The default detail is the common case (a quantity change),
  // which is still far better than letting a constraint failure become a `500`.
  return new ValidationError(
    "The request body failed validation.",
    CHECK_FIELD_ISSUES[check] ?? UNKNOWN_CHECK_ISSUES,
  );
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

/**
 * A tier row as `$queryRaw` returns it.
 *
 * A raw statement bypasses Prisma's `@map`-aware mapping, so `TIER_COLUMNS` below
 * aliases each column to the domain's camelCase name. The result is that this
 * shape is the same one the generated model produces, and `fromRow` reads names
 * the rest of the adapter already uses.
 *
 * The timestamps are declared `Date` because the driver parses `timestamptz` into
 * one, which is what the rest of the adapter's records carry — a `string` here
 * would silently produce a DTO with an ISO string where a `Date` was expected.
 */
interface TierRow {
  readonly id: string;
  readonly eventId: string;
  readonly name: string;
  readonly description: string | null;
  readonly priceMinorUnits: number;
  readonly currency: string;
  readonly quantityTotal: number;
  readonly quantityConfirmed: number;
  readonly quantityHeld: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function fromRow(row: TierRow): TicketTypeRecord {
  return {
    id: row.id,
    eventId: row.eventId,
    name: row.name,
    description: row.description,
    priceMinorUnits: row.priceMinorUnits,
    currency: row.currency,
    quantityTotal: row.quantityTotal,
    quantityConfirmed: row.quantityConfirmed,
    quantityHeld: row.quantityHeld,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The projected column list, aliased to the domain's camelCase names.
 *
 * Written once so the three raw statements cannot drift in what they return.
 */
const TIER_COLUMNS = `
  "id"                          AS "id",
  "event_id"                    AS "eventId",
  "name"                        AS "name",
  "description"                 AS "description",
  "price_minor_units"           AS "priceMinorUnits",
  "currency"                    AS "currency",
  "quantity_total"              AS "quantityTotal",
  "quantity_confirmed"          AS "quantityConfirmed",
  "quantity_held"               AS "quantityHeld",
  "created_at"                  AS "createdAt",
  "updated_at"                  AS "updatedAt"
`;

export class PrismaTicketTypeRepository implements TicketTypeRepository {
  /**
   * Typed as the transaction client so the SAME class serves the pool-backed
   * handle and a handle scoped to an open transaction — the reason `transact` is
   * a one-liner that cannot drift, identical to `PrismaEventRepository`.
   */
  constructor(private readonly prisma: Prisma.TransactionClient) {}

  async transact<T>(work: (repository: TicketTypeRepository) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => work(new PrismaTicketTypeRepository(tx)));
  }

  async createTicketType(input: CreateTicketTypeRecord): Promise<TicketTypeRecord> {
    try {
      const created = await this.prisma.ticketType.create({
        data: {
          eventId: input.eventId,
          name: input.command.name,
          description: input.command.description,
          priceMinorUnits: input.command.priceMinorUnits,
          currency: input.command.currency,
          quantityTotal: input.command.quantityTotal,
          // `quantityConfirmed` and `quantityHeld` are intentionally omitted: PRD
          // §7.2 defaults both to 0 and they move only through the §9.3
          // inventory transitions, never through a create or a PATCH.
        },
      });

      return toTicketTypeRecord(created);
    } catch (error) {
      if (isViolation(error, UNIQUE_VIOLATION)) {
        // The unique index on (event_id, name) is the arbiter — PRD §7.2,
        // AGENTS.md §5. Answering 409 here rather than pre-checking for an
        // existing name is deliberate: a pre-check has a race window, and two
        // concurrent creates of the same tier name would both pass it.
        throw new ConflictError("This event already has a ticket tier with that name.");
      }

      // Defence in depth, not a reachable path: the route validates every field
      // before the service is called, so a CHECK firing here means a validation gap
      // somewhere. It still must not become a `500` — reporting it as a `400` naming
      // the field is both correct for the client and loud in the logs.
      const checkError = toCheckValidationError(error);

      if (checkError !== null) {
        throw checkError;
      }

      throw error;
    }
  }

  async findTicketTypeById(id: string): Promise<TicketTypeRecord | null> {
    const found = await this.prisma.ticketType.findUnique({ where: { id } });

    return found === null ? null : toTicketTypeRecord(found);
  }

  async updateTicketType(input: UpdateTicketTypeRecord): Promise<TicketTypeRecord> {
    try {
      const updated = await this.prisma.ticketType.update({
        where: { id: input.id },
        data: {
          ...input.changes,
          // `updated_at` is application-maintained; a column default only applies
          // on INSERT, so without this every PATCH would leave a stale timestamp.
          updatedAt: new Date(),
        },
      });

      return toTicketTypeRecord(updated);
    } catch (error) {
      if (isViolation(error, UNIQUE_VIOLATION)) {
        throw new ConflictError("This event already has a ticket tier with that name.");
      }

      // The only CHECK an update can newly violate from *valid* stored state is
      // `quantity_total > 0` (already rejected upstream) or
      // `quantity_confirmed + quantity_held <= quantity_total` — i.e. the skill's
      // step 9 case, a reduction below committed inventory. The mapping is by
      // constraint name so a different CHECK, should one ever become reachable from
      // here, is reported against its own field instead of being blamed on
      // `quantity_total`.
      const checkError = toCheckValidationError(error);

      if (checkError !== null) {
        throw checkError;
      }

      throw error;
    }
  }

  async deleteTicketType(id: string): Promise<void> {
    try {
      await this.prisma.ticketType.delete({ where: { id } });
    } catch (error) {
      if (isViolation(error, FOREIGN_KEY_VIOLATION)) {
        // `Registration.ticket_type_id` is RESTRICT (PRD §7.2), so this is the
        // documented "RESTRICT on delete if Registrations exist". A tier with
        // sales history is a state conflict, not a bad request: the client cannot
        // fix it by changing the request, only by waiting. Hence `409`.
        throw new ConflictError(
          "This ticket tier cannot be deleted while registrations still reference it.",
        );
      }

      throw error;
    }
  }

  async listTicketTypes(query: ListTicketTypesQuery): Promise<PagedResult<TicketTypeRecord>> {
    const where = { eventId: query.eventId };

    // Ordering is pinned to (name, id) even though the PRD does not specify a
    // display order: a list whose order varies between two identical requests is
    // not a contract, and pagination over an unstable order silently drops and
    // repeats rows. `ticket_types_event_id_name_key` serves this prefix, so the
    // sort is index-backed rather than an extra sort step.
    //
    // `count` must count the filtered set, not the table (rule 06), and both
    // queries share one filter so the page total cannot lie.
    const [rows, total] = await Promise.all([
      this.prisma.ticketType.findMany({
        where,
        orderBy: [{ name: "asc" }, { id: "asc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.ticketType.count({ where }),
    ]);

    return { items: rows.map(toTicketTypeRecord), total };
  }

  async holdInventory(
    ticketTypeId: string,
    quantity: number,
  ): Promise<TicketTypeRecord | null> {
    // §9.3 AVAILABLE -> HELD. The guard and the write are ONE statement, so two
    // callers racing the last unit cannot both pass: PostgreSQL re-evaluates the
    // WHERE against the row version it is actually updating, and the loser's
    // UPDATE matches zero rows. `RETURNING` therefore yields either the tier with
    // the hold applied, or an empty array.
    const rows = await this.prisma.$queryRaw<TierRow[]>`
      UPDATE "ticket_types"
         SET "quantity_held" = "quantity_held" + ${quantity},
             "updated_at"   = now()
       WHERE "id" = ${ticketTypeId}::uuid
         AND "quantity_confirmed" + "quantity_held" + ${quantity} <= "quantity_total"
      RETURNING ${Prisma.raw(TIER_COLUMNS)}
    `;

    return rows[0] === undefined ? null : fromRow(rows[0]);
  }

  async releaseInventory(
    ticketTypeId: string,
    quantity: number,
  ): Promise<TicketTypeRecord | null> {
    // §9.3 HELD -> AVAILABLE. Guarded on `quantity_held >= quantity` so a release
    // larger than the hold matches zero rows instead of driving the counter
    // negative — the non-negative CHECK would reject it, but a rejected *statement*
    // is worse than one that simply does not apply, and this makes the losing
    // double-release a `null` the caller can treat as a lost race.
    const rows = await this.prisma.$queryRaw<TierRow[]>`
      UPDATE "ticket_types"
         SET "quantity_held" = "quantity_held" - ${quantity},
             "updated_at"   = now()
       WHERE "id" = ${ticketTypeId}::uuid
         AND "quantity_held" >= ${quantity}
      RETURNING ${Prisma.raw(TIER_COLUMNS)}
    `;

    return rows[0] === undefined ? null : fromRow(rows[0]);
  }

  async confirmInventory(
    ticketTypeId: string,
    quantity: number,
  ): Promise<TicketTypeRecord | null> {
    // §9.3 HELD -> CONFIRMED, the tier half of §8.5. Both counters move in one
    // statement: their sum is unchanged, so the CHECK cannot notice if they were
    // moved separately, and a gap between two statements would make the units
    // count as neither held nor confirmed — sellable a second time.
    const rows = await this.prisma.$queryRaw<TierRow[]>`
      UPDATE "ticket_types"
         SET "quantity_confirmed" = "quantity_confirmed" + ${quantity},
             "quantity_held"      = "quantity_held" - ${quantity},
             "updated_at"         = now()
       WHERE "id" = ${ticketTypeId}::uuid
         AND "quantity_held" >= ${quantity}
      RETURNING ${Prisma.raw(TIER_COLUMNS)}
    `;

    return rows[0] === undefined ? null : fromRow(rows[0]);
  }
}

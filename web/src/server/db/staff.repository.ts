/**
 * Prisma implementation of the staff persistence port.
 *
 * The only module that knows both Prisma and the staff domain types. Two of its
 * methods carry more weight than their size suggests, and both are about
 * concurrency rather than mapping:
 *
 *   - `searchRegistrations` is written as raw SQL rather than through Prisma's
 *     query builder because FR-17's precedence ("name primary, email/phone
 *     secondary") is an `ORDER BY` over a computed match rank, and because the
 *     latest check-in timestamp per registration is a `LATERAL` join. Expressing
 *     either in the builder would mean either losing the rank or issuing N+1 reads
 *     — and the query has a p95 target to hit (FR-18, AGENTS.md §15), so the shape
 *     that can be measured is the one worth writing.
 *   - `recordCheckIn` is the guarded write rule 07 demands: the registration is
 *     locked `FOR UPDATE` and *then* read, so the eligibility check and the
 *     "has a check-in already" read are part of the same write and two concurrent
 *     check-ins cannot both see a clean slate.
 */

import "server-only";

import type { Prisma, StaffToken as PrismaStaffTokenModel } from "@/generated/prisma/client";

import type { PagedResult } from "@/domain/events/event";
import type { RegistrationStatus } from "@/domain/registrations/registration";
import type {
  CreateStaffTokenInput,
  ListStaffTokensQuery,
  RecordCheckInInput,
  StaffRepository,
} from "@/domain/staff/staff.repository";
import {
  checkInEligible,
  type CheckInRecord,
  type RecordCheckInOutcome,
  type StaffSearchQuery,
  type StaffSearchRow,
  type StaffTokenRecord,
} from "@/domain/staff/staff";

function toStaffTokenRecord(model: PrismaStaffTokenModel): StaffTokenRecord {
  return {
    id: model.id,
    eventId: model.eventId,
    tokenHash: model.tokenHash,
    label: model.label,
    expiresAt: model.expiresAt,
    revokedAt: model.revokedAt,
    createdAt: model.createdAt,
  };
}

function toCheckInRecord(model: {
  readonly id: string;
  readonly registrationId: string;
  readonly checkedInAt: Date;
  readonly organiserId: string | null;
  readonly staffTokenId: string | null;
  readonly isOverride: boolean;
  readonly createdAt: Date;
}): CheckInRecord {
  return {
    id: model.id,
    registrationId: model.registrationId,
    checkedInAt: model.checkedInAt,
    organiserId: model.organiserId,
    staffTokenId: model.staffTokenId,
    isOverride: model.isOverride,
    createdAt: model.createdAt,
  };
}

/** One row of the staff search projection, as the SQL below returns it. */
interface SearchRow {
  readonly registration_id: string;
  readonly event_id: string;
  readonly attendee_name: string;
  readonly attendee_email: string;
  readonly attendee_phone: string;
  readonly status: RegistrationStatus;
  readonly ticket_type_id: string;
  readonly ticket_type_name: string;
  readonly latest_check_in_at: Date | null;
}

/** The registration row a check-in transaction locks, and the check-in facts it needs. */
interface LockedRegistrationRow {
  readonly event_id: string;
  readonly status: RegistrationStatus;
  readonly check_in_count: number;
  readonly first_checked_in_at: Date | null;
}

export class PrismaStaffRepository implements StaffRepository {
  /**
   * Typed as the transaction client so the same class serves the pool-backed handle
   * and a handle scoped to an open transaction — which is what makes `transact` a
   * one-liner that cannot drift (same reasoning as `PrismaEventRepository`).
   */
  constructor(private readonly prisma: Prisma.TransactionClient) {}

  /**
   * The interactive form, deliberately.
   *
   * `recordCheckIn` needs the `FOR UPDATE` read *before* it can decide whether to
   * write, and Prisma's batch form requires every statement up front. The callback
   * form is what lets the lock, the check, and the insert share one transaction.
   */
  async transact<T>(work: (repository: StaffRepository) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => work(new PrismaStaffRepository(tx)));
  }

  async createStaffToken(input: CreateStaffTokenInput): Promise<StaffTokenRecord> {
    const created = await this.prisma.staffToken.create({
      data: {
        eventId: input.eventId,
        tokenHash: input.tokenHash,
        // PRD §7.2 marks only `revoked_at` nullable, so an unlabelled token stores
        // `""` rather than `NULL` — §4.6.1's "optionally labeled" is about whether
        // the organiser supplied one. `toStaffTokenDTO` maps `""` back to `null` so
        // the wire shape has a single representation of "unlabelled".
        label: input.label ?? "",
        expiresAt: input.expiresAt,
      },
    });

    return toStaffTokenRecord(created);
  }

  /**
   * Newest first, then `id`, so paging cannot repeat or drop a row.
   *
   * `id` is the tiebreak because `created_at` is a millisecond timestamp: two tokens
   * minted in the same millisecond — which is exactly what a double-clicked
   * "issue" button produces — would otherwise order arbitrarily between pages.
   */
  async listStaffTokens(
    query: ListStaffTokensQuery,
  ): Promise<PagedResult<StaffTokenRecord>> {
    const [rows, total] = await Promise.all([
      this.prisma.staffToken.findMany({
        where: { eventId: query.eventId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.staffToken.count({ where: { eventId: query.eventId } }),
    ]);

    return { items: rows.map(toStaffTokenRecord), total };
  }

  /**
   * Revocation, once, and only ever inside the event that was authorised.
   *
   * The event id is in the `UPDATE`'s own `WHERE`, not merely checked by the caller
   * afterwards. Checking after the write is the bug this shape exists to prevent: a
   * `WHERE id = ?` alone would stamp `revoked_at` on a token belonging to a
   * different organiser's event and *then* report `404`, so a guessed token id would
   * still be able to disable someone else's staff access. Scoping the statement
   * means a refused revoke touches nothing.
   *
   * `updateMany` with a `revokedAt: null` filter is what makes it idempotent *and*
   * single-statement: the second revoke matches no rows, the count tells us the
   * stamp was already there, and the read-back below returns the original
   * `revoked_at` rather than moving it. Moving a revocation timestamp would make
   * "when was this token pulled" depend on how many times someone clicked.
   */
  async revokeStaffToken(
    eventId: string,
    id: string,
    revokedAt: Date,
  ): Promise<StaffTokenRecord | null> {
    await this.prisma.staffToken.updateMany({
      where: { id, eventId, revokedAt: null },
      data: { revokedAt },
    });

    // Read back with the same scope, so "found" can never mean "found in another
    // event". An already-revoked row in this event still comes back, which is what
    // keeps a repeat revoke idempotent rather than a 404.
    const row = await this.prisma.staffToken.findFirst({ where: { id, eventId } });

    return row === null ? null : toStaffTokenRecord(row);
  }

  /**
   * Revoked and expired tokens are returned, not filtered out.
   *
   * Part of the port contract, and the service depends on it: §4.6.3 and
   * AGENTS.md §11.2 require "this token is revoked" and "this token has expired" to
   * be reported *differently* from a generic auth failure. An adapter that filtered
   * them in the query would collapse three distinct answers into one `null` and
   * there would be nothing left to distinguish.
   */
  async findStaffTokenByTokenHash(tokenHash: string): Promise<StaffTokenRecord | null> {
    const row = await this.prisma.staffToken.findUnique({ where: { tokenHash } });

    return row === null ? null : toStaffTokenRecord(row);
  }

  /**
   * FR-17/FR-18 staff search: one event, name first, email/phone as fallback.
   *
   * Three things in the SQL are requirements rather than style:
   *
   *   1. **Scope is in the query.** `r.event_id = <the token's event>`, not a filter
   *      applied to a wider read. There is no code path in this method by which a
   *      registration from another event can enter the result set.
   *   2. **Match rank is the ordering.** `ORDER BY (attendee_name ILIKE …) DESC`
   *      puts a name hit above an email/phone hit, which is what "name primary,
   *      email/phone secondary" means operationally. A row matching both appears
   *      once, because the two alternatives are in one `OR`, not two queries.
   *   3. **One statement for the page, one for the total**, and the filter is
   *      repeated identically in both. The `total` is the count of the *filtered*
   *      set (rule 06), which is only correct if both statements agree on what
   *      "filtered" means — so the predicate lives in a shared fragment rather than
   *      being written twice.
   *
   * `LEFT JOIN LATERAL` for the latest check-in is what keeps this to a single round
   * trip per page. The staff skill's index for it —
   * `(registration_id, checked_in_at DESC)` — is a direct match, so the lateral is
   * an index lookup per row rather than a scan of the log.
   */
  async searchRegistrations(query: StaffSearchQuery): Promise<PagedResult<StaffSearchRow>> {
    const pattern = `%${escapeLikePattern(query.query)}%`;

    const rows = await this.prisma.$queryRaw<SearchRow[]>`
      SELECT
        r."id" AS registration_id,
        r."event_id",
        r."attendee_name",
        r."attendee_email",
        r."attendee_phone",
        r."status"::text AS status,
        t."id" AS ticket_type_id,
        t."name" AS ticket_type_name,
        latest."checked_in_at" AS latest_check_in_at
      FROM "registrations" r
      JOIN "ticket_types" t ON t."id" = r."ticket_type_id"
      LEFT JOIN LATERAL (
        SELECT ci."checked_in_at"
        FROM "check_ins" ci
        WHERE ci."registration_id" = r."id"
        ORDER BY ci."checked_in_at" DESC
        LIMIT 1
      ) latest ON true
      WHERE r."event_id" = ${query.eventId}::uuid
        AND (
          r."attendee_name" ILIKE ${pattern} ESCAPE '\\'
          OR r."attendee_email" ILIKE ${pattern} ESCAPE '\\'
          OR r."attendee_phone" ILIKE ${pattern} ESCAPE '\\'
        )
      ORDER BY
        (r."attendee_name" ILIKE ${pattern} ESCAPE '\\') DESC,
        r."attendee_name" ASC,
        r."id" ASC
      LIMIT ${query.pageSize}
      OFFSET ${(query.page - 1) * query.pageSize}
    `;

    const totals = await this.prisma.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM "registrations" r
      WHERE r."event_id" = ${query.eventId}::uuid
        AND (
          r."attendee_name" ILIKE ${pattern} ESCAPE '\\'
          OR r."attendee_email" ILIKE ${pattern} ESCAPE '\\'
          OR r."attendee_phone" ILIKE ${pattern} ESCAPE '\\'
        )
    `;

    return {
      items: rows.map((row) => ({
        registrationId: row.registration_id,
        eventId: row.event_id,
        attendeeName: row.attendee_name,
        attendeeEmail: row.attendee_email,
        attendeePhone: row.attendee_phone,
        status: row.status,
        ticketTypeId: row.ticket_type_id,
        ticketTypeName: row.ticket_type_name,
        latestCheckInAt: row.latest_check_in_at,
      })),
      total: totals[0]?.count ?? 0,
    };
  }

  /**
   * The guarded check-in write (rule 07, PRD §9.4, FR-21).
   *
   * The order of the three statements is the whole point, and it is inverted from
   * the intuitive one:
   *
   *   1. `SELECT … FOR UPDATE` the registration. This takes the row lock, so a
   *      second check-in for the same registration *blocks here* rather than racing
   *      through the checks below on stale data. Under READ COMMITTED it re-reads
   *      the committed row once the lock is granted, so it sees the `checked_in`
   *      status and the first check-in row that the other transaction just wrote.
   *      Rule 07: "the read of 'has a non-override check-in already exist?' must be
   *      part of the guarded write, not a prior read."
   *   2. Decide, inside the lock: eligible? already checked in? and does the caller
   *      mean it when they say `override`?
   *   3. Insert the append-only row and set the `checked_in` projection, in the
   *      same transaction (PRD §7.4). If either statement fails, the log stays
   *      unamended and the projection stays as it was.
   *
   * `is_override` is derived — `check_in_count > 0` — rather than taken from the
   * request. The request says "I intend an override"; the log says "this *was* an
   * override", and only the second one is auditable. A first check-in sent with
   * `override=true` is therefore recorded as the first check-in it actually is,
   * rather than as a meaningless "override of nothing" (the database guard in
   * `20260927000000_check_in_guards` rejects the same thing independently).
   *
   * `not_found` covers a registration that does not exist *and* one belonging to
   * another event, in the same answer. The token in hand must not be usable to
   * discover whether a given id is real in a different event (PRD §15, §18).
   *
   * The `check_ins_insert_guard` trigger is a backstop, not the mechanism: every
   * condition it checks is already decided above under the row lock. If it ever
   * fires anyway, the error propagates rather than being translated into a
   * `not_eligible` outcome — a guard tripping where it should not is a defect, and
   * reporting it as a normal business outcome would hide that.
   */
  async recordCheckIn(input: RecordCheckInInput): Promise<RecordCheckInOutcome> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<LockedRegistrationRow[]>`
        SELECT
          r."event_id",
          r."status"::text AS status,
          (
            SELECT count(*)::int FROM "check_ins" ci
            WHERE ci."registration_id" = r."id"
          ) AS check_in_count,
          (
            SELECT min(ci."checked_in_at") FROM "check_ins" ci
            WHERE ci."registration_id" = r."id"
          ) AS first_checked_in_at
        FROM "registrations" r
        WHERE r."id" = ${input.registrationId}::uuid
        FOR UPDATE
      `;

      const row = rows[0];

      // Unknown id, or an id from another event: one answer, on purpose.
      if (row === undefined || row.event_id !== input.staffTokenEventId) {
        return { kind: "not_found" } satisfies RecordCheckInOutcome;
      }

      if (!checkInEligible(row.status)) {
        return { kind: "not_eligible", status: row.status } satisfies RecordCheckInOutcome;
      }

      const alreadyCheckedIn = row.check_in_count > 0;

      if (alreadyCheckedIn && !input.command.override) {
        // §4.4.4 requires the *original* timestamp here, which is the earliest
        // check-in rather than the latest one the descending index makes cheapest.
        // A handful of rows per registration makes the ascending min() free, and
        // "when did this person actually get in" is the only useful answer.
        return {
          kind: "already_checked_in",
          originalCheckInAt: row.first_checked_in_at ?? input.checkedInAt,
        } satisfies RecordCheckInOutcome;
      }

      const created = await tx.checkIn.create({
        data: {
          registrationId: input.registrationId,
          checkedInAt: input.checkedInAt,
          // Exactly one actor column, and the other stays null — that is what
          // `check_ins_exactly_one_actor_check` requires. A staff member checking
          // in an attendee is not also the organiser, however much they outrank them.
          staffTokenId: input.staffTokenId,
          isOverride: alreadyCheckedIn,
        },
      });

      await tx.registration.update({
        where: { id: input.registrationId },
        // A no-op write when this is an override (`checked_in` -> `checked_in`), and
        // the lifecycle trigger allows `NEW.status = OLD.status` so an override does
        // not trip the forbidden-transition guards.
        data: { status: "checked_in" },
      });

      return {
        kind: "recorded",
        checkIn: toCheckInRecord(created),
        status: "checked_in",
      } satisfies RecordCheckInOutcome;
    });
  }
}

/**
 * Neutralise the LIKE metacharacters in a user's search text.
 *
 * Without this, a door volunteer typing `%` or `_` searches for a pattern instead of
 * for what they typed. A backslash is escaped first so the escape character itself
 * cannot be used to break out of the pattern. This is a correctness fix for
 * matching, not an injection guard — the value is still a bound parameter, and
 * Prisma parameterises it.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

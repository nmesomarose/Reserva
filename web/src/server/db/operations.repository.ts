/**
 * Prisma implementation of the organiser operations port.
 *
 * ## `REPEATABLE READ` is not a tuning choice here
 *
 * §17 requires the dashboard's counts to match the underlying rows "with zero
 * discrepancy", and the check-in count is read from the append-only `check_ins` log
 * while the registration total comes from `registrations`. Under the default
 * (`READ COMMITTED`) PostgreSQL takes a **new snapshot per statement**, so those reads
 * can straddle a concurrent check-in and disagree — a discrepancy the product promises
 * will not happen, produced by nothing more than timing. `REPEATABLE READ` pins one
 * snapshot for the whole aggregate, so a writer is either wholly visible or wholly
 * invisible and the four numbers describe a single instant.
 *
 * The same applies to FR-26's record: an attempt list and a check-in log read from
 * different snapshots would show a registration whose payments the log has not caught up
 * with, which reads as a bug and is one.
 *
 * ## Why the aggregates are SQL and not the query builder
 *
 * Three of the four are `GROUP BY`s and the fourth is a `count(DISTINCT …)` over a table
 * the dashboard does not otherwise touch. Through the builder they would mean fetching
 * every row to count it in JavaScript — a table scan's worth of rows per dashboard poll,
 * on a route with a latency target (FR-18) and a stream behind it polling every two
 * seconds.
 *
 * The zero-filling of the status maps is deliberately *not* done here: the adapter
 * returns grouped rows and the service builds the wire shape, because "a `pending_payment`
 * event still reports `pending_payment: 0`" is a statement about the product's answer,
 * not about SQL.
 *
 * ## Why the raw rows are the domain types
 *
 * Every column is aliased to its domain name, so `EventRecord`, `TicketTypeRecord`,
 * `PaymentRecord` and `CheckInRecord` describe the raw rows exactly. Re-declaring
 * "row" shapes that duplicate them would be a second list to keep in step with the
 * domain — and this is the one adapter where a *silent* omission is a real hazard
 * (FR-26 is defined by including everything), so there is deliberately no projection
 * step that could quietly drop a field.
 */

import "server-only";

import { Prisma } from "@/generated/prisma/client";

import type { EventRecord, TicketTypeRecord } from "@/domain/events/event";
import type {
  PaymentRecord,
  PaymentStatus,
  RegistrationStatus,
} from "@/domain/registrations/registration";
import type { CheckInRecord } from "@/domain/staff/staff";
import type { OrganiserRegistrationRecord } from "@/domain/operations/operations";
import type { DashboardAggregateRows, EventOperationsRepository } from "@/domain/operations/operations.repository";

/** `events`, aliased to the domain's names. */
const EVENT_COLUMNS = `
  e.id          AS "id",
  e.name        AS "name",
  e.slug        AS "slug",
  e.description AS "description",
  e.starts_at   AS "startsAt",
  e.ends_at     AS "endsAt",
  e.venue       AS "venue",
  e.status      AS "status",
  e.created_at  AS "createdAt",
  e.updated_at  AS "updatedAt"
`;

const TICKET_TYPE_COLUMNS = `
  t.id                 AS "id",
  t.event_id           AS "eventId",
  t.name               AS "name",
  t.description        AS "description",
  t.price_minor_units  AS "priceMinorUnits",
  t.currency           AS "currency",
  t.quantity_total     AS "quantityTotal",
  t.quantity_confirmed AS "quantityConfirmed",
  t.quantity_held      AS "quantityHeld",
  t.created_at         AS "createdAt",
  t.updated_at         AS "updatedAt"
`;

/** The registration columns FR-26 exposes; the rest stay in the database. */
const REGISTRATION_COLUMNS = `
  r.id               AS "id",
  r.event_id         AS "eventId",
  r.ticket_type_id   AS "ticketTypeId",
  r.unique_reference AS "uniqueReference",
  r.attendee_name    AS "attendeeName",
  r.attendee_email   AS "attendeeEmail",
  r.attendee_phone   AS "attendeePhone",
  r.status           AS "status",
  r.idempotency_key  AS "idempotencyKey",
  r.created_at       AS "createdAt",
  r.updated_at       AS "updatedAt"
`;

const PAYMENT_COLUMNS = `
  p.id                          AS "id",
  p.registration_id             AS "registrationId",
  p.provider_reference          AS "providerReference",
  p.expected_amount_minor_units AS "expectedAmountMinorUnits",
  p.verified_amount_minor_units AS "verifiedAmountMinorUnits",
  p.currency                    AS "currency",
  p.status                      AS "status",
  p.verified_at                 AS "verifiedAt",
  p.requires_reconciliation     AS "requiresReconciliation",
  p.raw_provider_payload        AS "rawProviderPayload",
  p.created_at                  AS "createdAt",
  p.updated_at                  AS "updatedAt"
`;

const CHECK_IN_COLUMNS = `
  c.id              AS "id",
  c.registration_id AS "registrationId",
  c.checked_in_at   AS "checkedInAt",
  c.organiser_id    AS "organiserId",
  c.staff_token_id  AS "staffTokenId",
  c.is_override     AS "isOverride",
  c.created_at      AS "createdAt"
`;

/**
 * The registration read for FR-26: the full row, of which the record keeps the
 * attendee-facing half. `eventId`, `ticketTypeId`, `idempotencyKey` and `updatedAt` are
 * selected to *prove* the join is scoped (they are the scoping columns) rather than to
 * be returned.
 */
interface RegistrationRow {
  readonly id: string;
  readonly eventId: string;
  readonly ticketTypeId: string;
  readonly uniqueReference: string;
  readonly attendeeName: string;
  readonly attendeeEmail: string;
  readonly attendeePhone: string;
  readonly status: RegistrationStatus;
  readonly idempotencyKey: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** `count(*)::bigint` arrives as `string` from the pg driver; the domain adds numbers. */
interface CountRow<T> {
  readonly status: T;
  readonly count: number | string;
}

export class PrismaEventOperationsRepository implements EventOperationsRepository {
  /**
   * Typed as the transaction client so the same class serves the pool-backed handle and a
   * transaction-scoped one, which is the convention the rest of this directory follows.
   */
  constructor(private readonly prisma: Prisma.TransactionClient) {}

  /**
   * The four FR-25 aggregates, read as one snapshot.
   *
   * Five statements issued inside one `REPEATABLE READ` transaction, in order: three
   * groups, the reconciliation count, and the tier list. They are awaited sequentially
   * rather than through `Promise.all` because a transaction has one connection — a
   * parallel array would look concurrent and run in sequence anyway, and saying so here
   * is cheaper than leaving a reader to find out.
   *
   * Every statement filters on `event_id` **directly**, including the two that reach
   * `payments` and `check_ins` through a join. There is no path here that reads an
   * event's aggregates by first reading its registrations and filtering afterwards.
   */
  async loadDashboard(eventId: string): Promise<DashboardAggregateRows> {
    return this.prisma.$transaction(
      async (tx) => {
        const registrationCounts = await tx.$queryRaw<CountRow<RegistrationStatus>[]>`
          SELECT r.status AS "status", count(*)::bigint AS "count"
          FROM registrations r
          WHERE r.event_id = ${eventId}::uuid
          GROUP BY r.status
        `;

        const paymentCounts = await tx.$queryRaw<CountRow<PaymentStatus>[]>`
          SELECT p.status AS "status", count(*)::bigint AS "count"
          FROM payments p
          JOIN registrations r ON r.id = p.registration_id
          WHERE r.event_id = ${eventId}::uuid
          GROUP BY p.status
        `;

        const reconciliations = await tx.$queryRaw<{ readonly count: number | string }[]>`
          SELECT count(*)::bigint AS "count"
          FROM payments p
          JOIN registrations r ON r.id = p.registration_id
          WHERE r.event_id = ${eventId}::uuid
            AND p.requires_reconciliation = true
        `;

        const ticketTypes = await tx.$queryRaw<TicketTypeRecord[]>`
          SELECT ${Prisma.raw(TICKET_TYPE_COLUMNS)}
          FROM ticket_types t
          WHERE t.event_id = ${eventId}::uuid
          ORDER BY t.created_at ASC, t.id ASC
        `;

        const checkIns = await tx.$queryRaw<
          {
            readonly entries: number | string;
            readonly overrides: number | string;
            readonly registrationsCheckedIn: number | string;
          }[]
        >`
          SELECT count(*)::bigint                              AS "entries",
                 count(*) FILTER (WHERE c.is_override)::bigint AS "overrides",
                 count(DISTINCT c.registration_id)::bigint     AS "registrationsCheckedIn"
          FROM check_ins c
          JOIN registrations r ON r.id = c.registration_id
          WHERE r.event_id = ${eventId}::uuid
        `;

        return {
          registrationCounts: toStatusCounts<RegistrationStatus>(registrationCounts),
          paymentCounts: toStatusCounts<PaymentStatus>(paymentCounts),
          paymentsRequiringReconciliation: asNumber(reconciliations[0]?.count),
          ticketTypes,
          checkIns: {
            entries: asNumber(checkIns[0]?.entries),
            overrides: asNumber(checkIns[0]?.overrides),
            registrationsCheckedIn: asNumber(checkIns[0]?.registrationsCheckedIn),
          },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /**
   * FR-26: the full record behind one of the dashboard's numbers.
   *
   * Scoped by `r.event_id` in the registration read itself, so a registration id from
   * another event returns `null` — the same "no such registration on this event" answer
   * an unknown id gets, which is what stops the route confirming that an id exists
   * somewhere else (rule 08).
   *
   * The event is read **live** (BR-6) rather than from a copy on the registration, so a
   * reschedule after the sale is reflected in the record.
   *
   * Ordering is fixed here rather than left to the service: payments **newest first**, so
   * element zero is the attempt a dispute is about, and check-ins **oldest first**, so
   * element zero is the original entry (§4.4.4) and BR-4's override rows follow it.
   */
  async findRegistrationRecord(
    eventId: string,
    registrationId: string,
  ): Promise<OrganiserRegistrationRecord | null> {
    return this.prisma.$transaction(
      async (tx) => {
        const registrations = await tx.$queryRaw<RegistrationRow[]>`
          SELECT ${Prisma.raw(REGISTRATION_COLUMNS)}
          FROM registrations r
          WHERE r.id = ${registrationId}::uuid
            AND r.event_id = ${eventId}::uuid
        `;

        const registration = registrations[0];

        if (registration === undefined) {
          return null;
        }

        const events = await tx.$queryRaw<EventRecord[]>`
          SELECT ${Prisma.raw(EVENT_COLUMNS)}
          FROM events e
          WHERE e.id = ${eventId}::uuid
        `;

        const tiers = await tx.$queryRaw<TicketTypeRecord[]>`
          SELECT ${Prisma.raw(TICKET_TYPE_COLUMNS)}
          FROM ticket_types t
          WHERE t.id = ${registration.ticketTypeId}::uuid
            AND t.event_id = ${eventId}::uuid
        `;

        const payments = await tx.$queryRaw<PaymentRecord[]>`
          SELECT ${Prisma.raw(PAYMENT_COLUMNS)}
          FROM payments p
          WHERE p.registration_id = ${registrationId}::uuid
          ORDER BY p.created_at DESC, p.id DESC
        `;

        const checkIns = await tx.$queryRaw<CheckInRecord[]>`
          SELECT ${Prisma.raw(CHECK_IN_COLUMNS)}
          FROM check_ins c
          WHERE c.registration_id = ${registrationId}::uuid
          ORDER BY c.checked_in_at ASC, c.id ASC
        `;

        const event = events[0];
        const tier = tiers[0];

        if (event === undefined || tier === undefined) {
          // Both foreign keys forbid this. Returning a partial record would put an
          // organiser in front of a registration with no tier — the shape of a data bug
          // they cannot act on; failing loudly hands it to whoever can.
          throw new Error(
            "A registration was read without its event and ticket type, which the foreign keys forbid.",
          );
        }

        return {
          registration: {
            id: registration.id,
            uniqueReference: registration.uniqueReference,
            attendeeName: registration.attendeeName,
            attendeeEmail: registration.attendeeEmail,
            attendeePhone: registration.attendeePhone,
            status: registration.status,
            createdAt: registration.createdAt,
          },
          ticketType: tier,
          payments,
          checkIns,
          event,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}

/** Grouped rows with the `bigint` string normalised once, at this boundary. */
function toStatusCounts<T extends RegistrationStatus | PaymentStatus>(
  rows: readonly CountRow<T>[],
): readonly { readonly status: T; readonly count: number }[] {
  return rows.map((row) => ({ status: row.status, count: asNumber(row.count) }));
}

function asNumber(value: number | string | undefined): number {
  return Number(value ?? 0);
}

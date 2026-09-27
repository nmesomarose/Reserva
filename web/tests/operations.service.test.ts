import { beforeEach, describe, expect, it } from "vitest";

/**
 * Organiser operations rules against an in-memory repository (AGENTS.md §4, PRD v2
 * §5.9, §7.4, §12 row 13, §13, §17; FR-22, FR-25, FR-26, R-5 G-1/G-2; rules 05, 06, 08).
 *
 * This file decides what the dashboard *means*, which is the part no database can
 * decide for us:
 *
 *   1. **Zero-filling.** A `pending_payment` event must still report all five
 *      registration states and all five payment states. An adapter that emitted only the
 *      states it happened to find would make the wire format depend on the data, so the
 *      `GROUP BY` rows are handed in sparsely and the full shape is asserted.
 *   2. **Derivation, not trust.** `available` is computed from BR-3's two counters and
 *      `sold_out` from the same `isTierAvailable` the public page uses, so a test that
 *      feeds deliberately odd counters proves the arithmetic rather than a passthrough.
 *   3. **The check-in cross-check**, in both directions. This is the one place the
 *      service can refuse to answer, and the direction of each refusal is a product
 *      decision: the projection may lag the log (BR-7 refunds a checked-in
 *      registration), and must never lead it.
 *   4. **FR-26's "not just the latest".** The record must carry *every* attempt and
 *      *every* check-in, in the order the port promised, and must not reduce them.
 *   5. **Ownership before aggregate reads.** Asserted by what the repository was *not*
 *      asked, since an aggregate query that runs before the check can leak another
 *      tenant's totals through timing alone.
 *
 * Proven elsewhere, and deliberately not here: that one snapshot really is
 * `REPEATABLE READ`, and that the SQL scopes every statement to the event
 * -> `operations.db.test.ts`; body/path parsing -> `requests.validation.test.ts`;
 * HTTP status codes -> `api.v1.operations.test.ts`; the stream's polling and framing ->
 * `dashboard-stream.test.ts`.
 */

import { ConflictError, ForbiddenError, NotFoundError } from "@/domain/errors";
import { EVENT_FORBIDDEN_MESSAGE } from "@/domain/events/event-ownership";
import type { EventRecord, TicketTypeRecord } from "@/domain/events/event";
import type { EventRepository } from "@/domain/events/event.repository";
import type { PaymentRecord } from "@/domain/registrations/registration";
import type { CheckInRecord } from "@/domain/staff/staff";
import type {
  DashboardAggregateRows,
  EventOperationsRepository,
} from "@/domain/operations/operations.repository";
import type { OrganiserRegistrationRecord } from "@/domain/operations/operations";
import { OperationsService } from "@/domain/operations/operations.service";

const ORGANISER_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ORGANISER_ID = "22222222-2222-2222-2222-222222222222";
const EVENT_ID = "33333333-3333-3333-3333-333333333333";
const OTHER_EVENT_ID = "44444444-4444-4444-4444-444444444444";
const TICKET_TYPE_ID = "99999999-9999-9999-9999-999999999999";
const STAFF_TOKEN_ID = "55555555-5555-5555-5555-555555555555";
const REGISTRATION_ID = "66666666-6666-6666-6666-666666666666";
const OTHER_REGISTRATION_ID = "77777777-7777-7777-7777-777777777777";
const PAYMENT_ID = "88888888-8888-8888-8888-888888888888";
const CHECK_IN_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

const NOW = new Date("2026-10-01T19:00:00Z");
const EVENT_STARTS_AT = new Date("2026-10-01T18:00:00Z");
const EVENT_ENDS_AT = new Date("2026-10-01T22:00:00Z");

function eventRow(id: string, organiserId: string): EventRecord {
  return {
    id,
    organiserId,
    name: "Jazz Night",
    slug: `jazz-${id.slice(0, 4)}`,
    description: null,
    startsAt: EVENT_STARTS_AT,
    endsAt: EVENT_ENDS_AT,
    venue: "The Blue Room",
    status: "published",
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  };
}

function tier(overrides: Partial<TicketTypeRecord> = {}): TicketTypeRecord {
  return {
    id: TICKET_TYPE_ID,
    eventId: EVENT_ID,
    name: "General Admission",
    description: null,
    priceMinorUnits: 5_000,
    currency: "NGN",
    quantityTotal: 500,
    quantityConfirmed: 12,
    quantityHeld: 3,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function payment(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id: PAYMENT_ID,
    registrationId: REGISTRATION_ID,
    providerReference: "FLW-abc-123",
    expectedAmountMinorUnits: 5_000,
    verifiedAmountMinorUnits: null,
    currency: "NGN",
    status: "initiated",
    verifiedAt: null,
    requiresReconciliation: false,
    rawProviderPayload: { status: "success", tx_ref: "FLW-abc-123" },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function checkIn(overrides: Partial<CheckInRecord> = {}): CheckInRecord {
  return {
    id: CHECK_IN_ID,
    registrationId: REGISTRATION_ID,
    checkedInAt: NOW,
    organiserId: null,
    staffTokenId: STAFF_TOKEN_ID,
    isOverride: false,
    createdAt: NOW,
    ...overrides,
  };
}

function aggregateRows(overrides: Partial<DashboardAggregateRows> = {}): DashboardAggregateRows {
  return {
    registrationCounts: [],
    paymentCounts: [],
    paymentsRequiringReconciliation: 0,
    ticketTypes: [],
    checkIns: { entries: 0, overrides: 0, registrationsCheckedIn: 0 },
    ...overrides,
  };
}

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
        `EventRepository.${String(property)} was called, but the operations slice must only ` +
          `read findEventById for ownership. Add a stub if that is now required.`,
      );
    },
  });
}

class FakeOperationsRepository implements EventOperationsRepository {
  readonly methodCalls: string[] = [];
  readonly loadedEventIds: string[] = [];
  readonly recordLookups: Array<{ eventId: string; registrationId: string }> = [];

  rows = aggregateRows();
  record: OrganiserRegistrationRecord | null = null;

  async loadDashboard(eventId: string): Promise<DashboardAggregateRows> {
    this.methodCalls.push("loadDashboard");
    this.loadedEventIds.push(eventId);

    return this.rows;
  }

  async findRegistrationRecord(eventId: string, registrationId: string) {
    this.methodCalls.push("findRegistrationRecord");
    this.recordLookups.push({ eventId, registrationId });

    return this.record;
  }
}

function build(events: readonly EventRecord[] = [eventRow(EVENT_ID, ORGANISER_ID)]) {
  const repository = new FakeOperationsRepository();

  return {
    repository,
    service: new OperationsService(eventRepository(events), repository, () => NOW),
  };
}

describe("dashboard aggregates (FR-25, §17)", () => {
  let context: ReturnType<typeof build>;

  beforeEach(() => {
    context = build();
  });

  it("reports every registration state, including the ones with no rows", async () => {
    // The `GROUP BY` returns only `confirmed`. All five keys must still be present, or a
    // client cannot render a stable breakdown.
    context.repository.rows = aggregateRows({
      registrationCounts: [{ status: "confirmed", count: 12 }],
    });

    const dashboard = await context.service.getDashboard(ORGANISER_ID, EVENT_ID);

    expect(dashboard.registrations).toEqual({
      total: 12,
      by_status: {
        pending_payment: 0,
        confirmed: 12,
        checked_in: 0,
        cancelled: 0,
        refunded: 0,
      },
    });
  });

  it("reports every payment state, and counts the reconciliation flag beside them", async () => {
    context.repository.rows = aggregateRows({
      paymentCounts: [
        { status: "success", count: 9 },
        { status: "failed", count: 1 },
      ],
      paymentsRequiringReconciliation: 2,
    });

    const dashboard = await context.service.getDashboard(ORGANISER_ID, EVENT_ID);

    // R-1: the flag is never a status, so it is counted outside `by_status` - including
    // for a success that is flagged, which is the case §8.5 exists for.
    expect(dashboard.payments).toEqual({
      attempts: 10,
      by_status: { initiated: 0, processing: 0, pending: 0, success: 9, failed: 1 },
      requires_reconciliation: 2,
    });
  });

  it("counts attempts, not registrations, because one registration can hold many", async () => {
    context.repository.rows = aggregateRows({
      paymentCounts: [{ status: "initiated", count: 3 }],
    });

    const dashboard = await context.service.getDashboard(ORGANISER_ID, EVENT_ID);

    expect(dashboard.payments.attempts).toBe(3);
  });

  it("makes the total the sum of the breakdown, so the two cannot disagree", async () => {
    context.repository.rows = aggregateRows({
      registrationCounts: [
        { status: "pending_payment", count: 2 },
        { status: "confirmed", count: 5 },
        { status: "checked_in", count: 30 },
        { status: "cancelled", count: 1 },
        { status: "refunded", count: 1 },
      ],
      // Kept in step with the `checked_in` projection: an event that has 30 people
      // through the door has 30 rows in the log, and the cross-check is what says so.
      checkIns: { entries: 30, overrides: 0, registrationsCheckedIn: 30 },
    });

    const dashboard = await context.service.getDashboard(ORGANISER_ID, EVENT_ID);

    const summed = Object.values(dashboard.registrations.by_status).reduce((a, b) => a + b, 0);
    expect(dashboard.registrations.total).toBe(summed);
    expect(dashboard.registrations.total).toBe(39);
  });

  it("derives availability from the two counters rather than reading a stored value", async () => {
    // Over-committed inventory (`available` would be negative) is exactly the case a
    // naive subtraction hides with a clamp, so it is fed in deliberately.
    context.repository.rows = aggregateRows({
      ticketTypes: [tier({ quantityTotal: 100, quantityConfirmed: 98, quantityHeld: 5 })],
    });

    const dashboard = await context.service.getDashboard(ORGANISER_ID, EVENT_ID);

    expect(dashboard.ticket_types[0]).toEqual({
      ticket_type_id: TICKET_TYPE_ID,
      name: "General Admission",
      price_minor_units: 5_000,
      currency: "NGN",
      quantity_total: 100,
      quantity_confirmed: 98,
      quantity_held: 5,
      available: -3,
      sold_out: true,
    });
  });

  it.each([
    ["confirmed seats", { quantityTotal: 100, quantityConfirmed: 100, quantityHeld: 0 }, 0, true],
    ["held seats", { quantityTotal: 100, quantityConfirmed: 90, quantityHeld: 10 }, 0, true],
    ["one seat left", { quantityTotal: 100, quantityConfirmed: 98, quantityHeld: 1 }, 1, false],
  ])("agrees with the public page about %s being sold out", async (_label, counters, available, soldOut) => {
    // Same `isTierAvailable` the event page calls, so "sold out" is one statement in
    // this product rather than one per surface.
    context.repository.rows = aggregateRows({ ticketTypes: [tier(counters)] });

    const dashboard = await context.service.getDashboard(ORGANISER_ID, EVENT_ID);

    expect(dashboard.ticket_types[0]?.available).toBe(available);
    expect(dashboard.ticket_types[0]?.sold_out).toBe(soldOut);
  });

  it("stamps the reading with the service's clock and the event's live facts", async () => {
    const dashboard = await context.service.getDashboard(ORGANISER_ID, EVENT_ID);

    expect(dashboard.generated_at).toBe(NOW.toISOString());
    expect(dashboard.event).toEqual({
      id: EVENT_ID,
      name: "Jazz Night",
      slug: `jazz-${EVENT_ID.slice(0, 4)}`,
      status: "published",
      starts_at: EVENT_STARTS_AT.toISOString(),
      ends_at: EVENT_ENDS_AT.toISOString(),
      venue: "The Blue Room",
    });
  });

  it("asks the repository for the event it authorised, and nothing else", async () => {
    await context.service.getDashboard(ORGANISER_ID, EVENT_ID);

    expect(context.repository.loadedEventIds).toEqual([EVENT_ID]);
  });

  it("refuses another organiser's event without running an aggregate query", async () => {
    const foreign = build([eventRow(OTHER_EVENT_ID, OTHER_ORGANISER_ID)]);

    await expect(
      foreign.service.getDashboard(ORGANISER_ID, OTHER_EVENT_ID),
    ).rejects.toThrow(ForbiddenError);

    expect(foreign.repository.methodCalls).toEqual([]);
  });

  it("uses the shared cross-owner refusal message", async () => {
    const foreign = build([eventRow(OTHER_EVENT_ID, OTHER_ORGANISER_ID)]);

    await expect(foreign.service.getDashboard(ORGANISER_ID, OTHER_EVENT_ID)).rejects.toThrow(
      EVENT_FORBIDDEN_MESSAGE,
    );
  });

  it("refuses an event that does not exist, without querying", async () => {
    await expect(
      context.service.getDashboard(ORGANISER_ID, OTHER_EVENT_ID),
    ).rejects.toThrow(NotFoundError);

    expect(context.repository.methodCalls).toEqual([]);
  });

  it("refuses a caller with no organiser id before any read", async () => {
    await expect(context.service.getDashboard("  ", EVENT_ID)).rejects.toThrow();

    expect(context.repository.methodCalls).toEqual([]);
  });
});

describe("the dashboard refuses to publish a check-in count it cannot stand behind (FR-25, §17)", () => {
  let context: ReturnType<typeof build>;

  beforeEach(() => {
    context = build();
  });

  it("reports the log's own numbers, and the projection is never the number served", async () => {
    context.repository.rows = aggregateRows({
      registrationCounts: [{ status: "checked_in", count: 30 }],
      checkIns: { entries: 32, overrides: 2, registrationsCheckedIn: 30 },
    });

    const dashboard = await context.service.getDashboard(ORGANISER_ID, EVENT_ID);

    // Two people came through twice. "Check-ins" is answered with the people, and the
    // repeat entries are reported beside it rather than folded in (§7.4/BR-4).
    expect(dashboard.check_ins).toEqual({
      registrations_checked_in: 30,
      entries: 32,
      overrides: 2,
    });
  });

  it("refuses when the projection claims more check-ins than the log holds", async () => {
    // `registrations.status = checked_in` with no log row behind it can only be a write
    // that skipped the check-in transaction, or a lost log row: a real discrepancy.
    context.repository.rows = aggregateRows({
      registrationCounts: [{ status: "checked_in", count: 31 }],
      checkIns: { entries: 32, overrides: 2, registrationsCheckedIn: 30 },
    });

    const failure = await context.service
      .getDashboard(ORGANISER_ID, EVENT_ID)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConflictError);
    expect((failure as Error).message).toContain("disagree");
  });

  it("still serves the dashboard when the projection has legitimately fallen behind", async () => {
    // BR-7: a checked-in registration can afterwards be refunded or cancelled, and its
    // append-only log row still stands. That is a consistent database, and refusing the
    // whole dashboard over it would fail an organiser during the one hour they most
    // need it.
    context.repository.rows = aggregateRows({
      registrationCounts: [
        { status: "checked_in", count: 29 },
        { status: "refunded", count: 1 },
      ],
      checkIns: { entries: 32, overrides: 2, registrationsCheckedIn: 30 },
    });

    const dashboard = await context.service.getDashboard(ORGANISER_ID, EVENT_ID);

    expect(dashboard.check_ins.registrations_checked_in).toBe(30);
    expect(dashboard.registrations.by_status.checked_in).toBe(29);
  });

  it("refuses a log with fewer entries than distinct registrations", async () => {
    context.repository.rows = aggregateRows({
      checkIns: { entries: 5, overrides: 0, registrationsCheckedIn: 6 },
    });

    await expect(context.service.getDashboard(ORGANISER_ID, EVENT_ID)).rejects.toThrow(ConflictError);
  });

  it("refuses a log with more overrides than entries", async () => {
    context.repository.rows = aggregateRows({
      checkIns: { entries: 5, overrides: 6, registrationsCheckedIn: 5 },
    });

    await expect(context.service.getDashboard(ORGANISER_ID, EVENT_ID)).rejects.toThrow(ConflictError);
  });

  it("serves a dashboard for an event nobody has checked into yet", async () => {
    const dashboard = await context.service.getDashboard(ORGANISER_ID, EVENT_ID);

    expect(dashboard.check_ins).toEqual({
      registrations_checked_in: 0,
      entries: 0,
      overrides: 0,
    });
  });
});

describe("readDashboardForEvent re-reads without re-authorising (R-5 G-2, FR-22)", () => {
  it("is reachable for an event the caller has already been granted", async () => {
    const context = build();
    const event = eventRow(EVENT_ID, ORGANISER_ID);
    context.repository.rows = aggregateRows({ registrationCounts: [{ status: "confirmed", count: 4 }] });

    // The stream's per-tick read. It takes a record rather than ids because the record
    // *is* the proof the stream was authorised once at connect time.
    const record = await context.service.readDashboardForEvent(event);

    expect(record.registrations.total).toBe(4);
    expect(record.event.id).toBe(EVENT_ID);
  });

  it("re-reads on every call, so a second tick sees the second commit", async () => {
    const context = build();
    const event = eventRow(EVENT_ID, ORGANISER_ID);

    context.repository.rows = aggregateRows({ checkIns: { entries: 1, overrides: 0, registrationsCheckedIn: 1 } });
    context.repository.rows = {
      ...context.repository.rows,
      registrationCounts: [{ status: "checked_in", count: 1 }],
    };
    const first = await context.service.readDashboardForEvent(event);

    context.repository.rows = aggregateRows({
      registrationCounts: [{ status: "checked_in", count: 2 }],
      checkIns: { entries: 2, overrides: 0, registrationsCheckedIn: 2 },
    });
    const second = await context.service.readDashboardForEvent(event);

    // FR-22: the propagation target is 5 seconds, and a cached read could not show this.
    expect(first.checkIns.registrationsCheckedIn).toBe(1);
    expect(second.checkIns.registrationsCheckedIn).toBe(2);
    expect(context.repository.methodCalls).toEqual(["loadDashboard", "loadDashboard"]);
  });

  it("hands out the event and nothing aggregate, so it cannot become a route entry point", async () => {
    // `authoriseEvent` returns an `EventRecord`, not a dashboard: a caller holding it can
    // only re-read aggregates for that one event, never read a different one.
    const context = build();

    const event = await context.service.authoriseEvent(ORGANISER_ID, EVENT_ID);

    expect(event).toMatchObject({ id: EVENT_ID, organiserId: ORGANISER_ID });
    expect(context.repository.methodCalls).toEqual([]);
  });

  it("refuses to authorise another organiser's event", async () => {
    const context = build([eventRow(OTHER_EVENT_ID, OTHER_ORGANISER_ID)]);

    await expect(context.service.authoriseEvent(ORGANISER_ID, OTHER_EVENT_ID)).rejects.toThrow(
      ForbiddenError,
    );
  });
});

describe("the organiser's full registration record (FR-26, R-5 G-1)", () => {
  let context: ReturnType<typeof build>;

  beforeEach(() => {
    context = build();
  });

  it("carries every payment attempt, not just the latest", async () => {
    context.repository.record = {
      registration: {
        id: REGISTRATION_ID,
        uniqueReference: "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
        attendeeName: "Ada Lovelace",
        attendeeEmail: "ada@example.com",
        attendeePhone: "+2348012345678",
        status: "confirmed",
        createdAt: NOW,
      },
      ticketType: tier(),
      payments: [
        payment({ id: PAYMENT_ID, status: "success", createdAt: new Date("2026-10-01T18:10:00Z") }),
        payment({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", status: "failed", createdAt: new Date("2026-10-01T18:00:00Z") }),
      ],
      checkIns: [],
      event: eventRow(EVENT_ID, ORGANISER_ID),
    };

    const record = await context.service.getRegistrationRecord(
      ORGANISER_ID,
      EVENT_ID,
      REGISTRATION_ID,
    );

    // "Not just the latest" is the whole point of FR-26: the first element is the latest
    // *because* the other two are there too.
    expect(record.payments.map((attempt) => attempt.id)).toEqual([
      PAYMENT_ID,
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    ]);
    expect(record.payments.map((attempt) => attempt.status)).toEqual(["success", "failed"]);
  });

  it("carries the whole check-in log, oldest first, overrides included", async () => {
    context.repository.record = {
      registration: {
        id: REGISTRATION_ID,
        uniqueReference: "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
        attendeeName: "Ada Lovelace",
        attendeeEmail: "ada@example.com",
        attendeePhone: "+2348012345678",
        status: "checked_in",
        createdAt: NOW,
      },
      ticketType: tier(),
      payments: [],
      checkIns: [
        checkIn({ id: CHECK_IN_ID, checkedInAt: new Date("2026-10-01T18:30:00Z") }),
        checkIn({ id: "cccccccc-cccc-cccc-cccc-cccccccccccc", isOverride: true, checkedInAt: new Date("2026-10-01T19:30:00Z") }),
      ],
      event: eventRow(EVENT_ID, ORGANISER_ID),
    };

    const record = await context.service.getRegistrationRecord(
      ORGANISER_ID,
      EVENT_ID,
      REGISTRATION_ID,
    );

    expect(record.check_ins).toEqual([
      {
        id: CHECK_IN_ID,
        checked_in_at: "2026-10-01T18:30:00.000Z",
        is_override: false,
        performed_by: { kind: "staff_token", staff_token_id: STAFF_TOKEN_ID },
      },
      {
        id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
        checked_in_at: "2026-10-01T19:30:00.000Z",
        is_override: true,
        performed_by: { kind: "staff_token", staff_token_id: STAFF_TOKEN_ID },
      },
    ]);
  });

  it("names the actor as a union, so an id is never mistaken for the other kind", async () => {
    context.repository.record = {
      registration: {
        id: REGISTRATION_ID,
        uniqueReference: "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
        attendeeName: "Ada Lovelace",
        attendeeEmail: "ada@example.com",
        attendeePhone: "+2348012345678",
        status: "checked_in",
        createdAt: NOW,
      },
      ticketType: tier(),
      payments: [],
      checkIns: [
        checkIn({ id: CHECK_IN_ID, staffTokenId: null, organiserId: ORGANISER_ID }),
      ],
      event: eventRow(EVENT_ID, ORGANISER_ID),
    };

    const record = await context.service.getRegistrationRecord(
      ORGANISER_ID,
      EVENT_ID,
      REGISTRATION_ID,
    );

    expect(record.check_ins[0]?.performed_by).toEqual({ kind: "organiser", organiser_id: ORGANISER_ID });
  });

  it("refuses to project a check-in row that names no actor at all", async () => {
    // Unreachable while `check_ins_exactly_one_actor_check` holds, and handled anyway:
    // an audit row claiming nobody performed it is worse than an error.
    context.repository.record = {
      registration: {
        id: REGISTRATION_ID,
        uniqueReference: "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
        attendeeName: "Ada Lovelace",
        attendeeEmail: "ada@example.com",
        attendeePhone: "+2348012345678",
        status: "checked_in",
        createdAt: NOW,
      },
      ticketType: tier(),
      payments: [],
      checkIns: [checkIn({ staffTokenId: null, organiserId: null })],
      event: eventRow(EVENT_ID, ORGANISER_ID),
    };

    await expect(
      context.service.getRegistrationRecord(ORGANISER_ID, EVENT_ID, REGISTRATION_ID),
    ).rejects.toThrow(/exactly one actor/);
  });

  it("includes the raw provider payload, because this is the audit surface", async () => {
    context.repository.record = {
      registration: {
        id: REGISTRATION_ID,
        uniqueReference: "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
        attendeeName: "Ada Lovelace",
        attendeeEmail: "ada@example.com",
        attendeePhone: "+2348012345678",
        status: "confirmed",
        createdAt: NOW,
      },
      ticketType: tier(),
      payments: [payment()],
      checkIns: [],
      event: eventRow(EVENT_ID, ORGANISER_ID),
    };

    const record = await context.service.getRegistrationRecord(
      ORGANISER_ID,
      EVENT_ID,
      REGISTRATION_ID,
    );

    // §18/rule 08: the *only* response in the product that may carry this, and the
    // evidence/registration/staff DTOs all omit it by name.
    expect(record.payments[0]?.raw_provider_payload).toEqual({
      status: "success",
      tx_ref: "FLW-abc-123",
    });
  });

  it("shows unmasked contact details, because the organiser owns this registration", async () => {
    context.repository.record = {
      registration: {
        id: REGISTRATION_ID,
        uniqueReference: "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
        attendeeName: "Ada Lovelace",
        attendeeEmail: "ada@example.com",
        attendeePhone: "+2348012345678",
        status: "confirmed",
        createdAt: NOW,
      },
      ticketType: tier(),
      payments: [],
      checkIns: [],
      event: eventRow(EVENT_ID, ORGANISER_ID),
    };

    const record = await context.service.getRegistrationRecord(
      ORGANISER_ID,
      EVENT_ID,
      REGISTRATION_ID,
    );

    // The counterpart to the queue's masking: this is the one click the queue promises.
    expect(record.registration.attendee_email).toBe("ada@example.com");
    expect(record.registration.attendee_phone).toBe("+2348012345678");
  });

  it("answers a registration id from another event as not found", async () => {
    context.repository.record = null;

    const failure = await context.service
      .getRegistrationRecord(ORGANISER_ID, EVENT_ID, OTHER_REGISTRATION_ID)
      .catch((error: unknown) => error);

    // `404`, not `403`: the two must be indistinguishable or the route is an id oracle
    // across tenants (rule 05, PRD §15).
    expect(failure).toBeInstanceOf(NotFoundError);
  });

  it("refuses another organiser's event before reading the registration", async () => {
    const foreign = build([eventRow(OTHER_EVENT_ID, OTHER_ORGANISER_ID)]);

    await expect(
      foreign.service.getRegistrationRecord(ORGANISER_ID, OTHER_EVENT_ID, REGISTRATION_ID),
    ).rejects.toThrow(ForbiddenError);

    expect(foreign.repository.methodCalls).toEqual([]);
  });

  it("scopes the record read to the event, so the adapter can filter in SQL", async () => {
    context.repository.record = null;

    await context.service
      .getRegistrationRecord(ORGANISER_ID, EVENT_ID, REGISTRATION_ID)
      .catch(() => undefined);

    expect(context.repository.recordLookups).toEqual([
      { eventId: EVENT_ID, registrationId: REGISTRATION_ID },
    ]);
  });
});

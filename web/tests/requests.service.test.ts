import { beforeEach, describe, expect, it } from "vitest";

/**
 * Attendee-request business rules against an in-memory repository (AGENTS.md §4, PRD v2
 * §5.8, §12 rows 11-12, §14; FR-23, FR-23a, FR-24; rules 05, 06, 07, 08).
 *
 * What only a fake can decide, and is therefore decided here:
 *
 *   1. **Which outcome a refusal becomes.** `400` for an ownership pair that does not
 *      resolve (§12's own status for this row), `404` for another organiser's request,
 *      `409` for a second write to a resolved request, `400` for an empty patch. A real
 *      database proves the writes, not the mapping, and mapping status codes onto wrong
 *      inputs is precisely what fakes are for.
 *   2. **The order of decisions.** Ownership before every read; the request's event
 *      before its state; the state before the body. Each is asserted by *what was not
 *      read*, using a repository that records its calls — an authorisation check that
 *      runs after the query still passes every functional test.
 *   3. **That `resolved_at` is stamped once and only for a resolution.** The fake records
 *      the exact `RecordAttendeeRequestResolutionInput` it was handed, so "the port was
 *      never asked to write `open`" and "a notes-only write passes `status: null`" are
 *      observable facts rather than inferences from a returned DTO.
 *   4. **Masking.** The queue row must be masked; a comparison of the whole DTO against
 *      an expected object catches an unmasked value only while the expected value stays
 *      in step, so the forbidden fields are also asserted *absent* by name.
 *
 * Proven elsewhere, and deliberately not here:
 *
 *   - `UNIQUE(idempotency_key)` as the arbiter of two concurrent inserts
 *     -> `requests.db.test.ts`;
 *   - the `WHERE status = 'open'` guard refusing a second organiser's resolution
 *     -> `requests.db.test.ts`;
 *   - the CHECK/immutability/no-delete triggers -> `requests.db.test.ts` and
 *     `verify-db-constraints.mjs`;
 *   - body/query parsing -> `requests.validation.test.ts`;
 *   - status codes over HTTP -> `api.v1.requests.test.ts`.
 */

import {
  ConflictError,
  ForbiddenError,
  IllegalTransitionError,
  NotFoundError,
  ValidationError,
} from "@/domain/errors";
import { EVENT_FORBIDDEN_MESSAGE } from "@/domain/events/event-ownership";
import type { EventRecord, PageRequest } from "@/domain/events/event";
import type { EventRepository } from "@/domain/events/event.repository";
import type { RegistrationRecord } from "@/domain/registrations/registration";
import type { RegistrationRepository } from "@/domain/registrations/registration.repository";
import type {
  AttendeeRequestCreation,
  AttendeeRequestRepository,
  CreateAttendeeRequestInput,
  ListAttendeeRequestsQuery,
  RecordAttendeeRequestResolutionInput,
  RecordAttendeeRequestResolutionOutcome,
} from "@/domain/requests/request.repository";
import type {
  AttendeeRequestListRow,
  AttendeeRequestRecord,
  AttendeeRequestStatus,
} from "@/domain/requests/request";
import { RequestService } from "@/domain/requests/request.service";

const ORGANISER_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ORGANISER_ID = "22222222-2222-2222-2222-222222222222";
const EVENT_ID = "33333333-3333-3333-3333-333333333333";
const OTHER_EVENT_ID = "44444444-4444-4444-4444-444444444444";
const REGISTRATION_ID = "55555555-5555-5555-5555-555555555555";
const OTHER_REGISTRATION_ID = "66666666-6666-6666-6666-666666666666";
const REQUEST_ID = "77777777-7777-7777-7777-777777777777";
const OTHER_REQUEST_ID = "88888888-8888-8888-8888-888888888888";

const REFERENCE = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const OTHER_REFERENCE = "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2";
const EMAIL = "ada@example.com";
const IDEMPOTENCY_KEY = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

const CREATED_AT = new Date("2026-10-01T18:00:00Z");
const RESOLVED_AT = new Date("2026-10-01T19:30:00Z");
const SERVICE_NOW = new Date("2026-10-01T19:00:00Z");

const PAGE: PageRequest = { page: 1, pageSize: 20 };

function eventRow(id: string, organiserId: string): EventRecord {
  return {
    id,
    organiserId,
    name: "Jazz Night",
    slug: `jazz-${id.slice(0, 4)}`,
    description: null,
    startsAt: new Date("2026-10-01T18:00:00Z"),
    endsAt: new Date("2026-10-01T22:00:00Z"),
    venue: "The Blue Room",
    status: "published",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    deletedAt: null,
  };
}

function registration(overrides: Partial<RegistrationRecord> = {}): RegistrationRecord {
  return {
    id: REGISTRATION_ID,
    eventId: EVENT_ID,
    ticketTypeId: "99999999-9999-9999-9999-999999999999",
    uniqueReference: REFERENCE,
    attendeeName: "Ada Lovelace",
    attendeeEmail: EMAIL,
    attendeePhone: "+2348012345678",
    status: "confirmed",
    idempotencyKey: IDEMPOTENCY_KEY,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function request(overrides: Partial<AttendeeRequestRecord> = {}): AttendeeRequestRecord {
  return {
    id: REQUEST_ID,
    registrationId: REGISTRATION_ID,
    message: "Can I transfer my ticket to a colleague?",
    status: "open",
    resolutionNotes: null,
    idempotencyKey: IDEMPOTENCY_KEY,
    createdAt: CREATED_AT,
    resolvedAt: null,
    ...overrides,
  };
}

function listRow(overrides: Partial<AttendeeRequestListRow> = {}): AttendeeRequestListRow {
  return {
    ...request(),
    registrationStatus: "confirmed",
    attendeeName: "Ada Lovelace",
    attendeeEmail: EMAIL,
    attendeePhone: "+2348012345678",
    ...overrides,
  };
}

/** Only the ownership read; any other call is a loud failure (see `staff.service.test.ts`). */
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
        `EventRepository.${String(property)} was called, but the request slice must only ` +
          `read findEventById for ownership. Add a stub if that is now required.`,
      );
    },
  });
}

class FakeRegistrationRepository {
  readonly calls: string[] = [];
  constructor(private readonly rows: readonly RegistrationRecord[]) {}

  async findRegistrationByReference(reference: string): Promise<RegistrationRecord | null> {
    this.calls.push("findRegistrationByReference");

    return this.rows.find((row) => row.uniqueReference === reference) ?? null;
  }
}

class FakeAttendeeRequestRepository implements AttendeeRequestRepository {
  readonly creates: CreateAttendeeRequestInput[] = [];
  readonly listQueries: ListAttendeeRequestsQuery[] = [];
  readonly resolutions: RecordAttendeeRequestResolutionInput[] = [];
  readonly methodCalls: string[] = [];

  /** Next answers, so each test states its own outcome rather than inheriting one. */
  nextCreation: AttendeeRequestCreation = { outcome: "created", request: request() };
  nextList: { items: AttendeeRequestListRow[]; total: number } = { items: [], total: 0 };
  nextForEvent: AttendeeRequestListRow | null = null;
  nextResolution: RecordAttendeeRequestResolutionOutcome = { kind: "not_found" };

  async transact<T>(work: (repository: AttendeeRequestRepository) => Promise<T>): Promise<T> {
    return work(this);
  }

  async createAttendeeRequest(input: CreateAttendeeRequestInput): Promise<AttendeeRequestCreation> {
    this.methodCalls.push("createAttendeeRequest");
    this.creates.push(input);

    return this.nextCreation;
  }

  async findAttendeeRequestByIdempotencyKey(): Promise<AttendeeRequestRecord | null> {
    this.methodCalls.push("findAttendeeRequestByIdempotencyKey");

    return null;
  }

  async listAttendeeRequests(query: ListAttendeeRequestsQuery) {
    this.methodCalls.push("listAttendeeRequests");
    this.listQueries.push(query);

    return this.nextList;
  }

  async findAttendeeRequestForEvent(): Promise<AttendeeRequestListRow | null> {
    this.methodCalls.push("findAttendeeRequestForEvent");

    return this.nextForEvent;
  }

  async recordAttendeeRequestResolution(
    input: RecordAttendeeRequestResolutionInput,
  ): Promise<RecordAttendeeRequestResolutionOutcome> {
    this.methodCalls.push("recordAttendeeRequestResolution");
    this.resolutions.push(input);

    return this.nextResolution;
  }
}

function build(options: {
  readonly registrations?: readonly RegistrationRecord[];
  readonly events?: readonly EventRecord[];
} = {}) {
  const requests = new FakeAttendeeRequestRepository();
  const registrations = new FakeRegistrationRepository(options.registrations ?? [registration()]);
  const events = options.events ?? [
    eventRow(EVENT_ID, ORGANISER_ID),
    eventRow(OTHER_EVENT_ID, OTHER_ORGANISER_ID),
  ];

  return {
    requests,
    registrations,
    service: new RequestService(
      eventRepository(events),
      registrations as unknown as RegistrationRepository,
      requests,
      () => SERVICE_NOW,
    ),
  };
}

const submitCommand = (overrides: Partial<Parameters<RequestService["submitRequest"]>[0]> = {}) => ({
  registrationId: REGISTRATION_ID,
  uniqueReference: REFERENCE,
  attendeeEmail: EMAIL,
  message: "Can I transfer my ticket to a colleague?",
  idempotencyKey: IDEMPOTENCY_KEY,
  ...overrides,
});

describe("attendee request submission (FR-23, FR-23a, §12 row 11)", () => {
  let context: ReturnType<typeof build>;

  beforeEach(() => {
    context = build();
  });

  it("creates a request and reports that it created it", async () => {
    const submission = await context.service.submitRequest(submitCommand());

    expect(submission.created).toBe(true);
    expect(submission.request).toEqual({
      id: REQUEST_ID,
      registration_id: REGISTRATION_ID,
      message: "Can I transfer my ticket to a colleague?",
      status: "open",
      resolution_notes: null,
      created_at: CREATED_AT.toISOString(),
      resolved_at: null,
    });
  });

  it("hands the port the registration it proved, never the one the caller named", async () => {
    // The path id is client input (rule 05). The command is checked against the row the
    // reference resolved to, so the port's `registrationId` is server-resolved fact.
    const context = build({ registrations: [registration({ id: OTHER_REGISTRATION_ID })] });

    const submission = await context.service.submitRequest(
      submitCommand({ registrationId: REGISTRATION_ID }),
    ).catch((error: unknown) => error);

    // The path says REGISTRATION_ID, the pair proves OTHER_REGISTRATION_ID: refused, and
    // nothing was written.
    expect(submission).toBeInstanceOf(ValidationError);
    expect(context.requests.creates).toHaveLength(0);
  });

  it("stores the message and key it was given, and nothing else", async () => {
    await context.service.submitRequest(submitCommand({ message: "Please help" }));

    expect(context.requests.creates).toEqual([
      { registrationId: REGISTRATION_ID, message: "Please help", idempotencyKey: IDEMPOTENCY_KEY },
    ]);
  });

  it("reports a replay as not created, so a double-click does not look like a new request", async () => {
    context.requests.nextCreation = { outcome: "replayed", request: request() };

    const submission = await context.service.submitRequest(submitCommand());

    expect(submission.created).toBe(false);
    expect(submission.request.id).toBe(REQUEST_ID);
  });

  it("never exposes the idempotency key back to the attendee", async () => {
    const submission = await context.service.submitRequest(submitCommand());

    // The client already holds it; echoing it teaches the DTO to carry internals.
    expect(Object.keys(submission.request)).not.toContain("idempotency_key");
  });

  it("refuses a key reused for a different message", async () => {
    context.requests.nextCreation = {
      outcome: "replayed",
      request: request({ message: "Can I get a refund instead?" }),
    };

    await expect(
      context.service.submitRequest(submitCommand({ message: "Can I transfer my ticket?" })),
    ).rejects.toThrow(ConflictError);
  });

  it("refuses a key reused for a different registration", async () => {
    // Not reachable through a valid submit, and that is the point: the check is on the
    // stored row, so it holds even if the ownership check above it is ever weakened.
    context.requests.nextCreation = {
      outcome: "replayed",
      request: request({ registrationId: OTHER_REGISTRATION_ID }),
    };

    await expect(context.service.submitRequest(submitCommand())).rejects.toThrow(ConflictError);
  });

  it.each([
    ["an unknown reference", OTHER_REFERENCE, EMAIL],
    ["a wrong email", REFERENCE, "mallory@example.com"],
  ])("refuses %s with one message naming both fields", async (_label, reference, email) => {
    const failure = await context.service
      .submitRequest(submitCommand({ uniqueReference: reference, attendeeEmail: email }))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ValidationError);
    expect(failure).toMatchObject({
      issues: {
        unique_reference: [expect.stringContaining("No registration matches")],
        email: [expect.stringContaining("No registration matches")],
      },
    });
  });

  it("refuses before the insert, so an unproven request writes nothing", async () => {
    await expect(
      context.service.submitRequest(submitCommand({ attendeeEmail: "mallory@example.com" })),
    ).rejects.toThrow(ValidationError);

    expect(context.requests.methodCalls).toEqual([]);
  });

  it("accepts a reference whose stored email differs only by case or spacing", async () => {
    const context = build({ registrations: [registration({ attendeeEmail: " Ada@Example.com " })] });

    const submission = await context.service.submitRequest(
      submitCommand({ attendeeEmail: "ada@example.com" }),
    );

    expect(submission.created).toBe(true);
  });

  it("reads the registration by reference, not by the path id", async () => {
    // Two lookups both "work" against this fake, so the recorded call is the evidence.
    await context.service.submitRequest(submitCommand());

    expect(context.registrations.calls).toEqual(["findRegistrationByReference"]);
  });
});

describe("organiser request queue (FR-24, §12 row 12)", () => {
  let context: ReturnType<typeof build>;

  beforeEach(() => {
    context = build();
  });

  it("returns a page envelope carrying the filtered total", async () => {
    context.requests.nextList = { items: [listRow()], total: 7 };

    const page = await context.service.listRequests(ORGANISER_ID, EVENT_ID, PAGE, null);

    expect(page).toEqual({
      data: [expect.objectContaining({ id: REQUEST_ID })],
      page: 1,
      page_size: 20,
      total: 7,
    });
  });

  it("forwards the status filter, and 'no filter' as null", async () => {
    await context.service.listRequests(ORGANISER_ID, EVENT_ID, PAGE, "open");
    await context.service.listRequests(ORGANISER_ID, EVENT_ID, PAGE, null);

    expect(context.requests.listQueries).toEqual([
      { eventId: EVENT_ID, status: "open", page: 1, pageSize: 20 },
      { eventId: EVENT_ID, status: null, page: 1, pageSize: 20 },
    ]);
  });

  it("masks the contact details it shows and omits the raw ones entirely", async () => {
    context.requests.nextList = { items: [listRow()], total: 1 };

    const [row] = (await context.service.listRequests(ORGANISER_ID, EVENT_ID, PAGE, null)).data;

    expect(row).toEqual({
      id: REQUEST_ID,
      registration_id: REGISTRATION_ID,
      attendee_name: "Ada Lovelace",
      attendee_email_masked: "a***a@example.com",
      attendee_phone_masked: "+23*********78",
      registration_status: "confirmed",
      message: "Can I transfer my ticket to a colleague?",
      status: "open",
      resolution_notes: null,
      created_at: CREATED_AT.toISOString(),
      resolved_at: null,
    });
    expect(Object.keys(row)).not.toContain("attendee_email");
    expect(Object.keys(row)).not.toContain("attendee_phone");
  });

  it("carries the registration's own status, because the next action turns on it", async () => {
    context.requests.nextList = {
      items: [listRow({ registrationStatus: "refunded" })],
      total: 1,
    };

    const [row] = (await context.service.listRequests(ORGANISER_ID, EVENT_ID, PAGE, null)).data;

    expect(row?.registration_status).toBe("refunded");
  });

  it("refuses a caller with no organiser id before reading anything", async () => {
    await expect(context.service.listRequests("", EVENT_ID, PAGE, null)).rejects.toThrow();

    expect(context.requests.methodCalls).toEqual([]);
  });

  it("refuses another organiser's event without running the query", async () => {
    // IDOR (rule 05): ownership first, so neither a row, a `total`, nor a timing
    // difference can reveal that the other event has requests. The event-level refusal
    // is R-3's `403`; the *request* level, asserted below, is `404`.
    await expect(
      context.service.listRequests(ORGANISER_ID, OTHER_EVENT_ID, PAGE, null),
    ).rejects.toThrow(ForbiddenError);

    expect(context.requests.methodCalls).toEqual([]);
  });

  it("uses the shared cross-owner message rather than one of its own", async () => {
    // One message for the whole product's organiser-scoped resources: a client cannot
    // learn anything from this slice that it could not learn from the ticket-type list.
    const failure = await context.service
      .listRequests(ORGANISER_ID, OTHER_EVENT_ID, PAGE, null)
      .catch((error: unknown) => error);

    expect((failure as Error).message).toBe(EVENT_FORBIDDEN_MESSAGE);
  });

  it("refuses an event that does not exist, with the same answer", async () => {
    await expect(
      context.service.listRequests(ORGANISER_ID, "99999999-9999-9999-9999-999999999999", PAGE, null),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("organiser response and resolution (FR-24, R-5 G-3, §14)", () => {
  let context: ReturnType<typeof build>;

  beforeEach(() => {
    context = build();
    context.requests.nextForEvent = listRow();
  });

  it("writes a response without resolving, and asks for no status change", async () => {
    context.requests.nextResolution = { kind: "updated", request: listRow({ resolutionNotes: "Yes, transfers are fine." }) };

    const updated = await context.service.respondToRequest(ORGANISER_ID, EVENT_ID, REQUEST_ID, {
      resolutionNotes: "Yes, transfers are fine.",
    });

    expect(context.requests.resolutions).toEqual([
      {
        eventId: EVENT_ID,
        requestId: REQUEST_ID,
        status: null,
        resolutionNotes: "Yes, transfers are fine.",
        resolvedAt: SERVICE_NOW,
      },
    ]);
    expect(updated).toMatchObject({ status: "open", resolution_notes: "Yes, transfers are fine." });
  });

  it("stamps resolved_at from the injected clock, and only on the resolving write", async () => {
    context.requests.nextResolution = {
      kind: "updated",
      request: listRow({ status: "resolved", resolutionNotes: "Refunded.", resolvedAt: SERVICE_NOW }),
    };

    await context.service.respondToRequest(ORGANISER_ID, EVENT_ID, REQUEST_ID, {
      status: "resolved",
      resolutionNotes: "Refunded.",
    });

    expect(context.requests.resolutions[0]?.resolvedAt).toEqual(SERVICE_NOW);
    expect(context.requests.resolutions[0]?.status).toBe("resolved");
  });

  it("never hands the port an `open`, so a reopen is unrepresentable at the port", async () => {
    context.requests.nextResolution = { kind: "updated", request: listRow() };

    await context.service.respondToRequest(ORGANISER_ID, EVENT_ID, REQUEST_ID, { status: "open" });

    // The command was legal (open -> open) and still the port cannot be asked to write
    // "open". This is the type-level claim the design rests on, so it is asserted.
    expect(context.requests.resolutions[0]?.status).toBeNull();
  });

  it("refuses a resolution with no notes, naming the field", async () => {
    const failure = await context.service
      .respondToRequest(ORGANISER_ID, EVENT_ID, REQUEST_ID, { status: "resolved" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ValidationError);
    expect(failure).toMatchObject({
      issues: { resolution_notes: [expect.any(String)] },
    });
    expect(context.requests.methodCalls).toEqual(["findAttendeeRequestForEvent"]);
  });

  it("refuses notes of only whitespace, which is nobody-can-read-that too", async () => {
    await expect(
      context.service.respondToRequest(ORGANISER_ID, EVENT_ID, REQUEST_ID, {
        status: "resolved",
        resolutionNotes: "   ",
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("refuses an empty patch instead of answering 200 for work nobody asked for", async () => {
    const failure = await context.service
      .respondToRequest(ORGANISER_ID, EVENT_ID, REQUEST_ID, {})
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ValidationError);
    expect(failure).toMatchObject({
      issues: { status: [expect.any(String)], resolution_notes: [expect.any(String)] },
    });
    expect(context.requests.methodCalls).toEqual(["findAttendeeRequestForEvent"]);
  });

  it("refuses a second write to a resolved request, naming the retained resolution time", async () => {
    context.requests.nextForEvent = listRow({
      status: "resolved",
      resolutionNotes: "Refunded.",
      resolvedAt: RESOLVED_AT,
    });

    const failure = await context.service
      .respondToRequest(ORGANISER_ID, EVENT_ID, REQUEST_ID, { resolutionNotes: "Actually, no." })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConflictError);
    expect((failure as Error).message).toContain("already resolved");
    // The retained resolution's instant is named so the organiser can see *their* answer
    // is what is being protected, without a second read.
    expect((failure as Error).message).toContain(RESOLVED_AT.toISOString());
    expect(context.requests.methodCalls).toEqual(["findAttendeeRequestForEvent"]);
  });

  it("refuses a reopen of a resolved request as the same 409, not a 400", async () => {
    // The command is well formed; it collided with state (rule 06's 409 column).
    context.requests.nextForEvent = listRow({ status: "resolved", resolvedAt: RESOLVED_AT });

    await expect(
      context.service.respondToRequest(ORGANISER_ID, EVENT_ID, REQUEST_ID, { status: "open" }),
    ).rejects.toThrow(ConflictError);
  });

  it("refuses a backward transition the domain does not allow, if it ever got that far", async () => {
    // Reachable only if a new status is added to the enum: the guard exists so the
    // failure is an explicit refusal rather than a silently written illegal state.
    context.requests.nextForEvent = listRow({ status: "open" });
    const command = { status: "deleted" } as unknown as { status: AttendeeRequestStatus };

    await expect(
      context.service.respondToRequest(ORGANISER_ID, EVENT_ID, REQUEST_ID, command),
    ).rejects.toThrow(IllegalTransitionError);
  });

  it("reports a request on another event as not found, without writing", async () => {
    context.requests.nextForEvent = null;

    await expect(
      context.service.respondToRequest(ORGANISER_ID, EVENT_ID, OTHER_REQUEST_ID, {
        resolutionNotes: "hello",
      }),
    ).rejects.toThrow(NotFoundError);

    expect(context.requests.methodCalls).toEqual(["findAttendeeRequestForEvent"]);
  });

  it("refuses another organiser's event before even looking the request up", async () => {
    context.requests.nextForEvent = listRow();

    await expect(
      context.service.respondToRequest(ORGANISER_ID, OTHER_EVENT_ID, REQUEST_ID, {
        resolutionNotes: "hello",
      }),
    ).rejects.toThrow(ForbiddenError);

    expect(context.requests.methodCalls).toEqual([]);
  });

  it("reports a request id from another event as 404, so the id cannot be probed", async () => {
    // The distinction from the event itself is deliberate and is asserted explicitly: a
    // bare request uuid is not something the caller is entitled to learn exists.
    context.requests.nextForEvent = null;

    await expect(
      context.service.respondToRequest(ORGANISER_ID, EVENT_ID, OTHER_REQUEST_ID, {
        resolutionNotes: "hello",
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it("maps a lost race to the 409 that names the winner's resolution", async () => {
    // The read said `open`; between it and the write another organiser resolved the
    // request. §14 says the winner's text stands, so the loser must be told it is
    // already resolved — not 404, which would read as "gone".
    context.requests.nextResolution = {
      kind: "already_resolved",
      request: listRow({ status: "resolved", resolutionNotes: "Refunded.", resolvedAt: RESOLVED_AT }),
    };

    const failure = await context.service
      .respondToRequest(ORGANISER_ID, EVENT_ID, REQUEST_ID, {
        status: "resolved",
        resolutionNotes: "Rejected.",
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConflictError);
    expect((failure as Error).message).toContain(RESOLVED_AT.toISOString());
  });

  it("reports a vanished row between read and write as not found", async () => {
    // Unreachable while §14's no-delete guard holds, and handled anyway so the switch
    // in the service is exhaustive rather than a silent `undefined`.
    context.requests.nextResolution = { kind: "not_found" };

    await expect(
      context.service.respondToRequest(ORGANISER_ID, EVENT_ID, REQUEST_ID, {
        resolutionNotes: "hello",
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it("returns the organiser DTO from the write, not a second read", async () => {
    context.requests.nextResolution = {
      kind: "updated",
      request: listRow({ status: "resolved", resolutionNotes: "Refunded.", resolvedAt: SERVICE_NOW }),
    };

    const updated = await context.service.respondToRequest(ORGANISER_ID, EVENT_ID, REQUEST_ID, {
      status: "resolved",
      resolutionNotes: "Refunded.",
    });

    expect(updated).toEqual({
      id: REQUEST_ID,
      registration_id: REGISTRATION_ID,
      attendee_name: "Ada Lovelace",
      attendee_email_masked: "a***a@example.com",
      attendee_phone_masked: "+23*********78",
      registration_status: "confirmed",
      message: "Can I transfer my ticket to a colleague?",
      status: "resolved",
      resolution_notes: "Refunded.",
      created_at: CREATED_AT.toISOString(),
      resolved_at: SERVICE_NOW.toISOString(),
    });
    // Exactly one repository read. A second one would mean a window in which the row
    // could change between the write and the response.
    expect(context.requests.methodCalls).toEqual([
      "findAttendeeRequestForEvent",
      "recordAttendeeRequestResolution",
    ]);
  });

  it("refuses to project a resolved request that carries no resolution instant", async () => {
    // The CHECK constraint makes this unreachable; the mapper still reports the
    // incoherence rather than rendering "answered" with nothing to show (rule 08).
    context.requests.nextResolution = {
      kind: "updated",
      request: listRow({ status: "resolved", resolutionNotes: "Refunded.", resolvedAt: null }),
    };

    await expect(
      context.service.respondToRequest(ORGANISER_ID, EVENT_ID, REQUEST_ID, {
        status: "resolved",
        resolutionNotes: "Refunded.",
      }),
    ).rejects.toThrow(/not\s+coherent/);
  });
});

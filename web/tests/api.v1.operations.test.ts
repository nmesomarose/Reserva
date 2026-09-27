import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The organiser operations routes: the dashboard snapshot, its stream, and FR-26's
 * single-registration record (PRD v2 §5.9, §12 row 13, R-5 G-1/G-2; FR-22, FR-25, FR-26).
 *
 * What is worth proving at this layer, and why it is not already covered below:
 *
 *   - **Ownership is settled before the response exists.** All three routes resolve the
 *     session first, so a caller with no session gets `401` and a caller who does not own
 *     the event gets `403` — and on the stream, both arrive as real status codes rather
 *     than as an error event inside a stream they were never entitled to open. A stream
 *     that answers `200` and then reports the problem in-band has already leaked the fact
 *     that something exists.
 *   - **Path segments are validated before they reach the adapter.** The ownership read
 *     casts to `uuid`, so `events/jazz-night` — a perfectly reasonable-looking slug —
 *     would come back as a `500` from the cast rather than the `400` it is.
 *   - **The stream's headers are load-bearing**, not decoration. See the individual tests.
 *
 * The aggregate arithmetic, the FR-26 ordering, and the stream's frame contents are all
 * proven in the layer that owns them (`operations.service.test.ts`,
 * `operations.db.test.ts`, `dashboard-stream.test.ts`). What is left here is the wiring:
 * who is asked, in what order, and what comes back over HTTP.
 */

const ORGANISER_ID = "11111111-1111-1111-1111-111111111111";
const EVENT_ID = "22222222-2222-2222-2222-222222222222";
const REGISTRATION_ID = "33333333-3333-3333-3333-333333333333";

const { getOperationsService, resolve } = vi.hoisted(() => ({
  getOperationsService: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock("@/server/db/container", () => ({ getOperationsService }));
vi.mock("@/server/auth/organiser-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/organiser-context")>();

  return { ...actual, organiserContextResolver: { resolve } };
});

import { GET as GET_DASHBOARD } from "@/app/api/v1/events/[identifier]/dashboard/route";
import { GET as OPEN_DASHBOARD_STREAM } from "@/app/api/v1/events/[identifier]/dashboard/stream/route";
import { GET as GET_REGISTRATION_RECORD } from "@/app/api/v1/events/[identifier]/registrations/[registrationId]/route";
import { ForbiddenError, NotFoundError, UnauthenticatedError } from "@/domain/errors";

const service = {
  getDashboard: vi.fn(),
  authoriseEvent: vi.fn(),
  readDashboardForEvent: vi.fn(),
  getRegistrationRecord: vi.fn(),
};

const DASHBOARD = {
  event: {
    id: EVENT_ID,
    name: "Jazz Night",
    slug: "jazz-night",
    status: "published",
    starts_at: "2026-10-01T18:00:00.000Z",
    ends_at: "2026-10-01T22:00:00.000Z",
    venue: "Riverside Hall",
  },
  registrations: {
    total: 10,
    by_status: { pending_payment: 1, confirmed: 7, checked_in: 2, cancelled: 1, refunded: 0 },
  },
  payments: {
    attempts: 9,
    by_status: { initiated: 0, processing: 0, success: 8, failed: 1, pending: 0 },
    requires_reconciliation: 0,
  },
  ticket_types: [],
  check_ins: { registrations_checked_in: 2, entries: 2, overrides: 0 },
  generated_at: "2026-10-01T18:30:00.000Z",
};

const RECORD = {
  event: DASHBOARD.event,
  registration: {
    id: REGISTRATION_ID,
    unique_reference: "REF-0123456789",
    attendee_name: "Ada Lovelace",
    attendee_email: "ada@example.com",
    attendee_phone: "+15550100",
    status: "checked_in",
    created_at: "2026-09-20T10:00:00.000Z",
  },
  ticket_type: {
    id: "44444444-4444-4444-4444-444444444444",
    name: "General Admission",
    price_minor_units: 2500,
    currency: "USD",
    quantity_total: 100,
    quantity_confirmed: 7,
    quantity_held: 1,
  },
  payments: [
    {
      id: "55555555-5555-5555-5555-555555555555",
      provider_reference: "pi_123",
      status: "success",
      expected_amount_minor_units: 2500,
      verified_amount_minor_units: 2500,
      currency: "USD",
      verified_at: "2026-09-20T10:01:00.000Z",
      requires_reconciliation: false,
      created_at: "2026-09-20T10:00:30.000Z",
      raw_provider_payload: { id: "pi_123", livemode: false },
      updated_at: "2026-09-20T10:01:00.000Z",
    },
  ],
  check_ins: [
    {
      id: "66666666-6666-6666-6666-666666666666",
      checked_in_at: "2026-10-01T18:10:00.000Z",
      is_override: false,
      performed_by: { kind: "staff", id: "77777777-7777-7777-7777-777777777777" },
    },
  ],
};

const dashboardParams = (identifier: string) => ({ params: Promise.resolve({ identifier }) });
const recordParams = (identifier: string, registrationId: string) => ({
  params: Promise.resolve({ identifier, registrationId }),
});
const get = (url: string) => new Request(url);
const DASHBOARD_URL = `http://localhost/api/v1/events/${EVENT_ID}/dashboard`;
const STREAM_URL = `http://localhost/api/v1/events/${EVENT_ID}/dashboard/stream`;
const RECORD_URL = `http://localhost/api/v1/events/${EVENT_ID}/registrations/${REGISTRATION_ID}`;

beforeEach(() => {
  // `resetAllMocks`, not `clearAllMocks`: a `mockRejectedValue` left over from an
  // ownership test would otherwise still be in place, and the next test would report
  // somebody else's `403` as its own result.
  vi.resetAllMocks();
  getOperationsService.mockReturnValue(service);
  resolve.mockResolvedValue({ organiserId: ORGANISER_ID });
  service.getDashboard.mockResolvedValue(DASHBOARD);
  service.authoriseEvent.mockResolvedValue({ id: EVENT_ID });
  service.getRegistrationRecord.mockResolvedValue(RECORD);
});

describe("GET /api/v1/events/{id}/dashboard", () => {
  it("answers the aggregate for the session's organiser", async () => {
    const response = await GET_DASHBOARD(get(DASHBOARD_URL), dashboardParams(EVENT_ID));

    expect(response.status).toBe(200);
    // The organiser id comes from the session, never from the path: a caller who put
    // another organiser's id in the URL would be asking about somebody else's event.
    expect(service.getDashboard).toHaveBeenCalledWith(ORGANISER_ID, EVENT_ID);
  });

  it("passes the service's DTO through without reshaping it", async () => {
    const response = await GET_DASHBOARD(get(DASHBOARD_URL), dashboardParams(EVENT_ID));

    // No key renamed, no key dropped. The service owns the contract; a route that
    // reshaped on the way out would make the stream and the snapshot disagree, and they
    // are required to be the same bytes (R-5 G-2).
    expect(await response.json()).toEqual(DASHBOARD);
  });

  it("never caches", async () => {
    const response = await GET_DASHBOARD(get(DASHBOARD_URL), dashboardParams(EVENT_ID));

    // A cached dashboard is a dashboard that is wrong by however long the cache lived.
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("answers 403 with code unauthenticated for a request with no session", async () => {
    // `403`, not `401`: the contract defines no `401`, and both PRD §15 L421 and rule 06
    // assign `403` to access-control failure. The `unauthenticated` *code* still
    // distinguishes "no session" from "not the owner", but the status is one number.
    resolve.mockRejectedValue(new UnauthenticatedError("No session."));

    const response = await GET_DASHBOARD(get(DASHBOARD_URL), dashboardParams(EVENT_ID));

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("unauthenticated");
    // Auth first: a request for someone else's event must not even reach the ownership
    // read, or the two failures become distinguishable.
    expect(service.getDashboard).not.toHaveBeenCalled();
  });

  it("answers 403 for an event the organiser does not own", async () => {
    service.getDashboard.mockRejectedValue(new ForbiddenError("Not your event."));

    const response = await GET_DASHBOARD(get(DASHBOARD_URL), dashboardParams(EVENT_ID));

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("forbidden");
  });

  it("answers 400 for a path that is not a UUID, naming the field", async () => {
    // The repository casts this to `uuid` in its ownership read, so without a check here
    // a slug-shaped typo would surface as a `500` from the cast.
    const response = await GET_DASHBOARD(
      get("http://localhost/api/v1/events/jazz-night/dashboard"),
      dashboardParams("jazz-night"),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.fields.identifier).toBeDefined();
    // Validated before the service, so no read is attempted against a bad id.
    expect(service.getDashboard).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/events/{id}/registrations/{registration_id} (FR-26)", () => {
  it("answers the full record for the session's organiser", async () => {
    const response = await GET_REGISTRATION_RECORD(get(RECORD_URL), recordParams(EVENT_ID, REGISTRATION_ID));

    expect(response.status).toBe(200);
    expect(service.getRegistrationRecord).toHaveBeenCalledWith(ORGANISER_ID, EVENT_ID, REGISTRATION_ID);
  });

  it("returns unmasked contact details, which is the point of the organiser view", async () => {
    const response = await GET_REGISTRATION_RECORD(get(RECORD_URL), recordParams(EVENT_ID, REGISTRATION_ID));
    const body = await response.json();

    // The attendee-facing DTO masks these; here the organiser already holds the booking,
    // and rule 08's organiser exception applies.
    expect(body.registration.attendee_email).toBe("ada@example.com");
    expect(body.registration.attendee_phone).toBe("+15550100");
  });

  it("includes the raw provider payload, the only place it appears", async () => {
    const response = await GET_REGISTRATION_RECORD(get(RECORD_URL), recordParams(EVENT_ID, REGISTRATION_ID));

    // §14 keeps the provider response for dispute resolution. A summary here would be a
    // second thing to keep faithful, and the audit view is the whole reason for it.
    expect((await response.json()).payments[0].raw_provider_payload).toEqual({
      id: "pi_123",
      livemode: false,
    });
  });

  it("passes the service's DTO through without reshaping it", async () => {
    const response = await GET_REGISTRATION_RECORD(get(RECORD_URL), recordParams(EVENT_ID, REGISTRATION_ID));

    expect(await response.json()).toEqual(RECORD);
  });

  it("never caches", async () => {
    const response = await GET_REGISTRATION_RECORD(get(RECORD_URL), recordParams(EVENT_ID, REGISTRATION_ID));

    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("answers 403 with code unauthenticated for a request with no session", async () => {
    resolve.mockRejectedValue(new UnauthenticatedError("No session."));

    const response = await GET_REGISTRATION_RECORD(get(RECORD_URL), recordParams(EVENT_ID, REGISTRATION_ID));

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("unauthenticated");
    expect(service.getRegistrationRecord).not.toHaveBeenCalled();
  });

  it("answers 403 for an event the organiser does not own", async () => {
    service.getRegistrationRecord.mockRejectedValue(new ForbiddenError("Not your event."));

    const response = await GET_REGISTRATION_RECORD(get(RECORD_URL), recordParams(EVENT_ID, REGISTRATION_ID));

    expect(response.status).toBe(403);
  });

  it("answers 404 for a registration on somebody else's event", async () => {
    // Not `403`: the service scopes the registration read by `event_id` as well as by
    // owner, so an id from another event is indistinguishable from one that does not
    // exist. One answer is what stops this route confirming that an id is real.
    service.getRegistrationRecord.mockRejectedValue(new NotFoundError("Registration not found."));

    const response = await GET_REGISTRATION_RECORD(get(RECORD_URL), recordParams(EVENT_ID, REGISTRATION_ID));

    expect(response.status).toBe(404);
  });

  it.each([
    ["the event", "not-a-uuid", REGISTRATION_ID, "identifier"],
    ["the registration", EVENT_ID, "not-a-uuid", "registration_id"],
  ])("answers 400 for %s path that is not a UUID, naming the field", async (
    _label,
    identifier,
    registrationId,
    field,
  ) => {
    const response = await GET_REGISTRATION_RECORD(
      get(`http://localhost/api/v1/events/${identifier}/registrations/${registrationId}`),
      recordParams(identifier, registrationId),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.fields[field]).toBeDefined();
    expect(service.getRegistrationRecord).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/events/{id}/dashboard/stream", () => {
  it("answers 200 with a text/event-stream body", async () => {
    service.readDashboardForEvent.mockResolvedValue({
      event: {
        id: EVENT_ID,
        name: "Jazz Night",
        slug: "jazz-night",
        status: "published",
        startsAt: new Date("2026-10-01T18:00:00.000Z"),
        endsAt: new Date("2026-10-01T22:00:00.000Z"),
        venue: "Riverside Hall",
      },
      registrations: { total: 0, byStatus: { pending_payment: 0, confirmed: 0, checked_in: 0, cancelled: 0, refunded: 0 } },
      payments: { attempts: 0, byStatus: { initiated: 0, processing: 0, success: 0, failed: 0, pending: 0 }, requiresReconciliation: 0 },
      ticketTypes: [],
      checkIns: { registrationsCheckedIn: 0, entries: 0, overrides: 0 },
      generatedAt: new Date("2026-10-01T18:30:00.000Z"),
    });

    const response = await OPEN_DASHBOARD_STREAM(get(STREAM_URL), dashboardParams(EVENT_ID));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
  });

  it("forbids buffering at every layer that could introduce it", async () => {
    const response = await OPEN_DASHBOARD_STREAM(get(STREAM_URL), dashboardParams(EVENT_ID));

    // The trap this endpoint falls into is not a crash. Every header above looks
    // reasonable, the tests pass, and the organiser sees check-ins 30 seconds late
    // because a proxy is holding the bytes. A proxy that buffers turns a 2-second update
    // into a 30-second one and breaks FR-22 while the response looks perfectly correct,
    // so each of these is asserted rather than assumed.
    expect(response.headers.get("cache-control")).toContain("no-cache");
    expect(response.headers.get("cache-control")).toContain("no-transform");
    expect(response.headers.get("connection")).toBe("keep-alive");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
  });

  it("authorises the event before the response exists", async () => {
    await OPEN_DASHBOARD_STREAM(get(STREAM_URL), dashboardParams(EVENT_ID));

    // The authorised `EventRecord` is handed to the stream, which then re-reads the
    // aggregate scoped to it. `getDashboard` is deliberately not used: the stream needs
    // the event, not a DTO of it.
    expect(service.authoriseEvent).toHaveBeenCalledWith(ORGANISER_ID, EVENT_ID);
  });

  it("answers 403 with code unauthenticated, as a status code and not an event", async () => {
    resolve.mockRejectedValue(new UnauthenticatedError("No session."));

    const response = await OPEN_DASHBOARD_STREAM(get(STREAM_URL), dashboardParams(EVENT_ID));

    // A stream that answered `200` and then delivered the failure in-band has already
    // told the client something exists, and the client's only recourse — falling back to
    // `GET /dashboard` — needs a status code to act on.
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("unauthenticated");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(service.authoriseEvent).not.toHaveBeenCalled();
  });

  it("answers 403 for an event the organiser does not own, as a status code", async () => {
    service.authoriseEvent.mockRejectedValue(new ForbiddenError("Not your event."));

    const response = await OPEN_DASHBOARD_STREAM(get(STREAM_URL), dashboardParams(EVENT_ID));

    // For the same reason as the `401`: once `200` is on the wire it cannot be taken
    // back, so ownership has to be settled while a status code can still be sent.
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("answers 400 for a path that is not a UUID, naming the field", async () => {
    const response = await OPEN_DASHBOARD_STREAM(
      get("http://localhost/api/v1/events/jazz-night/dashboard/stream"),
      dashboardParams("jazz-night"),
    );

    // The same reason the other organiser routes do it, and sharper here: on this route
    // a `500` discovered after `200 OK` is not even available, so a bad id would be
    // unreportable rather than merely mis-reported.
    expect(response.status).toBe(400);
    expect((await response.json()).error.fields.identifier).toBeDefined();
    expect(service.authoriseEvent).not.toHaveBeenCalled();
  });

  it("never lets a response stand in for ownership", async () => {
    // A regression guard on the ordering itself, stated as a sequence: session, then
    // ownership, then the response. Swapping the last two is the plausible edit, and it
    // would pass every status-code test above while leaking that an event exists.
    const order: string[] = [];
    resolve.mockImplementation(async () => {
      order.push("session");
      return { organiserId: ORGANISER_ID };
    });
    service.authoriseEvent.mockImplementation(async () => {
      order.push("ownership");
      return { id: EVENT_ID };
    });

    await OPEN_DASHBOARD_STREAM(get(STREAM_URL), dashboardParams(EVENT_ID));

    expect(order).toEqual(["session", "ownership"]);
  });
});

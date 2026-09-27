import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The attendee-request routes' transport contract (PRD v2 §12 rows 11-12; FR-23,
 * FR-23a, FR-24; R-5 G-3).
 *
 *   - `POST  /api/v1/registrations/{id}/requests`  (attendee, no session)
 *   - `GET   /api/v1/events/{id}/requests`         (organiser, event owner)
 *   - `PATCH /api/v1/events/{id}/requests/{id}`    (organiser, event owner)
 *
 * `requests.service.test.ts` proves the service's decisions against a fake repository and
 * `requests.db.test.ts` proves the adapter and the schema. This file covers what only the
 * door can show:
 *
 *   - `201` for a new submission and `200` for a replay of the same key, decided by the
 *     route because it is the only layer that knows what those codes mean;
 *   - a malformed path segment is a `400` naming the field, not the `500` the `::uuid`
 *     cast would otherwise produce (this is the `P2007` defect);
 *   - identity is resolved before the path is read, so an unauthenticated caller cannot
 *     make the server spend parsing work, nor learn whether an id exists;
 *   - the queue's envelope shape, and that `total` is the *filtered* count.
 */

const ORGANISER_ID = "11111111-1111-1111-1111-111111111111";
const EVENT_ID = "22222222-2222-2222-2222-222222222222";
const REGISTRATION_ID = "33333333-3333-3333-3333-333333333333";
const REQUEST_ID = "44444444-4444-4444-4444-444444444444";

const { getRequestService, resolve } = vi.hoisted(() => ({
  getRequestService: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock("@/server/db/container", () => ({ getRequestService }));
vi.mock("@/server/auth/organiser-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/organiser-context")>();

  return { ...actual, organiserContextResolver: { resolve } };
});

import { POST as SUBMIT_REQUEST } from "@/app/api/v1/registrations/[id]/requests/route";
import { GET as LIST_REQUESTS } from "@/app/api/v1/events/[identifier]/requests/route";
import { PATCH as RESPOND_TO_REQUEST } from "@/app/api/v1/events/[identifier]/requests/[requestId]/route";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from "@/domain/errors";

const service = {
  submitRequest: vi.fn(),
  listRequests: vi.fn(),
  respondToRequest: vi.fn(),
};

/** 42 URL-safe characters, the shape a printed reference has. */
const REFERENCE = "TestReference_0123456789abcdefghijABCDEFGH";
const EMAIL = "ada@example.com";
const IDEMPOTENCY_KEY = "55555555-5555-5555-5555-555555555555";

const submitParams = (id: string) => ({ params: Promise.resolve({ id }) });
const eventParams = (identifier: string) => ({ params: Promise.resolve({ identifier }) });
const requestParams = (identifier: string, requestId: string) => ({
  params: Promise.resolve({ identifier, requestId }),
});

const postJson = (url: string, body: unknown) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const patchJson = (url: string, body: unknown) =>
  new Request(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const SUBMITTED = {
  id: REQUEST_ID,
  registration_id: REGISTRATION_ID,
  message: "Can I transfer my ticket?",
  status: "open",
  created_at: "2026-10-01T18:30:00.000Z",
  resolved_at: null,
  resolution_notes: null,
};

const QUEUE_ROW = {
  id: REQUEST_ID,
  registration_id: REGISTRATION_ID,
  attendee_name: "Ada Lovelace",
  attendee_email_masked: "a***@example.com",
  attendee_phone_masked: "+234****5678",
  registration_status: "confirmed",
  message: "Can I transfer my ticket?",
  status: "open",
  resolution_notes: null,
  created_at: "2026-10-01T18:30:00.000Z",
  resolved_at: null,
};

beforeEach(() => {
  // `resetAllMocks`, not `clearAllMocks`: clearing only wipes the call log, so a
  // `mockRejectedValue` set by one test (a `403` for someone else's event, say) would
  // still be in place for the next one and be reported as its result. That turns a
  // later test's real outcome into an earlier test's leftover — the failure mode is a
  // `403` where a `400` was expected, which reads like a routing bug and is not one.
  vi.resetAllMocks();
  getRequestService.mockReturnValue(service);
  resolve.mockResolvedValue({ organiserId: ORGANISER_ID });
});

// ---------------------------------------------------------------------------
// POST /api/v1/registrations/{id}/requests
// ---------------------------------------------------------------------------

describe("POST /api/v1/registrations/{id}/requests", () => {
  const validBody = {
    unique_reference: REFERENCE,
    email: EMAIL,
    message: "Can I transfer my ticket?",
    idempotency_key: IDEMPOTENCY_KEY,
  };

  const call = (body: unknown, id: string = REGISTRATION_ID) =>
    SUBMIT_REQUEST(
      postJson(`http://localhost/api/v1/registrations/${id}/requests`, body),
      submitParams(id),
    );

  it("answers 201 for a submission that created a request", async () => {
    service.submitRequest.mockResolvedValue({ request: SUBMITTED, created: true });

    const response = await call(validBody);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(SUBMITTED);
  });

  it("answers 200 for a replay of the same key, with the same body", async () => {
    // The distinction a double-clicking client depends on: FR-23a's debounce is one
    // request, so telling the client it created a second one would be a lie the
    // organiser's queue would expose.
    service.submitRequest.mockResolvedValue({ request: SUBMITTED, created: false });

    const response = await call(validBody);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(SUBMITTED);
  });

  it("passes the command through with the path id, so the service can check they agree", async () => {
    service.submitRequest.mockResolvedValue({ request: SUBMITTED, created: true });

    await call(validBody);

    // The body proves ownership and the path names the registration; the service
    // compares them, so a client cannot file against somebody else's id.
    expect(service.submitRequest).toHaveBeenCalledWith({
      registrationId: REGISTRATION_ID,
      uniqueReference: REFERENCE,
      attendeeEmail: EMAIL,
      message: validBody.message,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
  });

  it("needs no session, so an unauthenticated caller is not refused", async () => {
    // Auth is **none, possession of the ticket** (§12 row 11). The attendee has no
    // account; the body is the credential.
    service.submitRequest.mockResolvedValue({ request: SUBMITTED, created: true });

    const response = await call(validBody);

    expect(response.status).toBe(201);
  });

  it("answers 403 for a proof that does not match, as one undifferentiated refusal", async () => {
    service.submitRequest.mockRejectedValue(
      new ForbiddenError("No ticket matches those details."),
    );

    const response = await call(validBody);

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("forbidden");
  });

  it("answers 409 when the same key is reused with a materially different body", async () => {
    // Silently succeeding would file the new message nowhere and report success, which
    // is worse than an error.
    service.submitRequest.mockRejectedValue(
      new ConflictError(
        "That idempotency key was already used for a different request.",
      ),
    );

    const response = await call(validBody);

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("conflict");
  });

  it("answers 404 for a registration that does not exist", async () => {
    service.submitRequest.mockRejectedValue(
      new NotFoundError("That registration does not exist."),
    );

    const response = await call(validBody);

    expect(response.status).toBe(404);
  });

  it("answers 400 for a path id that is not a UUID, without calling the service", async () => {
    // The cast this prevents: `where id = 'not-a-uuid'::uuid` is `P2007`, which reaches
    // the client as a `500 internal_error` and is indistinguishable from a database
    // outage. A typo deserves a `400` that names the field.
    const response = await call(validBody, "not-a-uuid");

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.fields.id).toBeDefined();
    expect(service.submitRequest).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing unique_reference", { ...validBody, unique_reference: undefined }],
    ["a missing email", { ...validBody, email: undefined }],
    ["a missing message", { ...validBody, message: undefined }],
    ["a missing idempotency_key", { ...validBody, idempotency_key: undefined }],
    ["an empty message", { ...validBody, message: "" }],
    ["a whitespace-only message", { ...validBody, message: "   " }],
    ["an idempotency_key that is not a UUID", { ...validBody, idempotency_key: "abc" }],
    ["a non-string message", { ...validBody, message: 42 }],
    ["an unknown field", { ...validBody, admin: true }],
  ])("answers 400 for %s", async (_label, body) => {
    const response = await call(body);

    expect(response.status).toBe(400);
    expect(service.submitRequest).not.toHaveBeenCalled();
  });

  it("answers 400 for a body that is not JSON at all", async () => {
    const response = await SUBMIT_REQUEST(
      new Request("http://localhost/api/v1/registrations/x/requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
      submitParams(REGISTRATION_ID),
    );

    expect(response.status).toBe(400);
    expect(service.submitRequest).not.toHaveBeenCalled();
  });

  it("answers 400 when the body names a different registration than the path", async () => {
    // §12 makes this a field-level `400`, deliberately not the evidence endpoint's
    // `403`: the two inputs contradict each other, and §12 gives each endpoint its own
    // code. The parser catches it before the service is reached.
    const response = await call({ ...validBody, registration_id: REGISTRATION_ID }, OTHER_REGISTRATION_ID);

    expect(response.status).toBe(400);
    expect(service.submitRequest).not.toHaveBeenCalled();
  });
});

const OTHER_REGISTRATION_ID = "66666666-6666-6666-6666-666666666666";

// ---------------------------------------------------------------------------
// GET /api/v1/events/{id}/requests
// ---------------------------------------------------------------------------

describe("GET /api/v1/events/{id}/requests", () => {
  const call = (query = "") =>
    LIST_REQUESTS(
      new Request(`http://localhost/api/v1/events/${EVENT_ID}/requests${query}`),
      eventParams(EVENT_ID),
    );

  it("returns the paginated envelope with masked contact details", async () => {
    service.listRequests.mockResolvedValue({
      data: [QUEUE_ROW],
      page: 1,
      page_size: 20,
      total: 1,
    });

    const response = await call();

    expect(response.status).toBe(200);
    const body = await response.json();

    // Rule 06's envelope. `data` and not `items`, so every list in the API is the same
    // shape a client can page without special-casing.
    expect(body).toEqual({ data: [QUEUE_ROW], page: 1, page_size: 20, total: 1 });
    // A queue is a working list, not a contact export (§13). The name is present because
    // a queue is unusable without knowing who is asking.
    expect(body.data[0]).not.toHaveProperty("attendee_email");
    expect(body.data[0]).not.toHaveProperty("attendee_phone");
  });

  it("answers 200 with an empty data array rather than 404", async () => {
    // §4.4.1 asks for an explicit empty state; an empty queue is the normal state of a
    // quiet event, not an error.
    service.listRequests.mockResolvedValue({
      data: [],
      page: 1,
      page_size: 20,
      total: 0,
    });

    const response = await call();

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual([]);
  });

  it("passes the session's organiser id and the page through, and no status filter", async () => {
    service.listRequests.mockResolvedValue({ data: [], page: 1, page_size: 20, total: 0 });

    await call();

    // The path id is never the scope: it selects which event to *check*. Ownership is
    // decided by comparing it against the session's organiser id inside the service.
    expect(service.listRequests).toHaveBeenCalledWith(
      ORGANISER_ID,
      EVENT_ID,
      { page: 1, pageSize: 20 },
      null,
    );
  });

  it("forwards a status filter so the total is the filtered count", async () => {
    service.listRequests.mockResolvedValue({ data: [], page: 1, page_size: 20, total: 0 });

    await call("?status=open");

    expect(service.listRequests).toHaveBeenCalledWith(
      ORGANISER_ID,
      EVENT_ID,
      { page: 1, pageSize: 20 },
      "open",
    );
  });

  it("forwards pagination", async () => {
    service.listRequests.mockResolvedValue({ data: [], page: 3, page_size: 10, total: 42 });

    const response = await call("?page=3&page_size=10");

    expect(service.listRequests).toHaveBeenCalledWith(
      ORGANISER_ID,
      EVENT_ID,
      { page: 3, pageSize: 10 },
      null,
    );
    expect((await response.json()).total).toBe(42);
  });

  it("answers 403 for an event owned by another organiser", async () => {
    // R-3: the event exists, so refusing it as `forbidden` is the documented answer. A
    // `404` would also hide it, but §12 assigns this code here and the shared message
    // is what keeps the two indistinguishable from a probe.
    service.listRequests.mockRejectedValue(
      new ForbiddenError("That event belongs to another organiser."),
    );

    const response = await call();

    expect(response.status).toBe(403);
  });

  it("answers 404 for an event that does not exist", async () => {
    service.listRequests.mockRejectedValue(new NotFoundError("That event does not exist."));

    const response = await call();

    expect(response.status).toBe(404);
  });

  it("answers 403 and reaches no business rule without a valid session", async () => {
    resolve.mockRejectedValue(
      new UnauthenticatedError("This request has no valid organiser session."),
    );

    const response = await call();

    // 403, not 401: §15 and rule 06 define no 401.
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("unauthenticated");
    expect(service.listRequests).not.toHaveBeenCalled();
  });

  it("resolves the session before reading the path", async () => {
    resolve.mockRejectedValue(new UnauthenticatedError("no session"));

    // A path that could never be a UUID: if the route read the path first, this would
    // be a `400` and would have told an unauthenticated caller that the server had
    // validated their request.
    await LIST_REQUESTS(
      new Request("http://localhost/api/v1/events/not-a-uuid/requests"),
      eventParams("not-a-uuid"),
    );

    expect(resolve).toHaveBeenCalled();
  });

  it("answers 400 for a path that is not a UUID, without calling the service", async () => {
    const response = await LIST_REQUESTS(
      new Request("http://localhost/api/v1/events/not-a-uuid/requests"),
      eventParams("not-a-uuid"),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.fields.identifier).toBeDefined();
    expect(service.listRequests).not.toHaveBeenCalled();
  });

  it.each([
    ["status that is not a known state", "?status=maybe"],
    ["page below one", "?page=0"],
    ["a non-numeric page", "?page=abc"],
    ["a page_size above the maximum", "?page_size=1000"],
  ])("answers 400 for %s", async (_label, query) => {
    const response = await call(query);

    expect(response.status).toBe(400);
    expect(service.listRequests).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/events/{id}/requests/{request_id}
// ---------------------------------------------------------------------------

describe("PATCH /api/v1/events/{id}/requests/{request_id}", () => {
  const call = (body: unknown, requestId: string = REQUEST_ID) =>
    RESPOND_TO_REQUEST(
      patchJson(
        `http://localhost/api/v1/events/${EVENT_ID}/requests/${requestId}`,
        body,
      ),
      requestParams(EVENT_ID, requestId),
    );

  const RESOLVED = {
    ...QUEUE_ROW,
    status: "resolved",
    resolution_notes: "Refunded on Tuesday.",
    resolved_at: "2026-10-01T19:15:00.000Z",
  };

  it("answers 200 with the request after the write", async () => {
    service.respondToRequest.mockResolvedValue(RESOLVED);

    const response = await call({ status: "resolved", resolution_notes: "Refunded on Tuesday." });

    expect(response.status).toBe(200);
    // The projection is the *post-write* row: the organiser's view of their own action.
    expect(await response.json()).toEqual(RESOLVED);
  });

  it("answers 200 for a notes-only response, and the row is still open", async () => {
    const answered = { ...QUEUE_ROW, resolution_notes: "We are looking into it." };
    service.respondToRequest.mockResolvedValue(answered);

    const response = await call({ resolution_notes: "We are looking into it." });

    expect(response.status).toBe(200);
    // "I've told them" and "this is finished" stay distinguishable in the queue.
    expect((await response.json()).status).toBe("open");
  });

  it("passes both path ids and the command through", async () => {
    service.respondToRequest.mockResolvedValue(RESOLVED);

    await call({ status: "resolved", resolution_notes: "Refunded on Tuesday." });

    expect(service.respondToRequest).toHaveBeenCalledWith(
      ORGANISER_ID,
      EVENT_ID,
      REQUEST_ID,
      { status: "resolved", resolutionNotes: "Refunded on Tuesday." },
    );
  });

  it("answers 409 when the request was already resolved", async () => {
    // A volunteer cannot act on a message that does not say which happened, so this
    // names the instant and states that the retained resolution is unchanged (§14).
    service.respondToRequest.mockRejectedValue(
      new ConflictError(
        "This request was already resolved on 2026-10-01T19:15:00.000Z, and its resolution is retained unchanged.",
      ),
    );

    const response = await call({ status: "resolved", resolution_notes: "Refunded." });

    expect(response.status).toBe(409);
    expect((await response.json()).error.message).toMatch(/retained unchanged/);
  });

  it("answers 409 for a reopen, because resolved is terminal", async () => {
    // The request was well-formed; it collided with state. A `400` would claim the
    // organiser's body was wrong, which it was not.
    service.respondToRequest.mockRejectedValue(
      new ConflictError("This request was already resolved and cannot be reopened."),
    );

    const response = await call({ status: "open" });

    expect(response.status).toBe(409);
  });

  it("answers 404 for a request that is not on this event", async () => {
    // The same answer an id that does not exist gets, so the route is not an oracle
    // across tenants.
    service.respondToRequest.mockRejectedValue(
      new NotFoundError("That request is not on this event."),
    );

    const response = await call({ status: "resolved", resolution_notes: "Refunded." });

    expect(response.status).toBe(404);
  });

  it("answers 403 for an event owned by another organiser", async () => {
    // Ownership is decided before the request is read, so the refusal cannot depend on
    // whether that request id exists.
    service.respondToRequest.mockRejectedValue(
      new ForbiddenError("That event belongs to another organiser."),
    );

    const response = await call({ status: "resolved", resolution_notes: "Refunded." });

    expect(response.status).toBe(403);
  });

  it("answers 403 and reaches no business rule without a valid session", async () => {
    resolve.mockRejectedValue(
      new UnauthenticatedError("This request has no valid organiser session."),
    );

    const response = await call({ status: "resolved", resolution_notes: "Refunded." });

    expect(response.status).toBe(403);
    expect(service.respondToRequest).not.toHaveBeenCalled();
  });

  it("answers 400 for a malformed body before reading the path ids", async () => {
    // Ordering: the body is parsed first, so a `400` here is a statement about the body
    // alone. An unauthenticated caller still gets `403` — see below.
    const response = await RESPOND_TO_REQUEST(
      new Request(`http://localhost/api/v1/events/${EVENT_ID}/requests/${REQUEST_ID}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
      requestParams(EVENT_ID, REQUEST_ID),
    );

    expect(response.status).toBe(400);
    expect(service.respondToRequest).not.toHaveBeenCalled();
  });

  it("authenticates before reading a malformed body", async () => {
    // The converse: an unauthenticated caller must not be able to make the server spend
    // parsing work, nor learn from a `400` that its body was the problem.
    resolve.mockRejectedValue(new UnauthenticatedError("no session"));

    const response = await RESPOND_TO_REQUEST(
      new Request(`http://localhost/api/v1/events/${EVENT_ID}/requests/${REQUEST_ID}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
      requestParams(EVENT_ID, REQUEST_ID),
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("unauthenticated");
  });

  it.each([
    ["status resolved with blank notes", { status: "resolved", resolution_notes: "   " }],
    ["an unknown status", { status: "closed" }],
    ["a non-string note", { resolution_notes: 42 }],
    ["an unknown field", { admin: true }],
  ])("answers 400 for %s, from the parser", async (_label, body) => {
    const response = await call(body);

    expect(response.status).toBe(400);
    expect(service.respondToRequest).not.toHaveBeenCalled();
  });

  // The parser is deliberately lenient about *emptiness*. An empty patch, and
  // `status: "resolved"` with no note, are both well-formed bodies; what makes them
  // wrong is that they would do nothing useful, and that is a question about the stored
  // request rather than about the shape of the request. The service answers it, so the
  // route's job is to pass them through — asserted here so a future tightening of the
  // parser, or a route that started judging them itself, is visible.
  it.each([
    ["an empty patch", {}],
    ["status resolved with no notes", { status: "resolved" }],
    ["a null note", { resolution_notes: null }],
  ])("forwards %s to the service rather than judging it here", async (_label, body) => {
    service.respondToRequest.mockResolvedValue({
      ...QUEUE_ROW,
      status: "open",
      resolution_notes: "We are looking into it.",
    });

    const response = await call(body);

    expect(service.respondToRequest).toHaveBeenCalled();
    expect(response.status).toBe(200);
  });

  it("turns the service's refusal of an empty patch into a 400 naming both fields", async () => {
    service.respondToRequest.mockRejectedValue(
      new ValidationError("The request body failed validation.", {
        status: ["Supply status, resolution_notes, or both; an empty update does nothing."],
        resolution_notes: [
          "Supply status, resolution_notes, or both; an empty update does nothing.",
        ],
      }),
    );

    const response = await call({});

    expect(response.status).toBe(400);
    // Both fields named, because the fix a client can apply is to send either one.
    const body = await response.json();
    expect(Object.keys(body.error.fields).sort()).toEqual(["resolution_notes", "status"]);
  });

  it("answers 400 for an event path that is not a UUID, naming the field", async () => {
    const response = await RESPOND_TO_REQUEST(
      patchJson(`http://localhost/api/v1/events/not-a-uuid/requests/${REQUEST_ID}`, {
        status: "resolved",
        resolution_notes: "Refunded.",
      }),
      requestParams("not-a-uuid", REQUEST_ID),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.fields.identifier).toBeDefined();
    expect(service.respondToRequest).not.toHaveBeenCalled();
  });

  it("answers 400 for a request path that is not a UUID, naming the field", async () => {
    const response = await RESPOND_TO_REQUEST(
      patchJson(`http://localhost/api/v1/events/${EVENT_ID}/requests/not-a-uuid`, {
        status: "resolved",
        resolution_notes: "Refunded.",
      }),
      requestParams(EVENT_ID, "not-a-uuid"),
    );

    expect(response.status).toBe(400);
    // The field is named `request_id`, not `requestId`: the wire contract is snake_case,
    // and a client reading the route's parameter name would find nothing there.
    expect((await response.json()).error.fields.request_id).toBeDefined();
    expect(service.respondToRequest).not.toHaveBeenCalled();
  });

  it("propagates a ValidationError raised by the service as a 400", async () => {
    // The route does not re-classify: whatever the service raises reaches the client
    // through the one error renderer, so a rule can move between layers without the
    // status code changing underneath a client.
    service.respondToRequest.mockRejectedValue(
      new ValidationError("The resolution notes cannot be blank.", {
        resolution_notes: ["Required to resolve a request."],
      }),
    );

    const response = await call({ status: "resolved", resolution_notes: "x" });

    expect(response.status).toBe(400);
    expect((await response.json()).error.fields.resolution_notes).toBeDefined();
  });
});

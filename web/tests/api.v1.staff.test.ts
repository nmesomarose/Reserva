import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The staff routes, as shipped:
 *
 *   - `POST   /api/v1/events/{id}/staff-tokens`                  (PRD v2 §12, Organiser)
 *   - `GET    /api/v1/events/{id}/staff-tokens`                  (§4.6.2, Organiser)
 *   - `DELETE /api/v1/events/{id}/staff-tokens?token_id={uuid}`  (§4.6.2, Organiser)
 *   - `GET    /api/v1/events/{id}/registrations/search`          (§4.3/§4.4, Staff)
 *   - `POST   /api/v1/registrations/{id}/check-in`              (§4.4, Staff)
 *
 * These assert the *transport* contract: which credential each route requires, the
 * status codes, the error shape, the pagination envelope, and that the identity and
 * scope a request acts under come from the credential rather than from the request.
 * The business rules behind them are proven against a fake repository in
 * `staff.service.test.ts` and against real PostgreSQL in `staff.db.test.ts`, so
 * nothing here needs a database.
 *
 * The auth seams are exercised as shipped: a resolver that rejects is what a request
 * with no valid credential looks like, and the point of several tests below is that
 * such a request answers `403` *before* the route reads the path or the body.
 */

const ORGANISER_ID = "11111111-1111-1111-1111-111111111111";
const EVENT_ID = "33333333-3333-3333-3333-333333333333";
const OTHER_EVENT_ID = "44444444-4444-4444-4444-444444444444";
const STAFF_TOKEN_ID = "55555555-5555-5555-5555-555555555555";
const REGISTRATION_ID = "77777777-7777-7777-7777-777777777777";

const { getStaffService, resolve, resolveStaff } = vi.hoisted(() => ({
  getStaffService: vi.fn(),
  resolve: vi.fn(),
  resolveStaff: vi.fn(),
}));

vi.mock("@/server/db/container", () => ({ getStaffService }));
vi.mock("@/server/auth/organiser-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/organiser-context")>();

  return { ...actual, organiserContextResolver: { resolve } };
});
vi.mock("@/server/staff/staff-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/staff/staff-context")>();

  return { ...actual, staffContextResolver: { resolve: resolveStaff } };
});

import {
  DELETE as REVOKE_TOKEN,
  GET as LIST_TOKENS,
  POST as ISSUE_TOKEN,
} from "@/app/api/v1/events/[identifier]/staff-tokens/route";
import { GET as SEARCH } from "@/app/api/v1/events/[identifier]/registrations/search/route";
import { POST as CHECK_IN } from "@/app/api/v1/registrations/[id]/check-in/route";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
} from "@/domain/errors";
import { readBearerToken } from "@/server/staff/staff-context";

const service = {
  issueStaffToken: vi.fn(),
  listStaffTokens: vi.fn(),
  revokeStaffToken: vi.fn(),
  resolveStaffToken: vi.fn(),
  searchRegistrations: vi.fn(),
  checkIn: vi.fn(),
};

const eventParams = (id: string) => ({ params: Promise.resolve({ identifier: id }) });
const checkInParams = (id: string) => ({ params: Promise.resolve({ id }) });

const postJson = (body: unknown, url = "http://localhost/api/v1/events/e1/staff-tokens") =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const postJsonRaw = (body: string, url = "http://localhost/api/v1/events/e1/staff-tokens") =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

const get = (url: string) => new Request(url);

const STAFF_CONTEXT = {
  staffTokenId: STAFF_TOKEN_ID,
  eventId: EVENT_ID,
  label: "Door Team A",
};

const TOKEN_DTO = {
  id: STAFF_TOKEN_ID,
  event_id: EVENT_ID,
  label: "Door Team A",
  status: "active",
  expires_at: "2026-10-02T22:00:00.000Z",
  created_at: "2026-10-01T18:00:00.000Z",
  revoked_at: null,
};

const SEARCH_ROW = {
  registration_id: REGISTRATION_ID,
  attendee_name: "Ada Lovelace",
  attendee_email_masked: "a***e@example.com",
  attendee_phone_masked: "+23*********78",
  status: "confirmed",
  status_badge: "confirmed",
  ticket_type_name: "General Admission",
  checked_in_at: null,
  check_in_eligible: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  getStaffService.mockReturnValue(service);
  resolve.mockResolvedValue({ organiserId: ORGANISER_ID });
  resolveStaff.mockResolvedValue(STAFF_CONTEXT);
  service.issueStaffToken.mockResolvedValue({ ...TOKEN_DTO, token: "issued-plaintext" });
  service.listStaffTokens.mockResolvedValue({
    data: [TOKEN_DTO],
    page: 1,
    page_size: 20,
    total: 1,
  });
  service.revokeStaffToken.mockResolvedValue({ ...TOKEN_DTO, status: "revoked" });
  service.searchRegistrations.mockResolvedValue({
    data: [SEARCH_ROW],
    page: 1,
    page_size: 20,
    total: 1,
  });
  service.checkIn.mockResolvedValue({
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    registration_id: REGISTRATION_ID,
    checked_in_at: "2026-10-01T18:30:00.000Z",
    is_override: false,
    performed_by: { kind: "staff_token", staff_token_id: STAFF_TOKEN_ID, label: "Door Team A" },
  });
});

describe("organiser staff-token routes fail closed without a valid session", () => {
  const cases: Array<[string, () => Promise<Response>]> = [
    [
      "POST /api/v1/events/{id}/staff-tokens",
      () => ISSUE_TOKEN(postJson({ label: "Door Team A" }), eventParams("e1")),
    ],
    [
      "GET /api/v1/events/{id}/staff-tokens",
      () => LIST_TOKENS(get("http://localhost/api/v1/events/e1/staff-tokens"), eventParams("e1")),
    ],
    [
      "DELETE /api/v1/events/{id}/staff-tokens?token_id=t1",
      () =>
        REVOKE_TOKEN(
          get("http://localhost/api/v1/events/e1/staff-tokens?token_id=t1"),
          eventParams("e1"),
        ),
    ],
  ];

  it.each(cases)("%s answers 403 and reaches no business rule", async (_label, call) => {
    resolve.mockRejectedValue(new UnauthenticatedError("This request has no valid organiser session."));

    const response = await call();

    // 403, not 401: PRD §15 and rule 06 define no 401.
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("unauthenticated");
    expect(service.issueStaffToken).not.toHaveBeenCalled();
    expect(service.listStaffTokens).not.toHaveBeenCalled();
    expect(service.revokeStaffToken).not.toHaveBeenCalled();
  });

  it.each(cases)("%s authenticates before reading a malformed request", async (_label, call) => {
    // If the route parsed first this would answer 400; answering 403 proves the
    // resolver runs first, so an unauthenticated caller cannot make the server spend
    // parsing work on their request.
    resolve.mockRejectedValue(new UnauthenticatedError("no session"));

    expect((await call()).status).toBe(403);
  });

  it("POST authenticates before reading a body that is not JSON", async () => {
    resolve.mockRejectedValue(new UnauthenticatedError("no session"));

    const response = await ISSUE_TOKEN(
      postJsonRaw("{not json"),
      eventParams("e1"),
    );

    expect(response.status).toBe(403);
  });
});

describe("POST /api/v1/events/{id}/staff-tokens", () => {
  it("answers 201 with the plaintext, and never a hash", async () => {
    const response = await ISSUE_TOKEN(postJson({ label: "Door Team A" }), eventParams(EVENT_ID));

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.token).toBe("issued-plaintext");
    expect(body).toMatchObject({ event_id: EVENT_ID, label: "Door Team A", status: "active" });
    expect(Object.keys(body)).not.toContain("token_hash");
    expect(JSON.stringify(body)).not.toContain("hash");
  });

  it("takes the organiser identity from the auth seam", async () => {
    await ISSUE_TOKEN(postJson({ label: "X" }), eventParams(EVENT_ID));

    // The only source of the identity is the resolved session; a body cannot even
    // name one, since `organiser_id` is an unknown field and is refused below.
    expect(service.issueStaffToken).toHaveBeenCalledWith(ORGANISER_ID, EVENT_ID, {
      label: "X",
      expiresAt: null,
    });
  });

  it("accepts an empty body, because both fields are optional", async () => {
    const response = await ISSUE_TOKEN(postJsonRaw("{}"), eventParams(EVENT_ID));

    expect(response.status).toBe(201);
    expect(service.issueStaffToken).toHaveBeenCalledWith(ORGANISER_ID, EVENT_ID, {
      label: null,
      expiresAt: null,
    });
  });

  it("answers 400 for a non-object body", async () => {
    const response = await ISSUE_TOKEN(postJsonRaw("[1,2]"), eventParams(EVENT_ID));

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation_failed");
  });

  it("answers 400 for an unknown field rather than ignoring it", async () => {
    const response = await ISSUE_TOKEN(
      postJson({ label: "X", event_id: OTHER_EVENT_ID }),
      eventParams(EVENT_ID),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.fields.event_id).toBeDefined();
  });

  it("answers 400 for an unparseable expires_at", async () => {
    const response = await ISSUE_TOKEN(
      postJson({ expires_at: "next tuesday" }),
      eventParams(EVENT_ID),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.fields.expires_at).toBeDefined();
  });

  it("answers 403 when the event belongs to another organiser", async () => {
    service.issueStaffToken.mockRejectedValue(new ForbiddenError("not yours"));

    const response = await ISSUE_TOKEN(postJson({}), eventParams(OTHER_EVENT_ID));

    expect(response.status).toBe(403);
  });

  it("answers 404 for an unknown event", async () => {
    service.issueStaffToken.mockRejectedValue(new NotFoundError("no such event"));

    expect((await ISSUE_TOKEN(postJson({}), eventParams("nope"))).status).toBe(404);
  });
});

describe("GET /api/v1/events/{id}/staff-tokens", () => {
  it("answers 200 with the pagination envelope and no token hash", async () => {
    const response = await LIST_TOKENS(
      get("http://localhost/api/v1/events/e1/staff-tokens"),
      eventParams(EVENT_ID),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      data: [TOKEN_DTO],
      page: 1,
      page_size: 20,
      total: 1,
    });
    expect(JSON.stringify(body)).not.toContain("hash");
  });

  it("passes the requested page through", async () => {
    await LIST_TOKENS(
      get("http://localhost/api/v1/events/e1/staff-tokens?page=3&page_size=5"),
      eventParams(EVENT_ID),
    );

    expect(service.listStaffTokens).toHaveBeenCalledWith(ORGANISER_ID, EVENT_ID, {
      page: 3,
      pageSize: 5,
    });
  });

  it("answers 400 for a zero page or a non-numeric page", async () => {
    for (const query of ["page=0", "page=abc", "page_size=0", "page_size=-1", "page_size=51"]) {
      const response = await LIST_TOKENS(
        get(`http://localhost/api/v1/events/e1/staff-tokens?${query}`),
        eventParams(EVENT_ID),
      );

      expect(response.status, query).toBe(400);
    }

    expect(service.listStaffTokens).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/v1/events/{id}/staff-tokens", () => {
  const tokenId = "55555555-5555-5555-5555-555555555555";

  it("revokes through the query parameter, and answers 200 with the new state", async () => {
    const response = await REVOKE_TOKEN(
      get(`http://localhost/api/v1/events/e1/staff-tokens?token_id=${tokenId}`),
      eventParams(EVENT_ID),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("revoked");
    expect(service.revokeStaffToken).toHaveBeenCalledWith(ORGANISER_ID, EVENT_ID, tokenId);
  });

  it("answers 400 without token_id", async () => {
    const response = await REVOKE_TOKEN(
      get("http://localhost/api/v1/events/e1/staff-tokens"),
      eventParams(EVENT_ID),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.fields.token_id).toBeDefined();
    expect(service.revokeStaffToken).not.toHaveBeenCalled();
  });

  it("answers 400 for a token_id that is not a UUID", async () => {
    const response = await REVOKE_TOKEN(
      get("http://localhost/api/v1/events/e1/staff-tokens?token_id=abc"),
      eventParams(EVENT_ID),
    );

    expect(response.status).toBe(400);
    expect(service.revokeStaffToken).not.toHaveBeenCalled();
  });

  it("answers 404 for a token that is not this event's", async () => {
    service.revokeStaffToken.mockRejectedValue(new NotFoundError("no such staff token"));

    const response = await REVOKE_TOKEN(
      get(`http://localhost/api/v1/events/e1/staff-tokens?token_id=${tokenId}`),
      eventParams(EVENT_ID),
    );

    expect(response.status).toBe(404);
  });
});

describe("staff routes fail closed without a valid staff credential", () => {
  const cases: Array<[string, () => Promise<Response>]> = [
    [
      "GET /api/v1/events/{id}/registrations/search",
      () => SEARCH(get("http://localhost/api/v1/events/e1/registrations/search?query=ada"), eventParams("e1")),
    ],
    [
      "POST /api/v1/registrations/{id}/check-in",
      () => CHECK_IN(new Request("http://localhost/api/v1/registrations/r1/check-in", { method: "POST" }), checkInParams("r1")),
    ],
  ];

  it.each(cases)("%s answers 403 and reaches no business rule", async (_label, call) => {
    resolveStaff.mockRejectedValue(new UnauthenticatedError("This request has no valid staff access token."));

    const response = await call();

    // 403, not 401, and never a 404: the caller has not proven anything yet.
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("unauthenticated");
    expect(service.searchRegistrations).not.toHaveBeenCalled();
    expect(service.checkIn).not.toHaveBeenCalled();
  });

  it.each(cases)("%s authenticates before reading the path", async (_label, call) => {
    // The search route's `query` is missing and the check-in's `{id}` is not a UUID in
    // both of these calls; a 403 rather than a 400 proves the credential is checked
    // before the request is parsed, so an unauthenticated caller learns nothing about
    // what a valid request would look like.
    resolveStaff.mockRejectedValue(new UnauthenticatedError("no token"));

    expect((await call()).status).toBe(403);
  });
});

describe("readBearerToken", () => {
  it("reads the credential from an Authorization header", () => {
    const request = new Request("http://localhost/x", {
      headers: { authorization: "Bearer abc123" },
    });

    expect(readBearerToken(request)).toBe("abc123");
  });

  it("accepts the scheme in any case, as RFC 7235 requires", () => {
    for (const scheme of ["Bearer", "bearer", "BEARER", "BeArEr"]) {
      const request = new Request("http://localhost/x", {
        headers: { authorization: `${scheme} abc123` },
      });

      expect(readBearerToken(request), scheme).toBe("abc123");
    }
  });

  it("tolerates surrounding whitespace", () => {
    const request = new Request("http://localhost/x", {
      headers: { authorization: "Bearer   abc123  " },
    });

    expect(readBearerToken(request)).toBe("abc123");
  });

  it("refuses anything that is not a single well-formed bearer value", () => {
    const bad = [
      "",
      "abc123",
      "Bearer",
      "Bearer ",
      "Basic abc123",
      "Token abc123",
      "Bearer abc 123",
      "abc123, Bearer def456",
    ];

    for (const header of bad) {
      const request = new Request("http://localhost/x", { headers: { authorization: header } });

      // `null`, not an error: every one of these is the same failure to the caller,
      // and none of them is a client mistake worth a 400.
      expect(readBearerToken(request), JSON.stringify(header)).toBeNull();
    }

    expect(readBearerToken(new Request("http://localhost/x"))).toBeNull();
  });
});

describe("GET /api/v1/events/{id}/registrations/search", () => {
  const search = (query: string) =>
    SEARCH(get(`http://localhost/api/v1/events/e1/registrations/search${query}`), eventParams(EVENT_ID));

  it("answers 200 with the envelope, and passes the trimmed query through", async () => {
    const response = await search("?query=%20ada%20");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [SEARCH_ROW],
      page: 1,
      page_size: 20,
      total: 1,
    });
    expect(service.searchRegistrations).toHaveBeenCalledWith(
      STAFF_CONTEXT,
      EVENT_ID,
      "ada",
      { page: 1, pageSize: 20 },
    );
  });

  it("answers 200 with an empty result set, not a 404", async () => {
    service.searchRegistrations.mockResolvedValue({ data: [], page: 1, page_size: 20, total: 0 });

    const response = await search("?query=zzz");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [], page: 1, page_size: 20, total: 0 });
  });

  it("never forwards a token_hash, because no such field exists on a search row", async () => {
    const response = await search("?query=ada");

    expect(JSON.stringify(await response.json())).not.toContain("hash");
  });

  it("answers 400 without a query", async () => {
    const response = await search("");

    expect(response.status).toBe(400);
    expect((await response.json()).error.fields.query).toBeDefined();
    expect(service.searchRegistrations).not.toHaveBeenCalled();
  });

  it("answers 400 for a one-character query", async () => {
    expect((await search("?query=a")).status).toBe(400);
    expect(service.searchRegistrations).not.toHaveBeenCalled();
  });

  it("caps the page at 20 results, per PRD §11, and rejects rather than clamps", async () => {
    // The platform-wide cap is 50; a search has its own lower one. A 20 is fine, 21 is
    // a 400 — silently returning 20 rows for `page_size=21` would hide a client bug.
    const accepted = await search("?query=ada&page_size=20");
    expect(accepted.status).toBe(200);
    expect(service.searchRegistrations).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), "ada", {
      page: 1,
      pageSize: 20,
    });

    const rejected = await search("?query=ada&page_size=21");
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error.fields.page_size).toBeDefined();
  });

  it("answers 403 when the path event is not the token's event", async () => {
    service.searchRegistrations.mockRejectedValue(new ForbiddenError("wrong event"));

    const response = await SEARCH(
      get("http://localhost/api/v1/events/other/registrations/search?query=ada"),
      eventParams(OTHER_EVENT_ID),
    );

    expect(response.status).toBe(403);
  });

  it("answers 400 for a query longer than the cap", async () => {
    expect((await search(`?query=${"a".repeat(201)}`)).status).toBe(400);
    expect((await search(`?query=${"a".repeat(200)}`)).status).toBe(200);
  });
});

describe("POST /api/v1/registrations/{id}/check-in", () => {
  const checkIn = (id: string, body?: unknown) =>
    CHECK_IN(
      body === undefined
        ? new Request(`http://localhost/api/v1/registrations/${id}/check-in`, { method: "POST" })
        : new Request(`http://localhost/api/v1/registrations/${id}/check-in`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
      checkInParams(id),
    );

  it("answers 201 for a first check-in, with the acting token as performer", async () => {
    const response = await checkIn(REGISTRATION_ID);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      registration_id: REGISTRATION_ID,
      checked_in_at: "2026-10-01T18:30:00.000Z",
      is_override: false,
      performed_by: { kind: "staff_token", staff_token_id: STAFF_TOKEN_ID, label: "Door Team A" },
    });
    // A body is optional: a first check-in carries no fields.
    expect(service.checkIn).toHaveBeenCalledWith(STAFF_CONTEXT, REGISTRATION_ID, { override: false });
  });

  it("passes an explicit override through as a boolean, not a truthy string", async () => {
    const response = await checkIn(REGISTRATION_ID, { override: true });

    expect(response.status).toBe(201);
    expect(service.checkIn).toHaveBeenCalledWith(STAFF_CONTEXT, REGISTRATION_ID, { override: true });
  });

  it("answers 400 for a non-boolean override rather than coercing it", async () => {
    // "true" as a string becoming `true` is exactly how a client bug turns a re-click
    // into an auditable override nobody intended (BR-4).
    const response = await checkIn(REGISTRATION_ID, { override: "true" });

    expect(response.status).toBe(400);
    expect((await response.json()).error.fields.override).toBeDefined();
    expect(service.checkIn).not.toHaveBeenCalled();
  });

  it("answers 400 for an unknown field", async () => {
    const response = await checkIn(REGISTRATION_ID, { is_override: true });

    expect(response.status).toBe(400);
    expect(service.checkIn).not.toHaveBeenCalled();
  });

  it("answers 400 for a body that is present but not an object", async () => {
    const response = await checkIn(REGISTRATION_ID, "override=true");

    expect(response.status).toBe(400);
    expect(service.checkIn).not.toHaveBeenCalled();
  });

  it("answers 400 for a registration id that is not a UUID", async () => {
    // The guarded write casts the id to `uuid`; unvalidated, a typo would come back as
    // a 500 from the cast rather than the 400 it is.
    const response = await checkIn("not-a-uuid");

    expect(response.status).toBe(400);
    expect((await response.json()).error.fields.id).toBeDefined();
    expect(service.checkIn).not.toHaveBeenCalled();
  });

  it("lower-cases the id, so two spellings are one id", async () => {
    await checkIn(REGISTRATION_ID.toUpperCase());

    expect(service.checkIn).toHaveBeenCalledWith(STAFF_CONTEXT, REGISTRATION_ID, { override: false });
  });

  it("answers 404 for a registration outside the token's event", async () => {
    service.checkIn.mockRejectedValue(new NotFoundError("No such registration exists in this event."));

    const response = await checkIn(REGISTRATION_ID);

    expect(response.status).toBe(404);
  });

  it("answers 409 for an already-checked-in registration", async () => {
    service.checkIn.mockRejectedValue(
      new ConflictError(
        "This registration was already checked in at 2026-10-01T18:05:00.000Z. Re-checking it in requires an explicit override.",
      ),
    );

    const response = await checkIn(REGISTRATION_ID);

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("conflict");
  });

  it("answers 409 for an ineligible registration, with a different message", async () => {
    service.checkIn.mockRejectedValue(
      new ConflictError(
        "This registration is still awaiting payment and cannot be checked in. Only a confirmed ticket is valid for entry.",
      ),
    );

    const response = await checkIn(REGISTRATION_ID);

    expect(response.status).toBe(409);
    const { error } = await response.json();
    expect(error.message).toContain("awaiting payment");
    expect(error.message).not.toContain("already checked in");
  });
});

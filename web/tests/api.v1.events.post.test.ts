import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `POST /api/v1/events` (PRD v2 §12, auth: Organiser).
 *
 * Two states of the authentication seam are covered:
 *   - a resolver that rejects, which is what a request without a valid session
 *     looks like now that the mechanism is implemented;
 *   - a resolver that returns an identity, standing in for a live session.
 *
 * The second case is what proves the authorisation *model* is already correct:
 * the organiser identity comes from the server-side context and the body cannot
 * influence it.
 */

const ORGANISER_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ORGANISER_ID = "99999999-9999-9999-9999-999999999999";

const { getEventService, resolve } = vi.hoisted(() => ({
  getEventService: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock("@/server/db/container", () => ({ getEventService }));
vi.mock("@/server/auth/organiser-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/organiser-context")>();

  return {
    ...actual,
    organiserContextResolver: { resolve },
  };
});

import { POST } from "@/app/api/v1/events/route";
import { UnauthenticatedError } from "@/domain/errors";

const VALID_BODY = {
  name: "Jazz Night",
  description: "Two sets of improvised jazz.",
  starts_at: "2026-10-01T18:00:00Z",
  ends_at: "2026-10-01T22:00:00Z",
  venue: "The Blue Room",
};

const CREATED_EVENT = {
  id: "event-1",
  name: "Jazz Night",
  slug: "jazz-night",
  description: "Two sets of improvised jazz.",
  starts_at: "2026-10-01T18:00:00.000Z",
  ends_at: "2026-10-01T22:00:00.000Z",
  venue: "The Blue Room",
  status: "draft",
  created_at: "2026-09-26T12:00:00.000Z",
  updated_at: "2026-09-26T12:00:00.000Z",
};

const createEvent = vi.fn();

function postWithBody(body: unknown): Request {
  return new Request("http://localhost/api/v1/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getEventService.mockReturnValue({ createEvent });
  createEvent.mockResolvedValue(CREATED_EVENT);
});

describe("POST /api/v1/events without a valid organiser session", () => {
  it("fails closed with 403 and creates nothing", async () => {
    resolve.mockRejectedValue(new UnauthenticatedError("This request has no valid organiser session."));

    const response = await POST(postWithBody(VALID_BODY));

    // 403, not 401: PRD §15 and rule 06 define no 401, and the auth decision was
    // to apply the documented convention. See `UnauthenticatedError`.
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("unauthenticated");
    expect(createEvent).not.toHaveBeenCalled();
  });

  it("does not read or validate the body before authenticating", async () => {
    // Authenticating first means an unauthorised caller cannot make the server
    // parse on their behalf — not even enough to be told the body was invalid.
    resolve.mockRejectedValue(new UnauthenticatedError("no session"));

    const response = await POST(postWithBody("{ not json"));

    expect(response.status).toBe(403);
    expect(createEvent).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/events with a live organiser session", () => {
  beforeEach(() => {
    resolve.mockResolvedValue({ organiserId: ORGANISER_ID });
  });

  it("returns 201 with the created event", async () => {
    const response = await POST(postWithBody(VALID_BODY));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(CREATED_EVENT);
  });

  it("passes the parsed command and the server-derived organiser id to the domain", async () => {
    await POST(postWithBody(VALID_BODY));

    expect(createEvent).toHaveBeenCalledWith(ORGANISER_ID, {
      name: "Jazz Night",
      description: "Two sets of improvised jazz.",
      startsAt: new Date("2026-10-01T18:00:00Z"),
      endsAt: new Date("2026-10-01T22:00:00Z"),
      venue: "The Blue Room",
    });
  });

  it("ignores a body-supplied organiser_id instead of honouring it", async () => {
    const response = await POST(
      postWithBody({ ...VALID_BODY, organiser_id: OTHER_ORGANISER_ID }),
    );

    // Rejected outright, not silently stripped: an unknown field is a contract
    // violation, and silently ignoring it would hide a probing client.
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.fields.organiser_id).toBeDefined();
    expect(createEvent).not.toHaveBeenCalled();
  });

  it("ignores a body-supplied status", async () => {
    const response = await POST(postWithBody({ ...VALID_BODY, status: "published" }));

    expect(response.status).toBe(400);
    expect((await response.json()).error.fields.status).toBeDefined();
    expect(createEvent).not.toHaveBeenCalled();
  });

  it("returns 400 with field detail for invalid fields", async () => {
    const response = await POST(
      postWithBody({ ...VALID_BODY, name: "", ends_at: "2026-09-01T18:00:00Z" }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.fields.name).toBeDefined();
    expect(body.error.fields.ends_at).toContain("Must be after starts_at.");
    expect(createEvent).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed JSON body", async () => {
    const response = await POST(postWithBody("{ not json"));

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation_failed");
    expect(createEvent).not.toHaveBeenCalled();
  });
});

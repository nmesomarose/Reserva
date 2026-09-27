import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConflictError, NotFoundError, ValidationError } from "@/domain/errors";
import { toErrorResponse } from "@/server/http/error-response";

/**
 * The container is mocked so the route can be exercised without a database; the
 * stub below stands in for `EventService`.
 */
const { getEventService } = vi.hoisted(() => ({ getEventService: vi.fn() }));

vi.mock("@/server/db/container", () => ({ getEventService }));

import { GET } from "@/app/api/v1/events/[identifier]/route";

const PUBLIC_EVENT = {
  name: "Jazz Night",
  slug: "jazz-night",
  description: "Two sets of improvised jazz.",
  starts_at: "2026-10-01T18:00:00.000Z",
  ends_at: "2026-10-01T22:00:00.000Z",
  venue: "The Blue Room",
  programme: [],
  ticket_types: [{ name: "General", price_minor_units: 1_500, currency: "GBP", available: true }],
};

const getPublicEvent = vi.fn();
const request = new Request("http://localhost/api/v1/events/jazz-night");
const context = { params: Promise.resolve({ identifier: "jazz-night" }) };

beforeEach(() => {
  vi.clearAllMocks();
  getEventService.mockReturnValue({ getPublicEvent });
});

describe("GET /api/v1/events/{slug}", () => {
  it("returns 200 with the public projection", async () => {
    getPublicEvent.mockResolvedValue(PUBLIC_EVENT);

    const response = await GET(request, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(PUBLIC_EVENT);
  });

  it("awaits the slug from the route params", async () => {
    getPublicEvent.mockResolvedValue(PUBLIC_EVENT);

    await GET(request, { params: Promise.resolve({ identifier: "autumn-festival" }) });

    expect(getPublicEvent).toHaveBeenCalledWith("autumn-festival");
  });

  it("returns 404 in the shared error shape when the event is not public", async () => {
    getPublicEvent.mockRejectedValue(new NotFoundError("No published event exists for this slug."));

    const response = await GET(request, context);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "No published event exists for this slug." },
    });
  });

  it("returns 409 for a conflict", async () => {
    getPublicEvent.mockRejectedValue(new ConflictError("An event already uses this slug."));

    const response = await GET(request, context);

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("conflict");
  });

  it("hides an unexpected failure behind a generic 500", async () => {
    getPublicEvent.mockRejectedValue(
      new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2"),
    );

    const response = await GET(request, context);
    const body = await response.text();

    expect(response.status).toBe(500);
    // Neither the driver message nor a credential reaches the client (AGENTS.md §14).
    expect(body).not.toContain("ECONNREFUSED");
    expect(body).not.toContain("hunter2");
    expect(body).not.toContain("10.0.0.5");
    expect(JSON.parse(body).error.message).toBe("An unexpected error occurred.");
  });
});

describe("toErrorResponse", () => {
  it("renders field-level detail for a validation failure", async () => {
    const response = toErrorResponse(
      new ValidationError("The request body failed validation.", {
        name: ["Required, and cannot be blank."],
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "validation_failed",
        message: "The request body failed validation.",
        fields: { name: ["Required, and cannot be blank."] },
      },
    });
  });

  it("omits `fields` for non-validation errors", async () => {
    const response = toErrorResponse(new NotFoundError("gone"));

    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "gone" },
    });
  });
});

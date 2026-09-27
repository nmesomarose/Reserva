import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The organiser-scoped event routes added on 2026-09-26:
 *
 *   - `GET    /api/v1/events`                        (list, rule 06 envelope)
 *   - `PATCH  /api/v1/events/{id}`                   (update + status transition)
 *   - `DELETE /api/v1/events/{id}`                   (soft delete)
 *   - `POST   /api/v1/events/{id}/programme`         (add a programme line)
 *   - `PATCH  /api/v1/events/{id}/programme/{item}`  (merge a line)
 *   - `DELETE /api/v1/events/{id}/programme/{item}`  (remove a line)
 *
 * These tests assert the *transport* contract: status codes, the error shape, the
 * pagination envelope, and that the organiser identity is taken from the auth
 * seam rather than the body. The business rules behind them are proven separately
 * against a fake repository in `events.service.test.ts`, so nothing here needs a
 * database.
 *
 * The auth seam is exercised in its shipped state: a resolver that rejects is
 * what a request with no valid session looks like, and every organiser route must
 * answer `403 unauthenticated` without reaching a business rule.
 */

const ORGANISER_ID = "11111111-1111-1111-1111-111111111111";

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

import { GET as LIST_EVENTS } from "@/app/api/v1/events/route";
import { DELETE, PATCH } from "@/app/api/v1/events/[identifier]/route";
import { POST as CREATE_ITEM } from "@/app/api/v1/events/[identifier]/programme/route";
import {
  DELETE as DELETE_ITEM,
  PATCH as PATCH_ITEM,
} from "@/app/api/v1/events/[identifier]/programme/[itemId]/route";
import {
  ForbiddenError,
  IllegalTransitionError,
  NotFoundError,
  UnauthenticatedError,
} from "@/domain/errors";

const service = {
  listEvents: vi.fn(),
  updateEvent: vi.fn(),
  softDeleteEvent: vi.fn(),
  addProgrammeItem: vi.fn(),
  patchProgrammeItem: vi.fn(),
  removeProgrammeItem: vi.fn(),
};

const eventParams = (id: string) => ({ params: Promise.resolve({ identifier: id }) });
const itemParams = (id: string, itemId: string) => ({
  params: Promise.resolve({ identifier: id, itemId }),
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

const EVENT = {
  id: "event-1",
  name: "Jazz Night",
  slug: "jazz-night",
  description: "Two sets of improvised jazz.",
  starts_at: "2026-10-01T18:00:00.000Z",
  ends_at: "2026-10-01T22:00:00.000Z",
  venue: "Riverside Hall",
  status: "published",
  created_at: "2026-09-26T12:00:00.000Z",
  updated_at: "2026-09-26T13:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  getEventService.mockReturnValue(service);
  resolve.mockResolvedValue({ organiserId: ORGANISER_ID });
});

describe("organiser routes fail closed without a valid session", () => {
  const cases: Array<[string, () => Promise<Response>]> = [
    ["GET /api/v1/events", () => LIST_EVENTS(new Request("http://localhost/api/v1/events"))],
    ["PATCH /api/v1/events/{id}", () => PATCH(patchJson("http://localhost/api/v1/events/e1", { name: "X" }), eventParams("e1"))],
    ["DELETE /api/v1/events/{id}", () => DELETE(new Request("http://localhost/api/v1/events/e1"), eventParams("e1"))],
    ["POST /api/v1/events/{id}/programme", () => CREATE_ITEM(postJson("http://localhost/api/v1/events/e1/programme", { sort_order: 1, title: "Doors" }), eventParams("e1"))],
    ["PATCH /api/v1/events/{id}/programme/{item}", () => PATCH_ITEM(patchJson("http://localhost/api/v1/events/e1/programme/p1", { title: "X" }), itemParams("e1", "p1"))],
    ["DELETE /api/v1/events/{id}/programme/{item}", () => DELETE_ITEM(new Request("http://localhost/api/v1/events/e1/programme/p1"), itemParams("e1", "p1"))],
  ];

  it.each(cases)("%s answers 403 and reaches no business rule", async (_label, call) => {
    resolve.mockRejectedValue(new UnauthenticatedError("This request has no valid organiser session."));

    const response = await call();

    // 403, not 401: PRD §15 and rule 06 define no 401, and the auth decision was
    // to apply the documented convention. See `UnauthenticatedError`.
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("unauthenticated");
    expect(service.updateEvent).not.toHaveBeenCalled();
    expect(service.listEvents).not.toHaveBeenCalled();
  });

  it.each(cases)("%s reaches no business rule at all", async (_label, call) => {
    resolve.mockRejectedValue(new UnauthenticatedError("This request has no valid organiser session."));

    const response = await call();

    expect(response.status).toBe(403);
    expect(service.listEvents).not.toHaveBeenCalled();
    expect(service.updateEvent).not.toHaveBeenCalled();
    expect(service.softDeleteEvent).not.toHaveBeenCalled();
    expect(service.addProgrammeItem).not.toHaveBeenCalled();
    expect(service.patchProgrammeItem).not.toHaveBeenCalled();
    expect(service.removeProgrammeItem).not.toHaveBeenCalled();
  });

  // A body that is not even valid JSON. If the route parsed before
  // authenticating, this would answer 400 `validation_failed`; answering 403
  // proves the resolver runs first, so an unauthenticated caller cannot make the
  // server spend parsing work on their request.
  const malformed: Array<[string, () => Promise<Response>]> = [
    [
      "PATCH /api/v1/events/{id}",
      () =>
        PATCH(
          new Request("http://localhost/api/v1/events/e1", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: "{not json",
          }),
          eventParams("e1"),
        ),
    ],
    [
      "POST /api/v1/events/{id}/programme",
      () =>
        CREATE_ITEM(
          new Request("http://localhost/api/v1/events/e1/programme", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{not json",
          }),
          eventParams("e1"),
        ),
    ],
  ];

  it.each(malformed)("%s authenticates before reading a malformed body", async (_l, call) => {
    resolve.mockRejectedValue(new UnauthenticatedError("no session"));

    const response = await call();

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("unauthenticated");
  });
});

describe("GET /api/v1/events", () => {
  it("returns the rule 06 pagination envelope", async () => {
    service.listEvents.mockResolvedValue({
      data: [EVENT],
      page: 1,
      page_size: 20,
      total: 1,
    });

    const response = await LIST_EVENTS(new Request("http://localhost/api/v1/events"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [EVENT], page: 1, page_size: 20, total: 1 });
  });

  it("passes the caller's own id, never a client-supplied owner", async () => {
    service.listEvents.mockResolvedValue({ data: [], page: 1, page_size: 20, total: 0 });

    await LIST_EVENTS(new Request("http://localhost/api/v1/events?organiser_id=someone-else"));

    expect(service.listEvents).toHaveBeenCalledWith(
      ORGANISER_ID,
      expect.objectContaining({ page: 1, pageSize: 20 }),
    );
  });

  it("returns 200 with an empty data array, never 404", async () => {
    service.listEvents.mockResolvedValue({ data: [], page: 1, page_size: 20, total: 0 });

    const response = await LIST_EVENTS(new Request("http://localhost/api/v1/events"));

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual([]);
  });

  it("rejects a page_size above the hard cap rather than clamping it", async () => {
    const response = await LIST_EVENTS(new Request("http://localhost/api/v1/events?page_size=51"));

    expect(response.status).toBe(400);
    expect((await response.json()).error.fields.page_size).toBeDefined();
    expect(service.listEvents).not.toHaveBeenCalled();
  });

  it("rejects a non-positive or non-numeric page instead of defaulting it", async () => {
    for (const query of ["page=0", "page=abc", "page_size=-1", "page_size="]) {
      const response = await LIST_EVENTS(new Request(`http://localhost/api/v1/events?${query}`));
      expect(response.status).toBe(400);
    }
  });

  it("forwards an explicit status filter", async () => {
    service.listEvents.mockResolvedValue({ data: [], page: 1, page_size: 20, total: 0 });

    await LIST_EVENTS(new Request("http://localhost/api/v1/events?status=published&page=2&page_size=5"));

    expect(service.listEvents).toHaveBeenCalledWith(
      ORGANISER_ID,
      expect.objectContaining({ page: 2, pageSize: 5, status: "published" }),
    );
  });

  it("rejects an unknown status filter", async () => {
    const response = await LIST_EVENTS(new Request("http://localhost/api/v1/events?status=live"));

    expect(response.status).toBe(400);
  });
});

describe("PATCH /api/v1/events/{id}", () => {
  it("delegates to the service with the resolved organiser and the id from the path", async () => {
    service.updateEvent.mockResolvedValue(EVENT);

    const response = await PATCH(
      patchJson("http://localhost/api/v1/events/event-1", { venue: "Riverside Hall" }),
      eventParams("event-1"),
    );

    expect(response.status).toBe(200);
    expect(service.updateEvent).toHaveBeenCalledWith(ORGANISER_ID, "event-1", {
      venue: "Riverside Hall",
    });
  });

  it("forwards a status transition so the service can judge legality", async () => {
    service.updateEvent.mockResolvedValue(EVENT);

    await PATCH(
      patchJson("http://localhost/api/v1/events/event-1", { status: "published" }),
      eventParams("event-1"),
    );

    expect(service.updateEvent).toHaveBeenCalledWith(ORGANISER_ID, "event-1", {
      status: "published",
    });
  });

  it("maps an illegal transition to 409", async () => {
    service.updateEvent.mockRejectedValue(
      new IllegalTransitionError("An event cannot move from closed to published."),
    );

    const response = await PATCH(
      patchJson("http://localhost/api/v1/events/event-1", { status: "published" }),
      eventParams("event-1"),
    );

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("conflict");
  });

  it("maps a cross-owner attempt to 403, distinct from 404", async () => {
    service.updateEvent.mockRejectedValue(
      new ForbiddenError("This event belongs to another organiser."),
    );

    const response = await PATCH(
      patchJson("http://localhost/api/v1/events/event-1", { name: "Mine" }),
      eventParams("event-1"),
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("forbidden");
  });

  it("maps an unknown id to 404", async () => {
    service.updateEvent.mockRejectedValue(new NotFoundError("No event exists with that id."));

    const response = await PATCH(
      patchJson("http://localhost/api/v1/events/nope", { name: "X" }),
      eventParams("nope"),
    );

    expect(response.status).toBe(404);
  });

  it("rejects a body that tries to set organiser_id or slug", async () => {
    const response = await PATCH(
      patchJson("http://localhost/api/v1/events/event-1", {
        organiser_id: "attacker",
        slug: "chosen-by-me",
      }),
      eventParams("event-1"),
    );

    expect(response.status).toBe(400);
    expect(service.updateEvent).not.toHaveBeenCalled();
  });

  it("rejects an empty PATCH", async () => {
    const response = await PATCH(
      patchJson("http://localhost/api/v1/events/event-1", {}),
      eventParams("event-1"),
    );

    expect(response.status).toBe(400);
    expect(service.updateEvent).not.toHaveBeenCalled();
  });

  it("rejects a status outside the enum", async () => {
    const response = await PATCH(
      patchJson("http://localhost/api/v1/events/event-1", { status: "live" }),
      eventParams("event-1"),
    );

    expect(response.status).toBe(400);
  });

  it("rejects a timestamp without an offset", async () => {
    const response = await PATCH(
      patchJson("http://localhost/api/v1/events/event-1", { starts_at: "2026-10-01T18:00:00" }),
      eventParams("event-1"),
    );

    expect(response.status).toBe(400);
  });
});

describe("DELETE /api/v1/events/{id}", () => {
  it("answers 204 with no body", async () => {
    service.softDeleteEvent.mockResolvedValue(EVENT);

    const response = await DELETE(
      new Request("http://localhost/api/v1/events/event-1"),
      eventParams("event-1"),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(service.softDeleteEvent).toHaveBeenCalledWith(ORGANISER_ID, "event-1");
  });

  it("maps a cross-owner attempt to 403", async () => {
    service.softDeleteEvent.mockRejectedValue(
      new ForbiddenError("This event belongs to another organiser."),
    );

    const response = await DELETE(
      new Request("http://localhost/api/v1/events/event-1"),
      eventParams("event-1"),
    );

    expect(response.status).toBe(403);
  });
});

describe("programme routes", () => {
  const ITEM = {
    id: "p1",
    sort_order: 1,
    time: "2026-10-01T18:00:00.000Z",
    title: "Doors",
    description: null,
  };

  it("POST returns 201 with the addressable item", async () => {
    service.addProgrammeItem.mockResolvedValue(ITEM);

    const response = await CREATE_ITEM(
      postJson("http://localhost/api/v1/events/event-1/programme", {
        sort_order: 1,
        time: "2026-10-01T18:00:00Z",
        title: "Doors",
      }),
      eventParams("event-1"),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(ITEM);
    expect(service.addProgrammeItem).toHaveBeenCalledWith(ORGANISER_ID, "event-1", {
      sortOrder: 1,
      time: new Date("2026-10-01T18:00:00Z"),
      title: "Doors",
      description: null,
    });
  });

  it("POST requires an integer sort_order, because FR-2 stores the order", async () => {
    const response = await CREATE_ITEM(
      postJson("http://localhost/api/v1/events/event-1/programme", {
        sort_order: "first",
        title: "Doors",
      }),
      eventParams("event-1"),
    );

    expect(response.status).toBe(400);
    expect(service.addProgrammeItem).not.toHaveBeenCalled();
  });

  it("POST rejects an unknown field", async () => {
    const response = await CREATE_ITEM(
      postJson("http://localhost/api/v1/events/event-1/programme", {
        sort_order: 1,
        title: "Doors",
        event_id: "somebody-elses-event",
      }),
      eventParams("event-1"),
    );

    expect(response.status).toBe(400);
  });

  it("PATCH merges, so an explicit null clears while an absent key is left alone", async () => {
    service.patchProgrammeItem.mockResolvedValue({ ...ITEM, description: null });

    await PATCH_ITEM(
      patchJson("http://localhost/api/v1/events/event-1/programme/p1", {
        description: null,
      }),
      itemParams("event-1", "p1"),
    );

    expect(service.patchProgrammeItem).toHaveBeenCalledWith(ORGANISER_ID, "event-1", "p1", {
      description: null,
    });
  });

  it("PATCH 404s an item that is not on this event", async () => {
    service.patchProgrammeItem.mockRejectedValue(
      new NotFoundError("No such programme item exists on this event."),
    );

    const response = await PATCH_ITEM(
      patchJson("http://localhost/api/v1/events/event-1/programme/p9", { title: "X" }),
      itemParams("event-1", "p9"),
    );

    expect(response.status).toBe(404);
  });

  it("DELETE answers 204 and passes both ids through", async () => {
    service.removeProgrammeItem.mockResolvedValue(undefined);

    const response = await DELETE_ITEM(
      new Request("http://localhost/api/v1/events/event-1/programme/p1"),
      itemParams("event-1", "p1"),
    );

    expect(response.status).toBe(204);
    expect(service.removeProgrammeItem).toHaveBeenCalledWith(ORGANISER_ID, "event-1", "p1");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The organiser ticket-tier routes:
 *
 *   - `POST   /api/v1/events/{id}/ticket-types`             (PRD v2 §12)
 *   - `GET    /api/v1/events/{id}/ticket-types`             (R-4, 2026-09-26)
 *   - `PATCH  /api/v1/events/{id}/ticket-types/{tier}`      (R-4, 2026-09-26)
 *   - `DELETE /api/v1/events/{id}/ticket-types/{tier}`      (R-4, 2026-09-26)
 *
 * These assert the *transport* contract: status codes, the error shape, the
 * pagination envelope, and that the organiser identity comes from the auth seam
 * rather than the body. The rules behind them are proven against a fake repository in
 * `ticket-types.service.test.ts` and against real PostgreSQL in
 * `ticket-types.db.test.ts`, so nothing here needs a database.
 *
 * The auth seam is exercised as shipped: a resolver that rejects is what a request
 * with no valid session looks like, and every route must answer
 * `403 unauthenticated` without reaching a business rule.
 */

const ORGANISER_ID = "11111111-1111-1111-1111-111111111111";

const { getTicketTypeService, resolve } = vi.hoisted(() => ({
  getTicketTypeService: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock("@/server/db/container", () => ({ getTicketTypeService }));
vi.mock("@/server/auth/organiser-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/organiser-context")>();

  return {
    ...actual,
    organiserContextResolver: { resolve },
  };
});

import { GET as LIST_TIERS, POST as CREATE_TIER } from "@/app/api/v1/events/[identifier]/ticket-types/route";
import {
  DELETE as DELETE_TIER,
  PATCH as PATCH_TIER,
} from "@/app/api/v1/events/[identifier]/ticket-types/[ticketTypeId]/route";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from "@/domain/errors";

const service = {
  createTicketType: vi.fn(),
  listTicketTypes: vi.fn(),
  updateTicketType: vi.fn(),
  deleteTicketType: vi.fn(),
};

const eventParams = (id: string) => ({ params: Promise.resolve({ identifier: id }) });
const tierParams = (id: string, tierId: string) => ({
  params: Promise.resolve({ identifier: id, ticketTypeId: tierId }),
});

const postJson = (body: unknown) =>
  new Request("http://localhost/api/v1/events/e1/ticket-types", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const patchJson = (body: unknown) =>
  new Request("http://localhost/api/v1/events/e1/ticket-types/t1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const TIER = {
  id: "t1",
  name: "General Admission",
  description: null,
  price_minor_units: 5_000,
  currency: "NGN",
  quantity_total: 100,
  quantity_confirmed: 0,
  quantity_held: 0,
  available: 100,
  created_at: "2026-09-26T12:00:00.000Z",
  updated_at: "2026-09-26T12:00:00.000Z",
};

const VALID_BODY = {
  name: "General Admission",
  price_minor_units: 5_000,
  currency: "NGN",
  quantity_total: 100,
};

beforeEach(() => {
  vi.clearAllMocks();
  getTicketTypeService.mockReturnValue(service);
  resolve.mockResolvedValue({ organiserId: ORGANISER_ID });
  service.createTicketType.mockResolvedValue(TIER);
  service.listTicketTypes.mockResolvedValue({ data: [TIER], page: 1, page_size: 20, total: 1 });
  service.updateTicketType.mockResolvedValue(TIER);
  service.deleteTicketType.mockResolvedValue(undefined);
});

describe("ticket-type routes fail closed without a valid session", () => {
  const cases: Array<[string, () => Promise<Response>]> = [
    [
      "POST /api/v1/events/{id}/ticket-types",
      () => CREATE_TIER(postJson(VALID_BODY), eventParams("e1")),
    ],
    [
      "GET /api/v1/events/{id}/ticket-types",
      () => LIST_TIERS(new Request("http://localhost/api/v1/events/e1/ticket-types"), eventParams("e1")),
    ],
    [
      "PATCH /api/v1/events/{id}/ticket-types/{tier}",
      () => PATCH_TIER(patchJson({ name: "X" }), tierParams("e1", "t1")),
    ],
    [
      "DELETE /api/v1/events/{id}/ticket-types/{tier}",
      () =>
        DELETE_TIER(
          new Request("http://localhost/api/v1/events/e1/ticket-types/t1"),
          tierParams("e1", "t1"),
        ),
    ],
  ];

  it.each(cases)("%s answers 403 and reaches no business rule", async (_label, call) => {
    resolve.mockRejectedValue(new UnauthenticatedError("This request has no valid organiser session."));

    const response = await call();

    // 403, not 401: PRD §15 and rule 06 define no 401.
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("unauthenticated");
    expect(service.createTicketType).not.toHaveBeenCalled();
    expect(service.listTicketTypes).not.toHaveBeenCalled();
    expect(service.updateTicketType).not.toHaveBeenCalled();
    expect(service.deleteTicketType).not.toHaveBeenCalled();
  });

  it.each(cases)("%s authenticates before reading a malformed body", async (_label, call) => {
    // If the route parsed before authenticating this would answer 400; answering 403
    // proves the resolver runs first, so an unauthenticated caller cannot make the
    // server spend parsing work on their request.
    resolve.mockRejectedValue(new UnauthenticatedError("no session"));

    const response = await call();

    expect(response.status).toBe(403);
  });

  it("POST authenticates before reading a body that is not JSON", async () => {
    resolve.mockRejectedValue(new UnauthenticatedError("no session"));

    const response = await CREATE_TIER(
      new Request("http://localhost/api/v1/events/e1/ticket-types", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
      eventParams("e1"),
    );

    expect(response.status).toBe(403);
  });
});

describe("POST /api/v1/events/{id}/ticket-types", () => {
  it("answers 201 with the created tier", async () => {
    const response = await CREATE_TIER(postJson(VALID_BODY), eventParams("e1"));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(TIER);
  });

  it("takes the organiser from the session and the event from the path", async () => {
    await CREATE_TIER(postJson(VALID_BODY), eventParams("e1"));

    // The organiser comes from the auth context and the event from the path, so
    // ownership is checked against values the client cannot choose.
    expect(service.createTicketType).toHaveBeenCalledWith(
      ORGANISER_ID,
      "e1",
      expect.objectContaining({ name: "General Admission", quantityTotal: 100 }),
    );
  });

  it("rejects a body naming its own event rather than ignoring it", async () => {
    const response = await CREATE_TIER(
      postJson({ ...VALID_BODY, event_id: "somebody-elses-event" }),
      eventParams("e1"),
    );

    // Silently ignoring the key would leave the client believing it targeted a
    // different event than it did.
    expect(response.status).toBe(400);
    expect((await response.json()).error.fields.event_id).toBeDefined();
    expect(service.createTicketType).not.toHaveBeenCalled();
  });

  it("rejects an unknown field with 400 and reaches no business rule", async () => {
    const response = await CREATE_TIER(postJson({ ...VALID_BODY, tier_id: "forged" }), eventParams("e1"));

    expect(response.status).toBe(400);
    expect((await response.json()).error.fields.tier_id).toBeDefined();
    expect(service.createTicketType).not.toHaveBeenCalled();
  });

  it("rejects a body that tries to set the inventory counters", async () => {
    const response = await CREATE_TIER(
      postJson({ ...VALID_BODY, quantity_confirmed: 999 }),
      eventParams("e1"),
    );

    expect(response.status).toBe(400);
    expect(service.createTicketType).not.toHaveBeenCalled();
  });

  it("rejects invalid pricing or quantity with 400, as PRD §12 requires", async () => {
    for (const body of [
      { ...VALID_BODY, price_minor_units: -1 },
      { ...VALID_BODY, price_minor_units: 5_000.5 },
      { ...VALID_BODY, quantity_total: 0 },
      { ...VALID_BODY, currency: "NG" },
    ]) {
      const response = await CREATE_TIER(postJson(body), eventParams("e1"));
      expect(response.status).toBe(400);
    }

    expect(service.createTicketType).not.toHaveBeenCalled();
  });

  it("answers 409 for a duplicate tier name", async () => {
    service.createTicketType.mockRejectedValue(
      new ConflictError("This event already has a ticket tier with that name."),
    );

    const response = await CREATE_TIER(postJson(VALID_BODY), eventParams("e1"));

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("conflict");
  });

  it("answers 403 for another organiser's event", async () => {
    service.createTicketType.mockRejectedValue(new ForbiddenError("This event belongs to another organiser."));

    const response = await CREATE_TIER(postJson(VALID_BODY), eventParams("e1"));

    expect(response.status).toBe(403);
  });

  it("answers 404 for an unknown event", async () => {
    service.createTicketType.mockRejectedValue(new NotFoundError("No such event exists."));

    const response = await CREATE_TIER(postJson(VALID_BODY), eventParams("e1"));

    expect(response.status).toBe(404);
  });
});

describe("GET /api/v1/events/{id}/ticket-types", () => {
  it("returns the rule 06 pagination envelope", async () => {
    const response = await LIST_TIERS(
      new Request("http://localhost/api/v1/events/e1/ticket-types"),
      eventParams("e1"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [TIER], page: 1, page_size: 20, total: 1 });
  });

  it("passes the caller's own id, never a client-supplied owner", async () => {
    await LIST_TIERS(
      new Request("http://localhost/api/v1/events/e1/ticket-types?organiser_id=someone-else"),
      eventParams("e1"),
    );

    expect(service.listTicketTypes).toHaveBeenCalledWith(
      ORGANISER_ID,
      "e1",
      expect.objectContaining({ page: 1, pageSize: 20 }),
    );
  });

  it("forwards explicit pagination", async () => {
    await LIST_TIERS(
      new Request("http://localhost/api/v1/events/e1/ticket-types?page=2&page_size=5"),
      eventParams("e1"),
    );

    expect(service.listTicketTypes).toHaveBeenCalledWith(
      ORGANISER_ID,
      "e1",
      expect.objectContaining({ page: 2, pageSize: 5 }),
    );
  });

  it("returns 200 with an empty data array, never 404", async () => {
    service.listTicketTypes.mockResolvedValue({ data: [], page: 1, page_size: 20, total: 0 });

    const response = await LIST_TIERS(
      new Request("http://localhost/api/v1/events/e1/ticket-types"),
      eventParams("e1"),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual([]);
  });

  it("rejects a page_size above the hard cap rather than clamping it", async () => {
    const response = await LIST_TIERS(
      new Request("http://localhost/api/v1/events/e1/ticket-types?page_size=1000"),
      eventParams("e1"),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.fields.page_size).toBeDefined();
    expect(service.listTicketTypes).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/v1/events/{id}/ticket-types/{tier}", () => {
  it("answers 200 with the merged tier", async () => {
    const response = await PATCH_TIER(patchJson({ price_minor_units: 7_500 }), tierParams("e1", "t1"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(TIER);
  });

  it("forwards only the fields the caller sent", async () => {
    await PATCH_TIER(patchJson({ price_minor_units: 7_500 }), tierParams("e1", "t1"));

    // A PATCH is a merge. The handler must not send `undefined` for the fields it was
    // not given, or the service could not tell "absent" from "clear this".
    expect(service.updateTicketType).toHaveBeenCalledWith(ORGANISER_ID, "e1", "t1", {
      priceMinorUnits: 7_500,
    });
  });

  it("rejects an empty body rather than pretending to edit", async () => {
    const response = await PATCH_TIER(patchJson({}), tierParams("e1", "t1"));

    expect(response.status).toBe(400);
    expect(service.updateTicketType).not.toHaveBeenCalled();
  });

  it("rejects a body that tries to write the inventory counters", async () => {
    const response = await PATCH_TIER(patchJson({ quantity_held: 0 }), tierParams("e1", "t1"));

    // The counters move only through the §9.3 conditional transitions, so a PATCH
    // naming them is an error rather than a silently ignored key.
    expect(response.status).toBe(400);
    expect(service.updateTicketType).not.toHaveBeenCalled();
  });

  it("answers 400 naming quantity_total when the CHECK refuses a reduction", async () => {
    service.updateTicketType.mockRejectedValue(
      new ValidationError("The request body failed validation.", {
        quantity_total: ["Cannot be reduced below the number of units already confirmed or held."],
      }),
    );

    const response = await PATCH_TIER(patchJson({ quantity_total: 5 }), tierParams("e1", "t1"));

    expect(response.status).toBe(400);
    expect((await response.json()).error.fields.quantity_total).toBeDefined();
  });

  it("answers 404 for a tier that is not on the event in the path", async () => {
    service.updateTicketType.mockRejectedValue(
      new NotFoundError("No such ticket tier exists on this event."),
    );

    const response = await PATCH_TIER(patchJson({ name: "X" }), tierParams("e1", "t1"));

    expect(response.status).toBe(404);
  });
});

describe("DELETE /api/v1/events/{id}/ticket-types/{tier}", () => {
  it("answers 204 with no body", async () => {
    const response = await DELETE_TIER(
      new Request("http://localhost/api/v1/events/e1/ticket-types/t1"),
      tierParams("e1", "t1"),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(service.deleteTicketType).toHaveBeenCalledWith(ORGANISER_ID, "e1", "t1");
  });

  it("answers 409 when registrations still reference the tier", async () => {
    service.deleteTicketType.mockRejectedValue(
      new ConflictError("This ticket tier cannot be deleted while registrations still reference it."),
    );

    const response = await DELETE_TIER(
      new Request("http://localhost/api/v1/events/e1/ticket-types/t1"),
      tierParams("e1", "t1"),
    );

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("conflict");
  });

  it("answers 404 for a tier that is not on the event in the path", async () => {
    service.deleteTicketType.mockRejectedValue(
      new NotFoundError("No such ticket tier exists on this event."),
    );

    const response = await DELETE_TIER(
      new Request("http://localhost/api/v1/events/e1/ticket-types/t1"),
      tierParams("e1", "t1"),
    );

    expect(response.status).toBe(404);
  });
});

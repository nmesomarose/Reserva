import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `GET /api/v1/registrations/evidence` — the transport contract (PRD v2 §12 row 8,
 * FR-15, FR-19; rule 08).
 *
 * `evidence.service.test.ts` proves the service's decisions against a fake repository.
 * What only the route can show is what happens *before* the service is reached: a
 * malformed query must be a `400` naming the field, and — the part that actually matters
 * here — a query that could never match a stored reference must not be dressed up as a
 * `403` security refusal. A client bug that looks like a security event costs support
 * hours and teaches clients to retry a credential.
 *
 * The three anti-enumeration refusals are asserted to be *byte-identical*, because rule
 * 08 requires the refusal not to differ "in shape, timing, or wording" and a differing
 * `code` or message field would be the leak.
 */

const { getEvidenceService } = vi.hoisted(() => ({ getEvidenceService: vi.fn() }));

vi.mock("@/server/db/container", () => ({ getEvidenceService }));

import { GET } from "@/app/api/v1/registrations/evidence/route";
import { ForbiddenError } from "@/domain/errors";

const service = { retrieveEvidence: vi.fn() };

/** 42 URL-safe characters — the parser requires 40-64, as printed on the ticket. */
const REFERENCE = "TestReference_0123456789abcdefghijABCDEFGH";
const EMAIL = "ada@example.com";

const call = (query: string) =>
  GET(new Request(`http://localhost/api/v1/registrations/evidence?${query}`));

beforeEach(() => {
  vi.clearAllMocks();
  getEvidenceService.mockReturnValue(service);
});

describe("GET /api/v1/registrations/evidence", () => {
  it("returns the minimal ticket for a matching reference and email", async () => {
    const ticket = {
      unique_reference: REFERENCE,
      attendee_name: "Ada Lovelace",
      attendee_email: EMAIL,
      attendee_phone: "+2348012345678",
      event: {
        id: "event-1",
        name: "Jazz Night",
        slug: "jazz-night",
        venue: "Riverside Hall",
        starts_at: "2026-10-01T18:00:00.000Z",
      },
      ticket_type: { id: "tier-1", name: "General" },
      status: "confirmed",
    };
    service.retrieveEvidence.mockResolvedValue(ticket);

    const response = await call(
      `unique_reference=${REFERENCE}&email=${encodeURIComponent(EMAIL)}`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(ticket);
    // The service does its own case-insensitive comparison, so the route hands over the
    // values as given rather than pre-normalising them in two places.
    expect(service.retrieveEvidence).toHaveBeenCalledWith(REFERENCE, EMAIL);
  });

  it("needs no session, so no organiser context is consulted", async () => {
    // The attendee has no account (§3); possession of the PDF is the credential. An
    // auth seam on this route would make the feature unusable.
    service.retrieveEvidence.mockResolvedValue({ status: "confirmed" });

    const response = await call(
      `unique_reference=${REFERENCE}&email=${encodeURIComponent(EMAIL)}`,
    );

    expect(response.status).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // Validation runs first, and says which field was wrong
  // ---------------------------------------------------------------------------

  const cases: Array<[string, string]> = [
    ["a missing unique_reference", `email=${encodeURIComponent(EMAIL)}`],
    ["a missing email", `unique_reference=${REFERENCE}`],
    ["no parameters at all", ""],
    ["an empty unique_reference", `unique_reference=&email=${encodeURIComponent(EMAIL)}`],
    ["an empty email", `unique_reference=${REFERENCE}&email=`],
    [
      "a whitespace-only unique_reference",
      `unique_reference=%20%20&email=${encodeURIComponent(EMAIL)}`,
    ],
    ["an email with no @", `unique_reference=${REFERENCE}&email=not-an-email`],
    [
      "a reference containing characters no ticket carries",
      `unique_reference=${encodeURIComponent(`${"a".repeat(39)}!`)}&email=${encodeURIComponent(EMAIL)}`,
    ],
  ];

  it.each(cases)("answers 400 for %s, without consulting the service", async (_label, query) => {
    const response = await call(query);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("validation_failed");
    // A `400` rather than the `403` a non-match produces: the caller sent something
    // that could never be a stored reference, and telling them so is not a disclosure.
    expect(service.retrieveEvidence).not.toHaveBeenCalled();
  });

  it("trims surrounding whitespace instead of rejecting it", async () => {
    // A trailing space is the kind of thing a scan-to-form or a copy-paste produces, and
    // rejecting it would send the attendee round the loop for a reason no error could
    // explain. Normalising is friendlier and cannot widen access: the stored address
    // still has to match.
    service.retrieveEvidence.mockResolvedValue({ status: "confirmed" });

    const response = await call(
      `unique_reference=${REFERENCE}&email=${encodeURIComponent(` ${EMAIL} `)}`,
    );

    expect(response.status).toBe(200);
    expect(service.retrieveEvidence).toHaveBeenCalledWith(REFERENCE, EMAIL);
  });

  it("rejects a duplicated parameter instead of silently taking the first", async () => {
    // `URLSearchParams.get` returns the first value and drops the rest, so a client that
    // sent two references would get an answer about one of them without being told.
    const response = await call(
      `unique_reference=${REFERENCE}&unique_reference=${REFERENCE}&email=${encodeURIComponent(EMAIL)}`,
    );

    expect(response.status).toBe(400);
    expect(service.retrieveEvidence).not.toHaveBeenCalled();
  });

  it("names the offending field in the validation fields", async () => {
    const response = await call(`unique_reference=&email=${encodeURIComponent(EMAIL)}`);

    const body = await response.json();

    // `error.fields` on the wire is the spread of the domain's `issues`; a client
    // reading the domain name would see `undefined` and blame the server for a silent
    // rejection, so the key is asserted by name.
    expect(body.error.fields).toBeDefined();
    expect(body.error.fields.unique_reference).toBeDefined();
  });

  it("reports every bad field at once, so a client needs one round trip", async () => {
    const response = await call("unique_reference=TOOSHORT&email=not-an-email");

    const body = await response.json();

    expect(Object.keys(body.error.fields).sort()).toEqual(["email", "unique_reference"]);
  });

  // ---------------------------------------------------------------------------
  // Anti-enumeration
  // ---------------------------------------------------------------------------

  const refusals: Array<[string, unknown]> = [
    ["no such reference", new ForbiddenError("No ticket matches those details.")],
    ["a wrong email for a real reference", new ForbiddenError("No ticket matches those details.")],
    ["a reference belonging to somebody else", new ForbiddenError("No ticket matches those details.")],
  ];

  it.each(refusals)("answers the same 403 for %s", async (_label, thrown) => {
    service.retrieveEvidence.mockRejectedValue(thrown);

    const response = await call(
      `unique_reference=${REFERENCE}&email=${encodeURIComponent(EMAIL)}`,
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe("forbidden");
    // Never a 404: "real but not yours" is one bit more than the caller is entitled to.
    expect(response.status).not.toBe(404);
  });

  it("answers an identical response for all three refusals, byte for byte", async () => {
    // The rule is "must not differ in shape, timing, or wording". Shape and wording are
    // comparable here; timing is the service's problem, and this is the part a client
    // would actually diff to probe.
    const bodies: string[] = [];

    for (const thrown of [
      new ForbiddenError("No ticket matches those details."),
      new ForbiddenError("No ticket matches those details."),
      new ForbiddenError("No ticket matches those details."),
    ]) {
      service.retrieveEvidence.mockRejectedValue(thrown);
      const response = await call(
        `unique_reference=${REFERENCE}&email=${encodeURIComponent(EMAIL)}`,
      );
      bodies.push(`${response.status} ${JSON.stringify(await response.json())}`);
    }

    expect(new Set(bodies).size).toBe(1);
  });

  it("adds nothing of its own to the refusal", async () => {
    // Where the identical wording actually comes from matters, so it is stated rather
    // than left implied: the *service* raises one `ForbiddenError` message for all three
    // causes, and `evidence.service.test.ts` asserts that. The route is a pass-through,
    // so the body is exactly the service's message with no wrapper, no cause, and no
    // field naming which factor failed.
    //
    // A route-level override was considered and rejected: it would mean two files
    // defining the refusal wording, and the one that actually guards the invariant would
    // no longer be the one that owns it.
    service.retrieveEvidence.mockRejectedValue(
      new ForbiddenError("No ticket matches those details."),
    );

    const response = await call(
      `unique_reference=${REFERENCE}&email=${encodeURIComponent(EMAIL)}`,
    );
    const body = await response.json();

    expect(body).toEqual({
      error: { code: "forbidden", message: "No ticket matches those details." },
    });
  });

  // ---------------------------------------------------------------------------
  // The response is the minimal ticket
  // ---------------------------------------------------------------------------

  it("sends exactly what the service returned, adding no fields of its own", async () => {
    // The allow-list lives in `evidence.dto.ts`; this asserts the route is a pass-through
    // so there is no second place a field could be added.
    const ticket = { unique_reference: REFERENCE, status: "confirmed" };
    service.retrieveEvidence.mockResolvedValue(ticket);

    const response = await call(
      `unique_reference=${REFERENCE}&email=${encodeURIComponent(EMAIL)}`,
    );

    expect(Object.keys(await response.json()).sort()).toEqual(
      Object.keys(ticket).sort(),
    );
  });

  it("never caches a live ticket", async () => {
    const ticket = { unique_reference: REFERENCE, status: "confirmed" };
    service.retrieveEvidence.mockResolvedValue(ticket);

    const response = await call(
      `unique_reference=${REFERENCE}&email=${encodeURIComponent(EMAIL)}`,
    );

    // The body is a live ticket, and a cached copy is a ticket that may no longer be
    // valid: a refund would leave a forwarded link serving a ticket for a seat that has
    // been sold again. `dynamic = "force-dynamic"` alone would not stop a browser or a
    // shared proxy storing it, so the header is explicit.
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

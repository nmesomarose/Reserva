import { describe, expect, it } from "vitest";

import { ValidationError } from "@/domain/errors";
import {
  parseCreateEventRequest,
  parseCreateProgrammeItemRequest,
  parseListEventsQuery,
  parseUpdateEventRequest,
  parseUpdateProgrammeItemRequest,
} from "@/server/validation/validation";

/**
 * Centralised validation tests for `POST /api/v1/events` (PRD v2 §12).
 *
 * Product-owner decision 4 (2026-09-26) settled the event-field limits, so what
 * follows is a product contract rather than a placeholder:
 *
 *   name 1..200 · description OPTIONAL and <= 5000 · venue 1..300 ·
 *   starts_at/ends_at offset-aware · ends_at > starts_at
 *
 * The matching database CHECKs are proved separately by
 * `npm run db:verify-constraints`; this file proves the HTTP-layer half.
 */

const VALID_BODY = {
  name: "Jazz Night",
  description: "Two sets of improvised jazz.",
  starts_at: "2026-10-01T18:00:00Z",
  ends_at: "2026-10-01T22:00:00Z",
  venue: "The Blue Room",
};

function issuesFor(body: unknown): Record<string, string[]> {
  try {
    parseCreateEventRequest(body);
  } catch (error) {
    if (error instanceof ValidationError) {
      return { ...error.issues } as Record<string, string[]>;
    }

    throw error;
  }

  throw new Error("Expected parseCreateEventRequest to reject the body");
}

describe("parseCreateEventRequest", () => {
  it("parses a valid body into a domain command", () => {
    const command = parseCreateEventRequest(VALID_BODY);

    expect(command).toEqual({
      name: "Jazz Night",
      description: "Two sets of improvised jazz.",
      startsAt: new Date("2026-10-01T18:00:00Z"),
      endsAt: new Date("2026-10-01T22:00:00Z"),
      venue: "The Blue Room",
    });
  });

  it("trims surrounding whitespace on string fields", () => {
    const command = parseCreateEventRequest({
      ...VALID_BODY,
      name: "  Jazz Night  ",
    });

    expect(command.name).toBe("Jazz Night");
  });

  it("normalises an offset timestamp to the same instant", () => {
    const command = parseCreateEventRequest({
      ...VALID_BODY,
      starts_at: "2026-10-01T19:00:00+01:00",
    });

    expect(command.startsAt.toISOString()).toBe("2026-10-01T18:00:00.000Z");
  });

  it("rejects a body that is not an object", () => {
    expect(() => parseCreateEventRequest("nope")).toThrow(ValidationError);
    expect(() => parseCreateEventRequest(null)).toThrow(ValidationError);
    expect(() => parseCreateEventRequest([VALID_BODY])).toThrow(ValidationError);
  });

  it("reports every missing field at once, not just the first", () => {
    const issues = issuesFor({});

    // `description` is absent from this list because decision 4 made it
    // OPTIONAL: an empty body is missing four required fields, not five.
    expect(Object.keys(issues).sort()).toEqual(["ends_at", "name", "starts_at", "venue"]);
  });

  it("rejects blank and whitespace-only strings", () => {
    const issues = issuesFor({ ...VALID_BODY, name: "   " });

    expect(issues.name).toContain("Required, and cannot be blank.");
  });

  it("rejects a non-string where a string is required", () => {
    expect(issuesFor({ ...VALID_BODY, venue: 42 }).venue).toBeDefined();
  });

  it("enforces the decision-4 length limits", () => {
    const issues = issuesFor({
      ...VALID_BODY,
      name: "n".repeat(201),
      description: "d".repeat(5_001),
      venue: "v".repeat(301),
    });

    expect(issues.name).toContain("Must be at most 200 characters.");
    expect(issues.description).toContain("Must be at most 5000 characters.");
    expect(issues.venue).toContain("Must be at most 300 characters.");
  });

  it("accepts each field at exactly its limit", () => {
    // The boundary must be inclusive. Without this, a CHECK written as `<`
    // instead of `<=` would pass every rejection test above and still be wrong.
    const command = parseCreateEventRequest({
      ...VALID_BODY,
      name: "n".repeat(200),
      description: "d".repeat(5_000),
      venue: "v".repeat(300),
    });

    expect(command.name).toHaveLength(200);
    expect(command.description).toHaveLength(5_000);
    expect(command.venue).toHaveLength(300);
  });

  it("treats an omitted description as null rather than rejecting it", () => {
    // Written out rather than produced by omitting the key from `VALID_BODY`, so
    // the absence being tested is visible at the point of the assertion.
    const withoutDescription = {
      name: "Jazz Night",
      starts_at: "2026-10-01T18:00:00Z",
      ends_at: "2026-10-01T22:00:00Z",
      venue: "The Blue Room",
    };

    expect(parseCreateEventRequest(withoutDescription).description).toBeNull();
  });

  it("treats an explicit null description as absent", () => {
    expect(parseCreateEventRequest({ ...VALID_BODY, description: null }).description).toBeNull();
  });

  it("rejects a blank description rather than reading it as 'no description'", () => {
    // `""` on create has nothing to clear, so it is a client bug; silently
    // storing it as NULL would hide a form that submitted an empty textarea as
    // a string.
    const issues = issuesFor({ ...VALID_BODY, description: "   " });

    expect(issues.description).toContain("Cannot be blank.");
  });

  it("rejects a timestamp with no UTC offset", () => {
    // A naive local time has no single correct instant; assuming UTC would move
    // the event by hours for an organiser in another timezone.
    const issues = issuesFor({ ...VALID_BODY, starts_at: "2026-10-01T18:00:00" });

    expect(issues.starts_at?.[0]).toMatch(/UTC offset/);
  });

  it("rejects an unparseable timestamp even when it carries an offset", () => {
    // Day 32 does not exist, so the string is well-formed as ISO 8601 but not a
    // real instant. This proves the range check runs after the offset check.
    const issues = issuesFor({ ...VALID_BODY, ends_at: "2026-10-32T18:00:00Z" });

    expect(issues.ends_at).toContain("Must be a valid ISO 8601 timestamp.");
  });

  it("reports the offset rule for a string that cannot be a timestamp at all", () => {
    const issues = issuesFor({ ...VALID_BODY, ends_at: "not-a-date" });

    expect(issues.ends_at?.[0]).toMatch(/UTC offset/);
  });

  it("rejects ends_at that is not strictly after starts_at", () => {
    const issuesEqual = issuesFor({
      ...VALID_BODY,
      ends_at: VALID_BODY.starts_at,
    });
    const issuesReversed = issuesFor({
      ...VALID_BODY,
      starts_at: VALID_BODY.ends_at,
    });

    expect(issuesEqual.ends_at).toContain("Must be after starts_at.");
    expect(issuesReversed.ends_at).toContain("Must be after starts_at.");
  });

  it("rejects fields the contract does not define", () => {
    // The security-relevant case: a client must not be able to assert ownership
    // or a lifecycle status, because the schema has a UNIQUE(events_slug_key).
    const issues = issuesFor({
      ...VALID_BODY,
      organiser_id: "00000000-0000-0000-0000-000000000001",
      status: "published",
      slug: "chosen-by-the-client",
    });

    expect(issues.organiser_id).toBeDefined();
    expect(issues.status).toBeDefined();
    expect(issues.slug).toBeDefined();
  });

  it("accepts a name with no URL-safe characters only in the sense of reporting it", () => {
    // The length/uniqueness rules pass; slug-ability is a domain concern, proven
    // in events.service.test.ts, so the validator must not reject it here.
    expect(() =>
      parseCreateEventRequest({ ...VALID_BODY, name: "日本語" }),
    ).not.toThrow();
  });
});

/**
 * The PATCH / programme / pagination parsers added on 2026-09-26.
 *
 * The important property to pin down here is the difference between a key being
 * **absent** ("leave this column alone") and a key being explicitly `null`
 * ("clear this column"). Service-layer merges depend on that distinction, so a
 * parser that conflated the two would silently blank fields nobody mentioned.
 */
describe("parseUpdateEventRequest", () => {
  it("keeps only the fields that were sent", () => {
    const command = parseUpdateEventRequest({ venue: "Riverside Hall" });

    expect(command).toEqual({ venue: "Riverside Hall" });
    expect("name" in command).toBe(false);
  });

  it("accepts a status inside the enum", () => {
    expect(parseUpdateEventRequest({ status: "closed" })).toEqual({ status: "closed" });
  });

  it("rejects a status outside the enum", () => {
    expect(() => parseUpdateEventRequest({ status: "live" })).toThrow(ValidationError);
  });

  it("rejects a body with nothing to change", () => {
    expect(() => parseUpdateEventRequest({})).toThrow(ValidationError);
  });

  it("rejects ownership and slug smuggled into the body", () => {
    expect(() =>
      parseUpdateEventRequest({ organiser_id: "attacker", slug: "mine" }),
    ).toThrow(ValidationError);
  });

  it("requires an explicit offset on a timestamp", () => {
    expect(() => parseUpdateEventRequest({ starts_at: "2026-10-01T18:00:00" })).toThrow(
      ValidationError,
    );
  });

  it("trims like the create path", () => {
    expect(parseUpdateEventRequest({ name: "  Jazz Night  " })).toEqual({ name: "Jazz Night" });
  });

  it("keeps an explicit null description so a blurb can be cleared", () => {
    // Decision 4 made description optional, and "optional" has to be settable in
    // both directions. `definedOnly` drops `undefined`, so a parser that
    // returned `undefined` here would make clearing indistinguishable from
    // "leave it alone" and the column could never be emptied.
    expect(parseUpdateEventRequest({ description: null })).toEqual({ description: null });
  });

  it("distinguishes an absent description from a null one", () => {
    const command = parseUpdateEventRequest({ venue: "Riverside Hall" });

    expect("description" in command).toBe(false);
  });

  it("rejects a blank description rather than treating it as a clear", () => {
    // A client wanting to clear sends `null`. `""` is almost always a stray
    // form field, and storing it would leave a blank blurb in the database.
    expect(() => parseUpdateEventRequest({ description: "  " })).toThrow(ValidationError);
  });

  it("collects every bad field in one error", () => {
    try {
      parseUpdateEventRequest({ name: "", status: "live", venue: 42 });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(Object.keys((error as ValidationError).issues).sort()).toEqual([
        "name",
        "status",
        "venue",
      ]);
    }
  });
});

describe("parseCreateProgrammeItemRequest", () => {
  it("parses the fields FR-2 needs, storing the supplied order", () => {
    const input = parseCreateProgrammeItemRequest({
      sort_order: 0,
      time: "2026-10-01T18:00:00Z",
      title: "Doors",
      description: "Opens at six.",
    });

    expect(input).toEqual({
      sortOrder: 0,
      time: new Date("2026-10-01T18:00:00Z"),
      title: "Doors",
      description: "Opens at six.",
    });
  });

  it("allows a programme line with no fixed time", () => {
    expect(parseCreateProgrammeItemRequest({ sort_order: 1, title: "Interval" }).time).toBeNull();
  });

  it("defaults an omitted description to null", () => {
    expect(parseCreateProgrammeItemRequest({ sort_order: 1, title: "Doors" }).description).toBeNull();
  });

  it("rejects a non-integer sort_order", () => {
    expect(() =>
      parseCreateProgrammeItemRequest({ sort_order: 1.5, title: "Doors" }),
    ).toThrow(ValidationError);
  });

  it("rejects a negative sort_order", () => {
    expect(() =>
      parseCreateProgrammeItemRequest({ sort_order: -1, title: "Doors" }),
    ).toThrow(ValidationError);
  });

  it("requires a title", () => {
    expect(() => parseCreateProgrammeItemRequest({ sort_order: 1 })).toThrow(ValidationError);
  });
});

describe("parseUpdateProgrammeItemRequest", () => {
  it("distinguishes an explicit null from an absent key", () => {
    expect(parseUpdateProgrammeItemRequest({ description: null })).toEqual({
      description: null,
    });
    expect(parseUpdateProgrammeItemRequest({ title: "Late set" })).toEqual({
      title: "Late set",
    });
  });

  it("keeps an explicit null time as null rather than dropping it", () => {
    const patch = parseUpdateProgrammeItemRequest({ time: null });

    expect("time" in patch).toBe(true);
    expect(patch.time).toBeNull();
  });

  it("rejects a patch with nothing in it", () => {
    expect(() => parseUpdateProgrammeItemRequest({})).toThrow(ValidationError);
  });

  it("rejects an unknown field", () => {
    expect(() =>
      parseUpdateProgrammeItemRequest({ sort_order: 1, event_id: "elsewhere" }),
    ).toThrow(ValidationError);
  });
});

describe("parseListEventsQuery", () => {
  const parse = (query: string) => parseListEventsQuery(new URLSearchParams(query));

  it("defaults to page 1, size 20", () => {
    expect(parse("")).toEqual({ page: 1, pageSize: 20 });
  });

  it("accepts the cap exactly", () => {
    expect(parse("page_size=50").pageSize).toBe(50);
  });

  it("rejects above the cap rather than clamping", () => {
    expect(() => parse("page_size=51")).toThrow(ValidationError);
  });

  it("rejects zero, negative, and non-numeric values instead of defaulting", () => {
    for (const query of ["page=0", "page=-2", "page=two", "page_size=0", "page_size="]) {
      expect(() => parse(query)).toThrow(ValidationError);
    }
  });

  it("rejects exponent notation, which Number() would otherwise accept", () => {
    expect(() => parse("page_size=1e3")).toThrow(ValidationError);
  });

  it("carries a valid status filter through", () => {
    expect(parse("status=published").status).toBe("published");
  });

  it("rejects an unknown status", () => {
    expect(() => parse("status=live")).toThrow(ValidationError);
  });
});

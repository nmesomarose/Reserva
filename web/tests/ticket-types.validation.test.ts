import { describe, expect, it } from "vitest";

import { ValidationError } from "@/domain/errors";
import {
  parseCreateTicketTypeRequest,
  parseListTicketTypesQuery,
  parseUpdateTicketTypeRequest,
} from "@/server/validation/validation";

/**
 * Validation for the tier routes (PRD v2 §12, skill step 2).
 *
 * Product-owner decision 5 (2026-09-26) settled the field limits, so these are a
 * product contract rather than placeholders:
 *
 *   name 1..200 · description OPTIONAL and <= 5000 ·
 *   price_minor_units integer >= 0 · currency exactly three ASCII letters, uppercased ·
 *   quantity_total integer >= 1
 *
 * The matching database CHECKs are proved separately by
 * `npm run db:verify-constraints`; this file proves the HTTP-layer half. Every limit
 * is tested at its boundary *and* one past it, because a limit written as `<` instead
 * of `<=` passes every rejection test above and is still wrong.
 */

const VALID_BODY = {
  name: "General Admission",
  price_minor_units: 5_000,
  currency: "NGN",
  quantity_total: 100,
};

function issuesFor(body: unknown): Record<string, string[]> {
  try {
    parseCreateTicketTypeRequest(body);
  } catch (error) {
    if (error instanceof ValidationError) {
      return { ...error.issues } as Record<string, string[]>;
    }

    throw error;
  }

  throw new Error("Expected parseCreateTicketTypeRequest to reject the body");
}

function updateIssuesFor(body: unknown): Record<string, string[]> {
  try {
    parseUpdateTicketTypeRequest(body);
  } catch (error) {
    if (error instanceof ValidationError) {
      return { ...error.issues } as Record<string, string[]>;
    }

    throw error;
  }

  throw new Error("Expected parseUpdateTicketTypeRequest to reject the body");
}

describe("parseCreateTicketTypeRequest", () => {
  it("parses a valid body into a domain command", () => {
    expect(
      parseCreateTicketTypeRequest({
        ...VALID_BODY,
        description: "Standing entry, unreserved seating.",
      }),
    ).toEqual({
      name: "General Admission",
      description: "Standing entry, unreserved seating.",
      priceMinorUnits: 5_000,
      currency: "NGN",
      quantityTotal: 100,
    });
  });

  it("reports every missing field at once, not just the first", () => {
    // `description` is absent: decision 5 made it OPTIONAL, so an empty body is
    // missing four required fields, not five.
    expect(Object.keys(issuesFor({})).sort()).toEqual([
      "currency",
      "name",
      "price_minor_units",
      "quantity_total",
    ]);
  });

  it("rejects a body that is not an object", () => {
    expect(() => parseCreateTicketTypeRequest("nope")).toThrow(ValidationError);
    expect(() => parseCreateTicketTypeRequest(null)).toThrow(ValidationError);
    expect(() => parseCreateTicketTypeRequest([VALID_BODY])).toThrow(ValidationError);
  });

  it("rejects a field the allowlist does not contain, naming the offending key", () => {
    const issues = issuesFor({ ...VALID_BODY, id: "forged" });

    expect(issues.id).toContain("Not a recognised field for this request.");
  });

  it("rejects a caller-supplied event_id", () => {
    // The event comes from the path and is ownership-checked server-side (rule 05).
    // Letting the body name it would be a second, unchecked way to target an event.
    const issues = issuesFor({ ...VALID_BODY, event_id: "some-other-event" });

    expect(issues.event_id).toBeDefined();
  });

  it("rejects a caller-supplied quantity_confirmed or quantity_held", () => {
    // Inventory is not input. A client that could set these would be choosing its
    // own stock, bypassing the conditional transitions entirely.
    const confirmed = issuesFor({ ...VALID_BODY, quantity_confirmed: 10 });
    const held = issuesFor({ ...VALID_BODY, quantity_held: 10 });

    expect(confirmed.quantity_confirmed).toBeDefined();
    expect(held.quantity_held).toBeDefined();
  });

  it("rejects blank and whitespace-only strings", () => {
    expect(issuesFor({ ...VALID_BODY, name: "   " }).name).toContain(
      "Required, and cannot be blank.",
    );
  });

  it("rejects a non-string where a string is required", () => {
    expect(issuesFor({ ...VALID_BODY, name: 42 }).name).toBeDefined();
  });

  it("enforces the decision-5 name limit one past its boundary", () => {
    expect(issuesFor({ ...VALID_BODY, name: "n".repeat(201) }).name).toContain(
      "Must be at most 200 characters.",
    );
  });

  it("accepts a name of exactly 200 characters", () => {
    expect(parseCreateTicketTypeRequest({ ...VALID_BODY, name: "n".repeat(200) }).name).toHaveLength(
      200,
    );
  });

  it("trims surrounding whitespace on string fields", () => {
    const command = parseCreateTicketTypeRequest({ ...VALID_BODY, name: "  General Admission  " });

    expect(command.name).toBe("General Admission");
  });

  it("rejects a blank description rather than storing it", () => {
    // `""` has nothing to clear, so it is a client bug; storing NULL would hide a
    // form that submitted an empty textarea as a string.
    expect(issuesFor({ ...VALID_BODY, description: "   " }).description).toContain(
      "Cannot be blank.",
    );
  });

  it("enforces the decision-5 description limit one past its boundary", () => {
    expect(issuesFor({ ...VALID_BODY, description: "d".repeat(5_001) }).description).toContain(
      "Must be at most 5000 characters.",
    );
  });

  it("accepts a description of exactly 5000 characters", () => {
    expect(
      parseCreateTicketTypeRequest({ ...VALID_BODY, description: "d".repeat(5_000) }).description,
    ).toHaveLength(5_000);
  });

  it("treats an omitted description as null", () => {
    expect(parseCreateTicketTypeRequest(VALID_BODY).description).toBeNull();
  });

  it("treats an explicit null description as absent", () => {
    expect(parseCreateTicketTypeRequest({ ...VALID_BODY, description: null }).description).toBeNull();
  });

  it("accepts a zero price: free tiers are legal, the floor is 0 not 1", () => {
    expect(
      parseCreateTicketTypeRequest({ ...VALID_BODY, price_minor_units: 0 }).priceMinorUnits,
    ).toBe(0);
  });

  it("rejects a negative price", () => {
    expect(issuesFor({ ...VALID_BODY, price_minor_units: -1 }).price_minor_units).toBeDefined();
  });

  it("rejects a fractional price", () => {
    // Money is integer minor units (AGENTS.md §5, FR-11). A float here would
    // silently lose or gain minor units depending on the rounding.
    expect(issuesFor({ ...VALID_BODY, price_minor_units: 5_000.5 }).price_minor_units).toBeDefined();
  });

  it("rejects a price sent as a numeric string", () => {
    expect(issuesFor({ ...VALID_BODY, price_minor_units: "5000" }).price_minor_units).toBeDefined();
  });

  it("rejects a non-integer quantity_total", () => {
    expect(issuesFor({ ...VALID_BODY, quantity_total: 10.5 }).quantity_total).toBeDefined();
  });

  it("rejects a quantity_total of zero", () => {
    // Zero capacity satisfies the sum CHECK and would be an unsellable tier.
    expect(issuesFor({ ...VALID_BODY, quantity_total: 0 }).quantity_total).toContain(
      "Must be 1 or greater.",
    );
  });

  it("rejects a negative quantity_total", () => {
    expect(issuesFor({ ...VALID_BODY, quantity_total: -5 }).quantity_total).toBeDefined();
  });

  it("accepts a quantity_total of exactly 1", () => {
    expect(
      parseCreateTicketTypeRequest({ ...VALID_BODY, quantity_total: 1 }).quantityTotal,
    ).toBe(1);
  });

  it("uppercases a lower-case currency code", () => {
    expect(parseCreateTicketTypeRequest({ ...VALID_BODY, currency: "ngn" }).currency).toBe("NGN");
  });

  it("rejects a currency that is not exactly three letters", () => {
    expect(issuesFor({ ...VALID_BODY, currency: "NG" }).currency).toBeDefined();
    expect(issuesFor({ ...VALID_BODY, currency: "NGNX" }).currency).toBeDefined();
    expect(issuesFor({ ...VALID_BODY, currency: "N1N" }).currency).toBeDefined();
  });

  it("rejects a non-ASCII currency code that would pass a lax length check", () => {
    // Three characters, but not three ASCII letters. A `length(name) = 3` test would
    // have accepted this and the column would store a code no payment can use.
    expect(issuesFor({ ...VALID_BODY, currency: "ÑGÑ" }).currency).toBeDefined();
  });
});

describe("parseUpdateTicketTypeRequest", () => {
  it("returns only the keys the caller actually sent", () => {
    // A PATCH is a merge. Echoing a `undefined`-valued key for every absent field
    // would be indistinguishable from a caller having sent them all as null.
    expect(parseUpdateTicketTypeRequest({ price_minor_units: 7_500 })).toEqual({
      priceMinorUnits: 7_500,
    });
  });

  it("distinguishes an explicit null description from an absent one", () => {
    expect(parseUpdateTicketTypeRequest({ description: null })).toEqual({ description: null });
    expect(parseUpdateTicketTypeRequest({ name: "Renamed" })).toEqual({ name: "Renamed" });
  });

  it("rejects an empty body", () => {
    // Otherwise a PATCH with nothing in it would return 200 and look like an edit.
    expect(updateIssuesFor({}).body?.[0]).toMatch(/Send at least one of/);
  });

  it("does not also complain about the body when a sent field failed", () => {
    // "send at least one field" would be misleading advice for a body that did send
    // one; the field-level error is the actionable one.
    const issues = updateIssuesFor({ price_minor_units: -1 });

    expect(issues.body).toBeUndefined();
    expect(issues.price_minor_units).toBeDefined();
  });

  it("rejects a caller trying to patch the inventory counters", () => {
    expect(updateIssuesFor({ quantity_confirmed: 10 }).quantity_confirmed).toBeDefined();
    expect(updateIssuesFor({ quantity_held: 10 }).quantity_held).toBeDefined();
  });

  it("applies the same limits as create", () => {
    expect(updateIssuesFor({ name: "n".repeat(201) }).name).toContain(
      "Must be at most 200 characters.",
    );
    expect(updateIssuesFor({ description: "d".repeat(5_001) }).description).toContain(
      "Must be at most 5000 characters.",
    );
    expect(updateIssuesFor({ quantity_total: 0 }).quantity_total).toBeDefined();
  });

  it("accepts each field at exactly its limit", () => {
    expect(
      parseUpdateTicketTypeRequest({
        name: "n".repeat(200),
        description: "d".repeat(5_000),
        price_minor_units: 0,
        currency: "gbp",
        quantity_total: 1,
      }),
    ).toEqual({
      name: "n".repeat(200),
      description: "d".repeat(5_000),
      priceMinorUnits: 0,
      currency: "GBP",
      quantityTotal: 1,
    });
  });

  it("cannot judge quantity_total against stock, so it does not pretend to", () => {
    // A tier with 80 sold may still be raised to 100 by this parse; only the stored
    // row and the database CHECK know. Asserted here so the absence of such a check
    // is a stated contract rather than an oversight someone "fixes" later.
    expect(parseUpdateTicketTypeRequest({ quantity_total: 100 }).quantityTotal).toBe(100);
  });
});

describe("parseListTicketTypesQuery", () => {
  it("defaults to the shared pagination values", () => {
    expect(parseListTicketTypesQuery(new URLSearchParams())).toEqual({ page: 1, pageSize: 20 });
  });

  it("parses explicit pagination", () => {
    const page = parseListTicketTypesQuery(new URLSearchParams("page=3&page_size=5"));

    expect(page).toEqual({ page: 3, pageSize: 5 });
  });

  it("rejects rather than clamps an over-large page_size", () => {
    // Same choice as the event list, so the two are visibly consistent rather than
    // accidentally so.
    expect(() => parseListTicketTypesQuery(new URLSearchParams("page_size=1000"))).toThrow(
      ValidationError,
    );
  });

  it("rejects a non-numeric or zero pagination value", () => {
    expect(() => parseListTicketTypesQuery(new URLSearchParams("page=abc"))).toThrow(
      ValidationError,
    );
    expect(() => parseListTicketTypesQuery(new URLSearchParams("page=0"))).toThrow(
      ValidationError,
    );
  });

  it("has no filter parameter, because PRD §12 documents none for this endpoint", () => {
    // §12 scopes extra list parameters to search (`query`) and requests (`status`).
    // A ticket-type list is neither, so adding one would be an undocumented
    // parameter silently becoming part of the contract.
    const page = parseListTicketTypesQuery(new URLSearchParams("status=sold_out&q=vip"));

    expect(page).toEqual({ page: 1, pageSize: 20 });
  });
});

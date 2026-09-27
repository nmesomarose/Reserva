import { describe, expect, it } from "vitest";

/**
 * The registration and payment body parsers (PRD v2 §12, §11).
 *
 * These are the seam where an attendee's browser first touches this product, and each
 * assertion below guards a specific way the alternative is harmful rather than merely
 * pedantic:
 *
 *   - a **client-supplied amount** (§12's note, FR-11) is the mistake worth failing
 *     the build over: accepting one makes the price an input;
 *   - a **wrong-type field** must not be coerced. `String(12345)` is a valid payment
 *     reference, so a parser that stringifies would resolve a payment the caller never
 *     named;
 *   - a **wrong event** in a path parameter cannot be checked here, and a `ticket_type_id`
 *     that belongs to another event can only be caught by the service;
 *   - **`tx_ref` must be accepted**, because it is the name the provider itself appends
 *     to the redirect URL — a parser that honours only the PRD's spelling leaves the
 *     redirect channel unable to find its own payment.
 */

import { ValidationError } from "@/domain/errors";
import {
  parseCreateRegistrationRequest,
  parseInitiatePaymentRequest,
  parseVerifyPaymentBodyRequest,
  parseVerifyPaymentQuery,
} from "@/server/validation/validation";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const TICKET_TYPE_ID = "33333333-3333-4333-8333-333333333333";
const REGISTRATION_ID = "55555555-5555-4555-8555-555555555555";
const IDEMPOTENCY_KEY = "66666666-6666-4666-8666-666666666666";

/** §12's five fields, verbatim, and nothing else. */
function validRegistrationBody(): Record<string, unknown> {
  return {
    attendee_name: "Ada Lovelace",
    email: "ada@example.com",
    phone: "+2348012345678",
    ticket_type_id: TICKET_TYPE_ID,
    idempotency_key: IDEMPOTENCY_KEY,
  };
}

const PROVIDER_REFERENCE = "rsv_8Xk2mQ7pL4vR1sT6yB0nJ3wZ5cD7fH1aG9iK2l";

/** Every field the parser rejected, so "it complained" is never enough on its own. */
function issuesOf(error: unknown): Record<string, readonly string[]> {
  if (!(error instanceof ValidationError)) {
    throw error;
  }

  return error.issues;
}

describe("POST /events/{id}/registrations: the body §12 asks for", () => {
  it("accepts exactly the five fields, in their documented names", () => {
    expect(parseCreateRegistrationRequest(validRegistrationBody())).toEqual({
      attendeeName: "Ada Lovelace",
      attendeeEmail: "ada@example.com",
      attendeePhone: "+2348012345678",
      ticketTypeId: TICKET_TYPE_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
  });

  it("renames email and phone for the domain without changing their meaning", () => {
    // The stored columns are attendee_email/attendee_phone while §12's body says
    // email/phone. The parser is the only place that asymmetry can be reconciled, and
    // it must not "correct" the wire names.
    const command = parseCreateRegistrationRequest(validRegistrationBody());

    expect(command.attendeeEmail).toBe("ada@example.com");
    expect(command.attendeePhone).toBe("+2348012345678");
    expect(Object.keys(command)).not.toContain("email");
    expect(Object.keys(command)).not.toContain("phone");
  });

  it("trims surrounding whitespace rather than storing it", () => {
    const command = parseCreateRegistrationRequest({
      ...validRegistrationBody(),
      attendee_name: "  Ada Lovelace  ",
      email: " ada@example.com ",
    });

    expect(command.attendeeName).toBe("Ada Lovelace");
    expect(command.attendeeEmail).toBe("ada@example.com");
  });

  it("lower-cases a UUID so two spellings cannot defeat a UNIQUE comparison", () => {
    const command = parseCreateRegistrationRequest({
      ...validRegistrationBody(),
      ticket_type_id: TICKET_TYPE_ID.toUpperCase(),
    });

    expect(command.ticketTypeId).toBe(TICKET_TYPE_ID);
  });
});

describe("POST /events/{id}/registrations: what it must refuse", () => {
  it("REFUSES a client-supplied amount, and says which field is not allowed", () => {
    // FR-11 and §12's "amount always server-computed". A parser that ignored unknown
    // fields would let a price arrive from the browser, and the only defence left
    // would be trusting the service to not read it.
    try {
      parseCreateRegistrationRequest({ ...validRegistrationBody(), amount: 1 });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(Object.keys(issuesOf(error))).toContain("amount");
    }
  });

  it("refuses a client-supplied price in minor units as well", () => {
    expect(() =>
      parseCreateRegistrationRequest({ ...validRegistrationBody(), price_minor_units: 500_000 }),
    ).toThrow(ValidationError);
  });

  it("refuses a status field, which is a lifecycle transition in disguise", () => {
    expect(() =>
      parseCreateRegistrationRequest({ ...validRegistrationBody(), status: "confirmed" }),
    ).toThrow(ValidationError);
  });

  it("refuses an event_id in the body, which comes from the path", () => {
    expect(() =>
      parseCreateRegistrationRequest({ ...validRegistrationBody(), event_id: EVENT_ID }),
    ).toThrow(ValidationError);
  });

  it("names every missing field at once, so the form can correct itself in one pass", () => {
    try {
      parseCreateRegistrationRequest({});
      throw new Error("expected a refusal");
    } catch (error) {
      expect(Object.keys(issuesOf(error)).sort()).toEqual([
        "attendee_name",
        "email",
        "idempotency_key",
        "phone",
        "ticket_type_id",
      ]);
    }
  });

  it("refuses a non-UUID ticket type, and a UUID is not merely non-blank", () => {
    try {
      parseCreateRegistrationRequest({ ...validRegistrationBody(), ticket_type_id: "general-admission" });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(issuesOf(error)["ticket_type_id"]?.[0]).toMatch(/UUID/i);
    }
  });

  it("refuses an idempotency key that is not a UUID", () => {
    // An idempotency key becomes a UNIQUE column value; a free-form string here would
    // be stored as-is and compared by whatever collation the database chose.
    expect(() =>
      parseCreateRegistrationRequest({ ...validRegistrationBody(), idempotency_key: "abc-123" }),
    ).toThrow(ValidationError);
  });

  it("refuses a blank attendee name, email, or phone", () => {
    for (const field of ["attendee_name", "email", "phone"]) {
      try {
        parseCreateRegistrationRequest({ ...validRegistrationBody(), [field]: "   " });
        throw new Error(`expected a refusal for ${field}`);
      } catch (error) {
        expect(issuesOf(error)[field]).toBeDefined();
      }
    }
  });

  it("refuses an email with no registrable domain, which could never receive mail", () => {
    // FR-15 uses the address as a second factor and FR-17 as a fallback search key;
    // an undeliverable address makes a paid ticket unretrievable.
    for (const email of ["ada@localhost", "ada", "ada@example", "@example.com"]) {
      expect(() =>
        parseCreateRegistrationRequest({ ...validRegistrationBody(), email }),
      ).toThrow(ValidationError);
    }
  });

  it("accepts an address whose domain has several labels", () => {
    const command = parseCreateRegistrationRequest({
      ...validRegistrationBody(),
      email: "ada.lovelace@mail.example.co.uk",
    });

    expect(command.attendeeEmail).toBe("ada.lovelace@mail.example.co.uk");
  });

  it("refuses an over-long attendee name rather than truncating it", () => {
    // Truncation would produce two attendees who are indistinguishable at the door.
    expect(() =>
      parseCreateRegistrationRequest({ ...validRegistrationBody(), attendee_name: "A".repeat(121) }),
    ).toThrow(ValidationError);
  });

  it("refuses an absurdly long phone number", () => {
    expect(() =>
      parseCreateRegistrationRequest({ ...validRegistrationBody(), phone: "+".repeat(65) }),
    ).toThrow(ValidationError);
  });

  it("imposes no format on a phone number beyond being a non-blank string", () => {
    // §11 says "required" and nothing else. Inventing a rule here would silently
    // exclude attendees in the markets this product is for, so the absence of one is
    // recorded as an open item instead.
    for (const phone of ["08012345678", "+2348012345678", "0801 234 5678", "2348012345678"]) {
      expect(parseCreateRegistrationRequest({ ...validRegistrationBody(), phone }).attendeePhone).toBe(phone);
    }
  });

  it("refuses a body that is not an object at all", () => {
    for (const body of [null, undefined, "attendee", 42, ["attendee_name"]]) {
      expect(() => parseCreateRegistrationRequest(body)).toThrow(ValidationError);
    }
  });
});

describe("POST /payments/initiate", () => {
  it("reads the single field §12 names", () => {
    expect(parseInitiatePaymentRequest({ registration_id: REGISTRATION_ID })).toEqual({
      registrationId: REGISTRATION_ID,
    });
  });

  it("REFUSES a unique_reference, which is FR-15's factor and not a purchase handle", () => {
    // Accepting the door reference here would let anyone who guesses it pay through
    // someone else's registration.
    expect(() =>
      parseInitiatePaymentRequest({ unique_reference: "aGVsbG8gd29ybGQ" }),
    ).toThrow(ValidationError);
  });

  it("refuses a non-UUID registration id", () => {
    expect(() => parseInitiatePaymentRequest({ registration_id: "reg_1" })).toThrow(ValidationError);
  });

  it("refuses an empty body rather than treating it as a missing route parameter", () => {
    expect(() => parseInitiatePaymentRequest({})).toThrow(ValidationError);
  });
});

describe("POST /payments/verify: the field name and its type", () => {
  it("accepts provider_reference", () => {
    expect(parseVerifyPaymentBodyRequest({ provider_reference: PROVIDER_REFERENCE })).toEqual({
      providerReference: PROVIDER_REFERENCE,
    });
  });

  it("accepts tx_ref as the provider's own spelling of the same value", () => {
    expect(parseVerifyPaymentBodyRequest({ tx_ref: PROVIDER_REFERENCE })).toEqual({
      providerReference: PROVIDER_REFERENCE,
    });
  });

  it("requires the two spellings to agree when both are sent", () => {
    // Picking one for a caller that sent two would be a guess about money.
    expect(() =>
      parseVerifyPaymentBodyRequest({
        provider_reference: PROVIDER_REFERENCE,
        tx_ref: "rsv_somethingElse",
      }),
    ).toThrow(ValidationError);
  });

  it("accepts the two spellings when they agree after trimming", () => {
    expect(
      parseVerifyPaymentBodyRequest({
        provider_reference: ` ${PROVIDER_REFERENCE} `,
        tx_ref: PROVIDER_REFERENCE,
      }),
    ).toEqual({ providerReference: PROVIDER_REFERENCE });
  });

  it("REFUSES a numeric reference instead of coercing it to a string", () => {
    // String(12345) is a well-formed reference. A parser that coerced would answer
    // 200 for a payment the caller never named, which is the whole purpose of
    // resolving a reference.
    try {
      parseVerifyPaymentBodyRequest({ provider_reference: 12_345 });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(issuesOf(error)["provider_reference"]?.[0]).toMatch(/string/i);
    }
  });

  it("refuses a blank or missing reference, naming the field", () => {
    for (const body of [{}, { provider_reference: "   " }]) {
      try {
        parseVerifyPaymentBodyRequest(body);
        throw new Error("expected a refusal");
      } catch (error) {
        expect(Object.keys(issuesOf(error))).toEqual(["provider_reference"]);
      }
    }
  });

  it("refuses a reference with a character that could not survive a URL", () => {
    expect(() =>
      parseVerifyPaymentBodyRequest({ provider_reference: "rsv_abc def" }),
    ).toThrow(ValidationError);
  });

  it("refuses an over-long reference rather than querying the provider with it", () => {
    expect(() =>
      parseVerifyPaymentBodyRequest({ provider_reference: "a".repeat(201) }),
    ).toThrow(ValidationError);
  });

  it("refuses unrelated fields instead of ignoring them", () => {
    expect(() =>
      parseVerifyPaymentBodyRequest({ provider_reference: PROVIDER_REFERENCE, email: "ada@example.com" }),
    ).toThrow(ValidationError);
  });
});

describe("GET /payments/verify: the redirect channel", () => {
  it("accepts the tx_ref parameter Flutterwave appends to redirect_url", () => {
    const search = new URLSearchParams({ tx_ref: PROVIDER_REFERENCE });

    expect(parseVerifyPaymentQuery(search)).toEqual({ providerReference: PROVIDER_REFERENCE });
  });

  it("accepts provider_reference as well, because §12 names that one", () => {
    const search = new URLSearchParams({ provider_reference: PROVIDER_REFERENCE });

    expect(parseVerifyPaymentQuery(search)).toEqual({ providerReference: PROVIDER_REFERENCE });
  });

  it("refuses a redirect with neither parameter, which is an incomplete callback", () => {
    expect(() => parseVerifyPaymentQuery(new URLSearchParams())).toThrow(ValidationError);
  });

  it("ignores unrelated query parameters, which a provider may append", () => {
    // A redirect URL is a URL: a host, a `utm_*` set, or a fragment may all arrive.
    // Refusing the callback over an unknown parameter would break payments for a
    // marketing reason, so the parser reads only the two names it owns. This is the
    // one place unknown input is *not* rejected, and it is limited to a query string
    // whose only job is to name one payment.
    const search = new URLSearchParams({
      tx_ref: PROVIDER_REFERENCE,
      status: "successful",
      utm_source: "email",
    });

    expect(parseVerifyPaymentQuery(search)).toEqual({ providerReference: PROVIDER_REFERENCE });
  });

  it("reports a parameter repeated twice as the disagreement it is", () => {
    const search = new URLSearchParams();
    search.append("tx_ref", PROVIDER_REFERENCE);
    search.append("tx_ref", "rsv_other");

    expect(() => parseVerifyPaymentQuery(search)).toThrow(ValidationError);
  });
});

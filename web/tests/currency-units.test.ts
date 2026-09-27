import { describe, expect, it } from "vitest";

import {
  isPricableCurrency,
  majorUnitsToMinorUnits,
  MINOR_UNITS_PER_MAJOR,
  minorUnitsToMajorUnits,
  NON_TWO_DECIMAL_CURRENCIES,
  UnrepresentableAmountError,
} from "@/domain/payments/currency-units";
import {
  generateProviderReference,
  generateUniqueReference,
  isWellFormedProviderReference,
  isWellFormedReference,
} from "@/domain/registrations/reference";
import {
  holdDeadline,
  holdHasExpired,
  holdsInventory,
  type RegistrationRecord,
} from "@/domain/registrations/registration";

/**
 * R-6 — the minor↔major unit conversion, the reference generator, and the hold
 * clock.
 *
 * These three are the pure functions the money rules run through, and each one
 * guards a mistake that is silent, expensive, or both:
 *
 *   - a unit slip charges an attendee 100× (or 1000×) the ticket price;
 *   - a weak reference lets an attacker walk other attendees' tickets;
 *   - a wrong hold boundary double-releases stock or strands it forever.
 *
 * So the conversion tests assert *exact* arithmetic at boundaries and the
 * rejection of inexact values, the reference tests assert entropy width and
 * unguessability by shape, and the hold tests use an injected `now` so the 15-minute
 * edge is tested at the minute rather than by waiting.
 */

/** A 256-bit value: what a reference must actually be, not merely look like. */
const REFERENCE_ENTROPY_BITS = 256;

describe("R-6: minor units to major units", () => {
  it("converts a whole Naira price", () => {
    // ₦5,000 stored as 500000 kobo (PRD §7.2 L212's own example) -> ₦5,000 charged.
    expect(minorUnitsToMajorUnits(500_000, "NGN")).toBe(5_000);
  });

  it("converts the smallest whole major unit", () => {
    expect(minorUnitsToMajorUnits(MINOR_UNITS_PER_MAJOR, "NGN")).toBe(1);
  });

  it("converts zero, which is a free tier the skill explicitly allows", () => {
    expect(minorUnitsToMajorUnits(0, "NGN")).toBe(0);
  });

  it("REFUSES a sub-major amount rather than rounding it away to a free ticket", () => {
    // The exact failure this rule exists for: Math.round(1 / 100) is 0, so a ₦0.01
    // price silently becomes a ₦0 charge and the attendee gets a free ticket.
    expect(() => minorUnitsToMajorUnits(1, "NGN")).toThrow(UnrepresentableAmountError);
  });

  it("refuses the value just below a whole major unit too", () => {
    expect(() => minorUnitsToMajorUnits(99, "NGN")).toThrow(UnrepresentableAmountError);
  });

  it("reports the offending amount and currency on the error", () => {
    try {
      minorUnitsToMajorUnits(150, "GBP");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(UnrepresentableAmountError);
      const refusal = error as UnrepresentableAmountError;
      expect(refusal.minorUnits).toBe(150);
      expect(refusal.currency).toBe("GBP");
    }
  });
});

describe("R-6: major units to minor units (the direction money arrives in)", () => {
  it("converts a whole Naira charge back to kobo", () => {
    expect(majorUnitsToMinorUnits(5_000, "NGN")).toBe(500_000);
  });

  it("REFUSES a fractional provider amount instead of truncating it", () => {
    // A captured payment cannot be half-confirmed. Guessing a direction would either
    // confirm a ticket for less than was paid or overstate the amount.
    expect(() => majorUnitsToMinorUnits(199.99, "NGN")).toThrow(UnrepresentableAmountError);
  });

  it("round-trips a whole major unit exactly", () => {
    for (const major of [1, 7, 5_000, 123_456]) {
      expect(minorUnitsToMajorUnits(majorUnitsToMinorUnits(major, "NGN"), "NGN")).toBe(major);
    }
  });

  it("is exactly the inverse of the outbound conversion", () => {
    // If these ever drift apart, a price confirmed at initiation would not equal
    // the same price read back at verification, and every payment would be flagged
    // for reconciliation.
    const stored = 250_000;
    const outbound = minorUnitsToMajorUnits(stored, "NGN");
    expect(majorUnitsToMinorUnits(outbound, "NGN")).toBe(stored);
  });
});

describe("R-6: the currencies this platform declines to price", () => {
  it("prices the major two-decimal markets", () => {
    for (const currency of ["NGN", "USD", "GBP", "EUR", "GHS", "ZAR", "KES", "CAD", "AUD"]) {
      expect(isPricableCurrency(currency)).toBe(true);
    }
  });

  it("refuses the zero-decimal currencies, where a divisor of 100 would be 100x wrong", () => {
    for (const currency of ["JPY", "KRW", "VND", "CLP", "ISK", "XOF", "XAF", "RWF", "UGX"]) {
      expect(NON_TWO_DECIMAL_CURRENCIES.has(currency)).toBe(true);
      expect(isPricableCurrency(currency)).toBe(false);
    }
  });

  it("refuses the three-decimal currencies", () => {
    for (const currency of ["KWD", "BHD", "OMR", "JOD", "TND", "IQD", "LYD"]) {
      expect(NON_TWO_DECIMAL_CURRENCIES.has(currency)).toBe(true);
      expect(isPricableCurrency(currency)).toBe(false);
    }
  });

  it("is case-insensitive, since a currency code is a label a human types", () => {
    expect(isPricableCurrency("jpy")).toBe(false);
    expect(isPricableCurrency("nGn")).toBe(true);
    expect(isPricableCurrency("  JPY  ")).toBe(false);
  });

  it("is a strict superset of the non-2-decimal codes, not a market allow-list", () => {
    // The list is defensive: its job is to block mispricing, so it must never
    // contain a 2-decimal currency. This asserts the property that makes it safe to
    // extend by hand.
    const twoDecimal = ["NGN", "USD", "GBP", "EUR", "ZAR", "INR", "BRL", "MXN", "CHF", "SEK"];
    for (const currency of twoDecimal) {
      expect(NON_TWO_DECIMAL_CURRENCIES.has(currency)).toBe(false);
    }
  });
});

describe("FR-10a: reference generation", () => {
  it("produces a reference carrying the full 256 bits", () => {
    // base64url of 32 bytes: ceil(256 / 6) = 43 characters. Both numbers are derived
    // from the bit width so the assertion cannot drift from the requirement it
    // exists to enforce.
    const reference = generateUniqueReference();

    expect(reference).toHaveLength(Math.ceil(REFERENCE_ENTROPY_BITS / 6));
    expect(Buffer.from(reference, "base64url")).toHaveLength(REFERENCE_ENTROPY_BITS / 8);
  });

  it("is recognisable by shape, which is what the evidence endpoint filters on", () => {
    expect(isWellFormedReference(generateUniqueReference())).toBe(true);
  });

  it("never repeats across many draws", () => {
    // A collision here would silently hand one attendee another's reference. 512
    // draws is a cheap guard against a broken generator (a constant, a seed, a
    // truncated random) that would otherwise pass a single-assertion test.
    const drawn = new Set(Array.from({ length: 512 }, generateUniqueReference));
    expect(drawn.size).toBe(512);
  });

  it("uses the URL-safe alphabet, so it needs no escaping in a URL or a log", () => {
    for (let n = 0; n < 64; n += 1) {
      expect(generateUniqueReference()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("prefixes the provider reference so our transactions are identifiable", () => {
    const providerReference = generateProviderReference();
    expect(providerReference.startsWith("rsv_")).toBe(true);
    expect(isWellFormedProviderReference(providerReference)).toBe(true);
  });

  it("does not let an attendee reference pass as a provider reference", () => {
    // The two are separate lookup keys; conflating them would let a quote of one
    // resolve the other.
    expect(isWellFormedProviderReference(generateUniqueReference())).toBe(false);
  });

  it("rejects a short or wrongly-shaped string before it reaches the database", () => {
    expect(isWellFormedReference("short")).toBe(false);
    expect(isWellFormedReference("a".repeat(39))).toBe(false);
    expect(isWellFormedReference(`${"a".repeat(42)}!`)).toBe(false);
  });
});

describe("BR-3: the 15-minute hold window", () => {
  const HELD_AT = new Date("2026-09-27T12:00:00.000Z");

  function registrationWithStatus(status: RegistrationRecord["status"]): RegistrationRecord {
    return {
      id: "11111111-1111-4111-8111-111111111111",
      eventId: "22222222-2222-4222-8222-222222222222",
      ticketTypeId: "33333333-3333-4333-8333-333333333333",
      uniqueReference: generateUniqueReference(),
      attendeeName: "Ada Lovelace",
      attendeeEmail: "ada@example.com",
      attendeePhone: "+2348012345678",
      status,
      idempotencyKey: "44444444-4444-4444-8444-444444444444",
      createdAt: HELD_AT,
      updatedAt: HELD_AT,
    };
  }

  it("reports the deadline 15 minutes after the hold was taken", () => {
    expect(holdDeadline(registrationWithStatus("pending_payment")).toISOString()).toBe(
      "2026-09-27T12:15:00.000Z",
    );
  });

  it("is NOT expired one second before the window closes", () => {
    const registration = registrationWithStatus("pending_payment");
    expect(holdHasExpired(registration, new Date("2026-09-27T12:14:59.000Z"))).toBe(false);
  });

  it("IS expired exactly at the window boundary", () => {
    // >= not >: a hold taken at 12:00:00.000 is gone at 12:15:00.000, and an
    // off-by-one here either honours a lapsed hold or releases a live one.
    const registration = registrationWithStatus("pending_payment");
    expect(holdHasExpired(registration, new Date("2026-09-27T12:15:00.000Z"))).toBe(true);
  });

  it("is expired well after the window", () => {
    const registration = registrationWithStatus("pending_payment");
    expect(holdHasExpired(registration, new Date("2026-09-27T13:00:00.000Z"))).toBe(true);
  });

  it("holds inventory only while pending payment", () => {
    // The rule that stops a double release: a confirmed registration's hold has
    // already been consumed by HELD -> CONFIRMED, so releasing it again would
    // return stock that is already sold.
    expect(holdsInventory("pending_payment")).toBe(true);
    expect(holdsInventory("confirmed")).toBe(false);
    expect(holdsInventory("checked_in")).toBe(false);
    expect(holdsInventory("cancelled")).toBe(false);
    expect(holdsInventory("refunded")).toBe(false);
  });
});

describe("R-6 and FR-10a together: the boundary they protect", () => {
  it("never lets a stored price reach the provider unconverted", () => {
    // A single end-to-end shape of the mistake the two rules exist to prevent:
    // the stored minor-unit price being sent straight through.
    const storedPriceMinorUnits = 5_000; // ₦50.00
    const charged = minorUnitsToMajorUnits(storedPriceMinorUnits, "NGN");

    expect(charged).toBe(50);
    // Sending `storedPriceMinorUnits` verbatim would have charged ₦5,000 for a
    // ₦50 ticket; sending `charged` charges ₦50.
    expect(charged).not.toBe(storedPriceMinorUnits);
  });
});

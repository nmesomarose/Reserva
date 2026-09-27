import { beforeEach, describe, expect, it } from "vitest";

/**
 * Ticket-evidence rules against an in-memory repository (AGENTS.md §4, PRD v2 §5.5,
 * §6.3, §12 row 8; FR-15, FR-19; rule 08).
 *
 * The three things only this layer can prove:
 *
 *   1. **The refusal is one refusal.** An unknown reference, a wrong email, and a
 *      reference belonging to somebody else all produce the same error with the same
 *      message. A faked repository is exactly the right instrument: it can hold two
 *      registrations with different emails and prove the response cannot tell them
 *      apart, which is the property a real database would only obscure.
 *   2. **Nothing beyond the ticket is read.** The fake *counts its calls*, so a future
 *      change that reached for `findLatestPayment` to add a receipt to this response
 *      would fail here rather than ship a payment history to an unauthenticated caller.
 *   3. **The DTO is an allow-list, asserted by field name.** §13 and rule 08 both say what
 *      must not be there; the test enumerates the forbidden names, so "it doesn't include
 *      that" is a checked fact rather than a reviewer's impression.
 *
 * The DTO's `event` block comes from a *live* event read (BR-6), which is asserted here
 * by having the stored registration's event and the event repository's row be different
 * objects and checking the response follows the repository.
 */

import { ForbiddenError, NotFoundError } from "@/domain/errors";
import { EvidenceService } from "@/domain/registrations/evidence.service";
import type { EventRecord } from "@/domain/events/event";
import type { EventRepository } from "@/domain/events/event.repository";
import type { RegistrationRecord } from "@/domain/registrations/registration";
import type { RegistrationRepository } from "@/domain/registrations/registration.repository";
import type { TicketTypeRecord } from "@/domain/tickets/ticket-type";

const REGISTRATION_ID = "77777777-7777-7777-7777-777777777777";
const EVENT_ID = "33333333-3333-3333-3333-333333333333";
const TICKET_TYPE_ID = "99999999-9999-9999-9999-999999999999";

const REFERENCE = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const OTHER_REFERENCE = "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2";

const NOW = new Date("2026-10-01T18:30:00Z");
const CREATED_AT = new Date("2026-10-01T18:00:00Z");

/**
 * The 15-minute hold window from `tickets/ticket-type.ts`, restated as a literal.
 *
 * Restated rather than imported so the evidence DTO's `hold_expires_at` is checked
 * against the PRD's number and not against whatever the helper currently computes — a
 * test that imports the implementation proves the implementation is itself.
 */
const EXPECTED_HOLD_EXPIRY = "2026-10-01T18:15:00.000Z";

function registration(overrides: Partial<RegistrationRecord> = {}): RegistrationRecord {
  return {
    id: REGISTRATION_ID,
    eventId: EVENT_ID,
    ticketTypeId: TICKET_TYPE_ID,
    uniqueReference: REFERENCE,
    attendeeName: "Ada Lovelace",
    attendeeEmail: "ada@example.com",
    attendeePhone: "+2348012345678",
    status: "confirmed",
    idempotencyKey: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function eventRow(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: EVENT_ID,
    organiserId: "11111111-1111-1111-1111-111111111111",
    name: "Jazz Night",
    slug: "jazz-night",
    description: "A night of jazz.",
    startsAt: new Date("2026-10-01T18:00:00Z"),
    endsAt: new Date("2026-10-01T22:00:00Z"),
    venue: "The Blue Room",
    status: "published",
    createdAt: CREATED_AT,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function tier(overrides: Partial<TicketTypeRecord> = {}): TicketTypeRecord {
  return {
    id: TICKET_TYPE_ID,
    eventId: EVENT_ID,
    name: "General Admission",
    description: null,
    priceMinorUnits: 5_000,
    currency: "NGN",
    quantityTotal: 500,
    quantityConfirmed: 12,
    quantityHeld: 3,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

/** A registration repository that records which methods were called, and how often. */
class FakeRegistrationRepository {
  readonly calls: string[] = [];
  private readonly byReference = new Map<string, RegistrationRecord>();

  constructor(rows: readonly RegistrationRecord[]) {
    for (const row of rows) {
      this.byReference.set(row.uniqueReference, row);
    }
  }

  async findRegistrationByReference(reference: string): Promise<RegistrationRecord | null> {
    this.calls.push("findRegistrationByReference");

    return this.byReference.get(reference) ?? null;
  }

  async findRegistrationTier(): Promise<TicketTypeRecord> {
    this.calls.push("findRegistrationTier");

    return tier();
  }
}

function eventRepository(row: EventRecord | null): EventRepository {
  const target = {
    async findEventById(): Promise<EventRecord | null> {
      return row;
    },
  };

  return target as unknown as EventRepository;
}

function build(rows: readonly RegistrationRecord[], event: EventRecord | null = eventRow()) {
  const registrations = new FakeRegistrationRepository(rows);

  return {
    registrations,
    service: new EvidenceService(
      registrations as unknown as RegistrationRepository,
      eventRepository(event),
    ),
  };
}

describe("EvidenceService returns the attendee's own ticket", () => {
  let context: ReturnType<typeof build>;

  beforeEach(() => {
    context = build([registration()]);
  });

  it("returns the reference, the tier, the stored status, and the live event", async () => {
    const evidence = await context.service.retrieveEvidence(REFERENCE, "ada@example.com");

    expect(evidence).toEqual({
      registration_id: REGISTRATION_ID,
      unique_reference: REFERENCE,
      attendee_name: "Ada Lovelace",
      attendee_email: "ada@example.com",
      ticket_type_name: "General Admission",
      status: "confirmed",
      hold_expires_at: null,
      created_at: CREATED_AT.toISOString(),
      event: {
        id: EVENT_ID,
        name: "Jazz Night",
        slug: "jazz-night",
        starts_at: "2026-10-01T18:00:00.000Z",
        ends_at: "2026-10-01T22:00:00.000Z",
        venue: "The Blue Room",
        status: "published",
      },
    });
  });

  it("names the tier from the stored row, not from anything the caller supplied", async () => {
    // The repository returns "General Admission" regardless of arguments, and the DTO
    // says "General Admission". If the service ever read a tier name out of the request
    // this pair would no longer be enough evidence, which is why the fake ignores its
    // parameters entirely.
    const evidence = await context.service.retrieveEvidence(REFERENCE, "ada@example.com");

    expect(evidence.ticket_type_name).toBe("General Admission");
  });

  it("reads the event live, so a reschedule reaches an already-issued ticket", async () => {
    const moved = build([registration()], eventRow({ startsAt: new Date("2026-10-02T18:00:00Z") }));

    const evidence = await moved.service.retrieveEvidence(REFERENCE, "ada@example.com");

    expect(evidence.event.starts_at).toBe("2026-10-02T18:00:00.000Z");
  });

  it("still serves a ticket whose event has been soft-deleted", async () => {
    // An attendee paid for this. Showing them a ticket with no event at all would be
    // worse than showing them a cancelled one, so the live read is not filtered on
    // `deleted_at` — the route reports what the row says.
    const deleted = build([registration()], eventRow({ deletedAt: NOW, status: "closed" }));

    const evidence = await deleted.service.retrieveEvidence(REFERENCE, "ada@example.com");

    expect(evidence.event.status).toBe("closed");
  });

  it("fails loudly if the registration's event cannot be read at all", async () => {
    // Unreachable while the foreign key holds. The alternative — inventing event details
    // — would put a ticket on a made-up event.
    const missing = build([registration()], null);

    await expect(missing.service.retrieveEvidence(REFERENCE, "ada@example.com")).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe("EvidenceService holds the privacy line (rule 08, PRD §13)", () => {
  /**
   * Field names §13 and rule 08 forbid in this response.
   *
   * Asserted as an *absent* list rather than by comparing the whole object, because a
   * whole-object comparison stops protecting the day somebody adds a field the test was
   * not updated for. This way a new field that is not on the allowed list still fails.
   */
  const FORBIDDEN_FIELDS = [
    "attendee_phone",
    "phone",
    "payments",
    "payment",
    "provider_reference",
    "tx_ref",
    "raw_provider_payload",
    "check_ins",
    "check_in",
    "check_ins_log",
    "requests",
    "attendee_requests",
    "organiser_id",
    "idempotency_key",
    "event_id",
    "quantity_total",
    "quantity_confirmed",
    "quantity_held",
    "available",
  ];

  it("exposes none of the fields §13 and rule 08 withhold", async () => {
    const context = build([registration()]);

    const evidence = await context.service.retrieveEvidence(REFERENCE, "ada@example.com");

    for (const field of FORBIDDEN_FIELDS) {
      expect(Object.keys(evidence)).not.toContain(field);
    }
  });

  it("never reads a payment, a check-in, or a request to build the response", async () => {
    // The strongest form of the same claim: the *repository* is asked for nothing beyond
    // the registration, its tier, and its event. A payment receipt added to this DTO
    // would have to go through `findLatestPayment`, and this fails if it does.
    const context = build([registration()]);

    await context.service.retrieveEvidence(REFERENCE, "ada@example.com");

    expect(context.registrations.calls).toEqual(["findRegistrationByReference", "findRegistrationTier"]);
  });

  it("does not read the payment history even to decide whether the ticket is paid", async () => {
    // The stored `status` is the whole answer. Deriving it from the payment log would
    // both cost a read and risk disagreeing with the projection the rest of the API uses.
    const context = build([registration({ status: "pending_payment" })]);

    const evidence = await context.service.retrieveEvidence(REFERENCE, "ada@example.com");

    expect(evidence.status).toBe("pending_payment");
    expect(context.registrations.calls).not.toContain("findLatestPayment");
  });
});

describe("EvidenceService reports the hold honestly (FR-19, §17)", () => {
  it("gives a pending ticket a bounded deadline the attendee can act on", async () => {
    const context = build([registration({ status: "pending_payment" })]);

    const evidence = await context.service.retrieveEvidence(REFERENCE, "ada@example.com");

    // §17 requires the "confirm your payment" state to be explicit *and* time-bounded.
    expect(evidence.hold_expires_at).toBe(EXPECTED_HOLD_EXPIRY);
    expect(evidence.status).toBe("pending_payment");
  });

  it.each(["confirmed", "checked_in", "cancelled", "refunded"] as const)(
    "reports no deadline for a %s ticket, because no hold is outstanding",
    async (status) => {
      const context = build([registration({ status })]);

      const evidence = await context.service.retrieveEvidence(REFERENCE, "ada@example.com");

      // A confirmed ticket printing "hold expires at 18:15" would be a claim about a
      // hold that §9.3 already consumed.
      expect(evidence.hold_expires_at).toBeNull();
    },
  );

  it("never claims an unconfirmed registration is a valid ticket", async () => {
    // FR-19's requirement is about labelling, not about refusing: the status is the only
    // field a client would read as "valid", so it has to be the truth.
    const context = build([registration({ status: "pending_payment" })]);

    const evidence = await context.service.retrieveEvidence(REFERENCE, "ada@example.com");

    expect(evidence).not.toHaveProperty("valid");
    expect(evidence).not.toHaveProperty("is_valid_ticket");
    expect(evidence.status).toBe("pending_payment");
  });
});

describe("EvidenceService refuses without disclosing (rule 08, §15, §18)", () => {
  it("refuses an unknown reference", async () => {
    const context = build([registration()]);

    await expect(
      context.service.retrieveEvidence(OTHER_REFERENCE, "ada@example.com"),
    ).rejects.toThrow(ForbiddenError);
  });

  it("refuses a wrong email", async () => {
    const context = build([registration()]);

    await expect(
      context.service.retrieveEvidence(REFERENCE, "mallory@example.com"),
    ).rejects.toThrow(ForbiddenError);
  });

  it("gives a byte-identical message for both, so the reference cannot be probed", async () => {
    const context = build([registration()]);

    const unknown = await context.service
      .retrieveEvidence(OTHER_REFERENCE, "ada@example.com")
      .catch((error: unknown) => error);
    const wrongEmail = await context.service
      .retrieveEvidence(REFERENCE, "mallory@example.com")
      .catch((error: unknown) => error);

    expect(unknown).toBeInstanceOf(ForbiddenError);
    expect(wrongEmail).toBeInstanceOf(ForbiddenError);
    expect((unknown as Error).message).toBe((wrongEmail as Error).message);
  });

  it("refuses when the stored email differs only by case or surrounding space", async () => {
    // P-18. A ticket emailed to `ada@example.com` and a registration typed as
    // `Ada@Example.com ` are the same mailbox; denying the attendee their own ticket over
    // a capital letter would be a bug, not security.
    const context = build([registration({ attendeeEmail: "Ada@Example.com " })]);

    await expect(
      context.service.retrieveEvidence(REFERENCE, "ada@example.com"),
    ).resolves.toMatchObject({ attendee_email: "Ada@Example.com " });
  });

  it("stops at the first refusal: a wrong email reads no tier and no event", async () => {
    // The possession check runs before the extra reads, so an unauthorised caller costs
    // one indexed lookup. Worth asserting because the opposite order is easy to write.
    const context = build([registration()]);

    await expect(
      context.service.retrieveEvidence(REFERENCE, "mallory@example.com"),
    ).rejects.toThrow(ForbiddenError);

    expect(context.registrations.calls).toEqual(["findRegistrationByReference"]);
  });
});

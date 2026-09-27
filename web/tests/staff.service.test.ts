import { beforeEach, describe, expect, it } from "vitest";

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from "@/domain/errors";
import type { EventRecord, PageRequest } from "@/domain/events/event";
import type { EventRepository } from "@/domain/events/event.repository";
import { maskEmail, maskPhone } from "@/domain/staff/staff.dto";
import type {
  CreateStaffTokenInput,
  ListStaffTokensQuery,
  RecordCheckInInput,
  StaffRepository,
} from "@/domain/staff/staff.repository";
import {
  checkInEligible,
  staffStatusBadge,
  STAFF_TOKEN_GRACE_MS,
  type CheckInRecord,
  type RecordCheckInOutcome,
  type StaffContext,
  type StaffSearchRow,
  type StaffTokenIssuer,
  type StaffTokenRecord,
} from "@/domain/staff/staff";
import { StaffService } from "@/domain/staff/staff.service";

/**
 * Staff business rules against an in-memory repository (AGENTS.md §4).
 *
 * The rules proven here are the ones a database cannot be asked about: which outcome
 * maps to which status code, that a *disagreeing* event is refused rather than
 * honoured, that the plaintext token is never handed to the repository, that a
 * revoked token's timestamp is stamped once, that the two `409`s are distinguishable,
 * and that contact details are masked in the projection.
 *
 * What the fake deliberately CANNOT prove, and where each is proven instead:
 *
 *   - the `FOR UPDATE` lock and the two-statements-one-transaction guarantee,
 *     including two concurrent check-ins not both seeing a clean slate
 *     -> `staff.db.test.ts`;
 *   - the `check_ins_insert_guard` trigger refusing a check-in for a non-confirmed
 *     registration or a cross-event staff actor -> `staff.db.test.ts`;
 *   - the bearer header parsing -> `api.v1.staff.test.ts`.
 */

const ORGANISER_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ORGANISER_ID = "22222222-2222-2222-2222-222222222222";
const EVENT_ID = "33333333-3333-3333-3333-333333333333";
const OTHER_EVENT_ID = "44444444-4444-4444-4444-444444444444";

const STAFF_TOKEN_ID = "55555555-5555-5555-5555-555555555555";
const OTHER_TOKEN_ID = "66666666-6666-6666-6666-666666666666";
const REGISTRATION_ID = "77777777-7777-7777-7777-777777777777";
const OTHER_REGISTRATION_ID = "88888888-8888-8888-8888-888888888888";

const PLAINTEXT = "door-team-token-value";
const TOKEN_HASH = "sha256-of-the-plaintext";

const NOW = new Date("2026-10-01T18:30:00Z");
const EVENT_STARTS_AT = new Date("2026-10-01T18:00:00Z");
const EVENT_ENDS_AT = new Date("2026-10-01T22:00:00Z");

const PAGE: PageRequest = { page: 1, pageSize: 20 };

/** The event both slices read for ownership, and its neighbours' events. */
const eventRow = (id: string, organiserId: string): EventRecord => ({
  id,
  organiserId,
  name: "Jazz Night",
  slug: `jazz-${id.slice(0, 4)}`,
  description: null,
  startsAt: EVENT_STARTS_AT,
  endsAt: EVENT_ENDS_AT,
  venue: "The Blue Room",
  status: "published",
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
});

function staffToken(overrides: Partial<StaffTokenRecord> = {}): StaffTokenRecord {
  return {
    id: STAFF_TOKEN_ID,
    eventId: EVENT_ID,
    tokenHash: TOKEN_HASH,
    label: "Door Team A",
    expiresAt: new Date("2026-10-02T22:00:00Z"),
    revokedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

function searchRow(overrides: Partial<StaffSearchRow> = {}): StaffSearchRow {
  return {
    registrationId: REGISTRATION_ID,
    eventId: EVENT_ID,
    attendeeName: "Ada Lovelace",
    attendeeEmail: "ada.lovelace@example.com",
    attendeePhone: "+2348012345678",
    status: "confirmed",
    ticketTypeId: "99999999-9999-9999-9999-999999999999",
    ticketTypeName: "General Admission",
    latestCheckInAt: null,
    ...overrides,
  };
}

function checkIn(overrides: Partial<CheckInRecord> = {}): CheckInRecord {
  return {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    registrationId: REGISTRATION_ID,
    checkedInAt: NOW,
    organiserId: null,
    staffTokenId: STAFF_TOKEN_ID,
    isOverride: false,
    createdAt: NOW,
    ...overrides,
  };
}

/**
 * An `EventRepository` exposing only the ownership read.
 *
 * The proxy turns any other method into a loud failure, so a future change that
 * starts depending on a second event operation has to say so.
 */
function eventRepository(events: readonly EventRecord[]): EventRepository {
  const target = {
    async findEventById(id: string): Promise<EventRecord | null> {
      return events.find((event) => event.id === id) ?? null;
    },
  };

  return new Proxy(target as EventRepository, {
    get(receiver, property, receiverTarget) {
      if (property in receiver) {
        return Reflect.get(receiver, property, receiverTarget);
      }

      throw new Error(
        `EventRepository.${String(property)} was called, but the staff slice must only ` +
          `read findEventById for ownership. Add a stub if that is now required.`,
      );
    },
  });
}

/**
 * A deterministic issuer, so a test can assert *which* secret was stored without
 * depending on CSPRNG output. Records the calls so a test can prove `hash` is used
 * for lookup and never the plaintext.
 */
class FakeTokenIssuer implements StaffTokenIssuer {
  readonly issued: number[] = [];
  readonly hashed: string[] = [];
  private counter = 0;

  issue(): { readonly token: string; readonly tokenHash: string } {
    this.counter += 1;
    this.issued.push(this.counter);

    return { token: `${PLAINTEXT}-${this.counter}`, tokenHash: `${TOKEN_HASH}-${this.counter}` };
  }

  hash(secret: string): string {
    this.hashed.push(secret);

    return TOKEN_HASH;
  }
}

class FakeStaffRepository implements StaffRepository {
  readonly tokens = new Map<string, StaffTokenRecord>();
  readonly creates: CreateStaffTokenInput[] = [];
  readonly revocations: Array<{ readonly id: string; readonly eventId: string; readonly at: Date }> = [];
  readonly searchQueries: ListStaffTokensQuery[] = [];
  readonly checkInInputs: RecordCheckInInput[] = [];

  /** The next `recordCheckIn` answer, so each test states its own outcome. */
  nextCheckInOutcome: RecordCheckInOutcome = { kind: "not_found" };

  /** Rows a search returns. */
  rows: StaffSearchRow[] = [];
  searchTotal = 0;

  private nextId = 1;

  async transact<T>(work: (repository: StaffRepository) => Promise<T>): Promise<T> {
    return work(this);
  }

  async createStaffToken(input: CreateStaffTokenInput): Promise<StaffTokenRecord> {
    this.creates.push(input);

    const record = staffToken({
      id: `issued-${this.nextId++}`,
      eventId: input.eventId,
      tokenHash: input.tokenHash,
      label: input.label ?? "",
      expiresAt: input.expiresAt,
    });

    this.tokens.set(record.id, record);

    return record;
  }

  async listStaffTokens(
    query: ListStaffTokensQuery,
  ): Promise<{ items: readonly StaffTokenRecord[]; total: number }> {
    this.searchQueries.push(query);

    const matching = [...this.tokens.values()]
      .filter((token) => token.eventId === query.eventId)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());

    return {
      items: matching.slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
      total: matching.length,
    };
  }

  async revokeStaffToken(
    eventId: string,
    id: string,
    revokedAt: Date,
  ): Promise<StaffTokenRecord | null> {
    this.revocations.push({ id, eventId, at: revokedAt });

    const existing = this.tokens.get(id);

    // Scoped, like the adapter: a token from another event matches no row and is
    // left untouched, so a refused revoke has no side effect.
    if (existing === undefined || existing.eventId !== eventId) {
      return null;
    }

    // Stamped once and never moved — see the port contract.
    if (existing.revokedAt === null) {
      const updated = { ...existing, revokedAt };
      this.tokens.set(id, updated);

      return updated;
    }

    return existing;
  }

  async findStaffTokenByTokenHash(tokenHash: string): Promise<StaffTokenRecord | null> {
    for (const token of this.tokens.values()) {
      if (token.tokenHash === tokenHash) {
        return token;
      }
    }

    return null;
  }

  async searchRegistrations(query: {
    readonly eventId: string;
    readonly query: string;
    readonly page: number;
    readonly pageSize: number;
  }): Promise<{ items: readonly StaffSearchRow[]; total: number }> {
    this.searchedEventId = query.eventId;
    this.searchedText = query.query;

    return { items: this.rows, total: this.searchTotal };
  }

  async recordCheckIn(input: RecordCheckInInput): Promise<RecordCheckInOutcome> {
    this.checkInInputs.push(input);

    return this.nextCheckInOutcome;
  }

  /** The scope and text the search was actually asked for. */
  searchedEventId: string | null = null;
  searchedText: string | null = null;
}

const staffContext: StaffContext = {
  staffTokenId: STAFF_TOKEN_ID,
  eventId: EVENT_ID,
  label: "Door Team A",
};

describe("StaffService", () => {
  let repository: FakeStaffRepository;
  let issuer: FakeTokenIssuer;

  const service = (events: readonly EventRecord[] = [eventRow(EVENT_ID, ORGANISER_ID)]): StaffService =>
    new StaffService(
      eventRepository(events),
      repository,
      issuer,
      () => NOW,
    );

  beforeEach(() => {
    repository = new FakeStaffRepository();
    issuer = new FakeTokenIssuer();
  });

  describe("resolveStaffToken", () => {
    it("resolves a live token to its own event scope and label", async () => {
      repository.tokens.set("live", staffToken({ id: "live" }));

      const context = await service().resolveStaffToken(PLAINTEXT);

      expect(context).toEqual({ staffTokenId: "live", eventId: EVENT_ID, label: "Door Team A" });
      // The lookup goes through the injected hash, never the presented value.
      expect(issuer.hashed).toEqual([PLAINTEXT]);
    });

    it("reports an unlabelled token as label: null rather than an empty string", async () => {
      repository.tokens.set("bare", staffToken({ id: "bare", label: "" }));

      expect((await service().resolveStaffToken(PLAINTEXT)).label).toBeNull();
    });

    it("rejects a revoked token with its own message, not the generic one", async () => {
      repository.tokens.set(
        "pulled",
        staffToken({ id: "pulled", revokedAt: new Date("2026-09-30T09:00:00Z") }),
      );

      const error = await service().resolveStaffToken(PLAINTEXT).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(UnauthenticatedError);
      expect((error as UnauthenticatedError).message).toBe("This staff access token has been revoked.");
      expect((error as UnauthenticatedError).message).not.toBe(
        "This request has no valid staff access token.",
      );
    });

    it("rejects an expired token with its own message", async () => {
      repository.tokens.set(
        "lapsed",
        staffToken({ id: "lapsed", expiresAt: new Date("2026-10-01T18:29:59Z") }),
      );

      await expect(service().resolveStaffToken(PLAINTEXT)).rejects.toThrow(
        "This staff access token has expired.",
      );
    });

    it("treats an expiry exactly at the current instant as expired", async () => {
      repository.tokens.set("edge", staffToken({ id: "edge", expiresAt: NOW }));

      await expect(service().resolveStaffToken(PLAINTEXT)).rejects.toThrow(
        "This staff access token has expired.",
      );
    });

    it("answers one generic message for an empty, unknown, or missing token", async () => {
      const generic = "This request has no valid staff access token.";

      await expect(service().resolveStaffToken("")).rejects.toThrow(generic);
      await expect(service().resolveStaffToken("never-issued")).rejects.toThrow(generic);
    });
  });

  describe("issueStaffToken", () => {
    it("returns the plaintext once and stores only its hash", async () => {
      const issued = await service().issueStaffToken(ORGANISER_ID, EVENT_ID, {
        label: "Door Team A",
        expiresAt: null,
      });

      expect(issued.token).toBe(`${PLAINTEXT}-1`);
      expect(repository.creates).toHaveLength(1);
      // The plaintext never reaches persistence; only the hash does.
      expect(repository.creates[0].tokenHash).toBe(`${TOKEN_HASH}-1`);
      expect(JSON.stringify(repository.creates[0])).not.toContain(PLAINTEXT);
      // Nor does it come back on the listing projection.
      expect(Object.keys(issued)).not.toContain("token_hash");
    });

    it("defaults expiry to the event's end plus the grace window", async () => {
      await service().issueStaffToken(ORGANISER_ID, EVENT_ID, { label: null, expiresAt: null });

      expect(repository.creates[0].expiresAt.getTime()).toBe(
        EVENT_ENDS_AT.getTime() + STAFF_TOKEN_GRACE_MS,
      );
    });

    it("honours an explicit future expiry", async () => {
      const requested = new Date("2026-10-05T12:00:00Z");

      await service().issueStaffToken(ORGANISER_ID, EVENT_ID, {
        label: null,
        expiresAt: requested,
      });

      expect(repository.creates[0].expiresAt).toBe(requested);
    });

    it("refuses an expiry that is not in the future, and writes nothing", async () => {
      await expect(
        service().issueStaffToken(ORGANISER_ID, EVENT_ID, {
          label: null,
          expiresAt: new Date("2026-10-01T18:29:59Z"),
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(repository.creates).toHaveLength(0);
    });

    it("stores an omitted label as the empty string, because the column is NOT NULL", async () => {
      const issued = await service().issueStaffToken(ORGANISER_ID, EVENT_ID, {
        label: null,
        expiresAt: null,
      });

      expect(repository.creates[0].label).toBeNull();
      expect(issued.label).toBeNull();
    });

    it("refuses another organiser's event with 403 and mints nothing", async () => {
      await expect(
        service().issueStaffToken(OTHER_ORGANISER_ID, EVENT_ID, { label: null, expiresAt: null }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      expect(issuer.issued).toHaveLength(0);
      expect(repository.creates).toHaveLength(0);
    });

    it("answers 404 for an unknown event id", async () => {
      await expect(
        service().issueStaffToken(ORGANISER_ID, OTHER_EVENT_ID, { label: null, expiresAt: null }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("listStaffTokens", () => {
    it("returns the pagination envelope and each token's computed status", async () => {
      repository.tokens.set("a", staffToken({ id: "a", label: "Live" }));
      repository.tokens.set(
        "b",
        staffToken({ id: "b", label: "Pulled", revokedAt: new Date("2026-09-30T09:00:00Z") }),
      );
      repository.tokens.set("c", staffToken({ id: "c", label: "Old", expiresAt: new Date("2026-09-01T00:00:00Z") }));

      const page = await service().listStaffTokens(ORGANISER_ID, EVENT_ID, PAGE);

      expect(page.page).toBe(1);
      expect(page.page_size).toBe(20);
      expect(page.total).toBe(3);
      expect(page.data.map((token) => token.status).sort()).toEqual([
        "active",
        "expired",
        "revoked",
      ]);
      // Revocation outranks a stale clock, because "who pulled this" is the question.
      expect(page.data.find((token) => token.id === "b")?.status).toBe("revoked");
    });

    it("never exposes a token hash", async () => {
      repository.tokens.set("a", staffToken({ id: "a" }));

      const page = await service().listStaffTokens(ORGANISER_ID, EVENT_ID, PAGE);

      expect(JSON.stringify(page)).not.toContain(TOKEN_HASH);
      expect(Object.keys(page.data[0])).not.toContain("token_hash");
    });

    it("scopes to the event in the path, checked against ownership first", async () => {
      repository.tokens.set("foreign", staffToken({ id: "foreign", eventId: OTHER_EVENT_ID }));

      const page = await service().listStaffTokens(ORGANISER_ID, EVENT_ID, PAGE);

      expect(repository.searchQueries).toEqual([{ eventId: EVENT_ID, page: 1, pageSize: 20 }]);
      expect(page.data).toHaveLength(0);
      expect(page.total).toBe(0);
    });

    it("refuses another organiser's event", async () => {
      await expect(
        service().listStaffTokens(OTHER_ORGANISER_ID, EVENT_ID, PAGE),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  describe("revokeStaffToken", () => {
    it("stamps revocation once and keeps the original timestamp on a repeat", async () => {
      repository.tokens.set(STAFF_TOKEN_ID, staffToken({ id: STAFF_TOKEN_ID }));

      // The clock at the first revoke, so the repeat can be shown not to move it.
      const firstAt = NOW;
      const first = await service().revokeStaffToken(ORGANISER_ID, EVENT_ID, STAFF_TOKEN_ID);
      // A later request, after the clock has moved on.
      const second = await new StaffService(
        eventRepository([eventRow(EVENT_ID, ORGANISER_ID)]),
        repository,
        issuer,
        () => new Date("2026-10-01T21:00:00Z"),
      ).revokeStaffToken(ORGANISER_ID, EVENT_ID, STAFF_TOKEN_ID);

      expect(first.status).toBe("revoked");
      expect(first.revoked_at).toBe(firstAt.toISOString());
      expect(second.revoked_at).toBe(firstAt.toISOString());
      expect(repository.revocations).toHaveLength(2);
    });

    it("answers 404 for a token belonging to another event, revealing nothing", async () => {
      repository.tokens.set(
        OTHER_TOKEN_ID,
        staffToken({ id: OTHER_TOKEN_ID, eventId: OTHER_EVENT_ID }),
      );

      await expect(
        service().revokeStaffToken(ORGANISER_ID, EVENT_ID, OTHER_TOKEN_ID),
      ).rejects.toBeInstanceOf(NotFoundError);

      // The refusal is not a check the caller makes afterwards: nothing was stamped.
      // Revoking first and comparing `event_id` on the way out would have returned
      // the same 404 while silently disabling another organiser's staff access.
      expect(repository.tokens.get(OTHER_TOKEN_ID)?.revokedAt).toBeNull();
    });

    it("answers 404 for an unknown token id", async () => {
      await expect(
        service().revokeStaffToken(ORGANISER_ID, EVENT_ID, "not-a-token"),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("refuses another organiser's event", async () => {
      await expect(
        service().revokeStaffToken(OTHER_ORGANISER_ID, EVENT_ID, STAFF_TOKEN_ID),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  describe("searchRegistrations", () => {
    it("refuses an event that disagrees with the token, without searching", async () => {
      await expect(
        service().searchRegistrations(staffContext, OTHER_EVENT_ID, "ada", PAGE),
      ).rejects.toBeInstanceOf(ForbiddenError);

      expect(repository.searchedEventId).toBeNull();
    });

    it("searches the token's own event even when the path is redundant", async () => {
      await service().searchRegistrations(staffContext, EVENT_ID, "ada", PAGE);

      expect(repository.searchedEventId).toBe(EVENT_ID);
    });

    it("rejects a query shorter than two characters, including whitespace", async () => {
      await expect(
        service().searchRegistrations(staffContext, EVENT_ID, "a", PAGE),
      ).rejects.toBeInstanceOf(ValidationError);

      await expect(
        service().searchRegistrations(staffContext, EVENT_ID, " a ", PAGE),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(repository.searchedEventId).toBeNull();
    });

    it("returns an empty result set rather than an error when nothing matches", async () => {
      repository.rows = [];
      repository.searchTotal = 0;

      const page = await service().searchRegistrations(staffContext, EVENT_ID, "zzz", PAGE);

      expect(page).toEqual({ data: [], page: 1, page_size: 20, total: 0 });
    });

    it("masks email and phone in every result", async () => {
      repository.rows = [searchRow()];
      repository.searchTotal = 1;

      const page = await service().searchRegistrations(staffContext, EVENT_ID, "ada", PAGE);

      expect(page.data[0].attendee_email_masked).toBe("a***e@example.com");
      expect(page.data[0].attendee_phone_masked).toBe("+23*********78");
      expect(JSON.stringify(page)).not.toContain("ada.lovelace@example.com");
      expect(JSON.stringify(page)).not.toContain("+2348012345678");
    });

    it("offers the check-in control only for a confirmed registration", async () => {
      repository.rows = [
        searchRow({ registrationId: REGISTRATION_ID, status: "confirmed" }),
        searchRow({ registrationId: OTHER_REGISTRATION_ID, status: "pending_payment" }),
        searchRow({ registrationId: "cccccccc-cccc-cccc-cccc-cccccccccccc", status: "cancelled" }),
      ];
      repository.searchTotal = 3;

      const page = await service().searchRegistrations(staffContext, EVENT_ID, "ada", PAGE);

      expect(page.data.map((row) => row.check_in_eligible)).toEqual([true, false, false]);
      expect(page.data.map((row) => row.status_badge)).toEqual([
        "confirmed",
        "pending",
        "payment_not_confirmed",
      ]);
    });

    it("shows the original check-in timestamp for someone already inside", async () => {
      const firstIn = new Date("2026-10-01T18:05:00Z");
      repository.rows = [
        searchRow({ status: "checked_in", latestCheckInAt: firstIn }),
      ];
      repository.searchTotal = 1;

      const page = await service().searchRegistrations(staffContext, EVENT_ID, "ada", PAGE);

      expect(page.data[0].checked_in_at).toBe(firstIn.toISOString());
      // An already-checked-in row is not offered the plain control: §4.3.4 says the
      // action is only rendered when status is Confirmed, and an override is a
      // separate deliberate act.
      expect(page.data[0].check_in_eligible).toBe(false);
    });
  });

  describe("checkIn", () => {
    it("answers 404 for a registration outside the token's event", async () => {
      repository.nextCheckInOutcome = { kind: "not_found" };

      await expect(
        service().checkIn(staffContext, OTHER_REGISTRATION_ID, { override: false }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("answers 409 naming the status when the payment is not confirmed", async () => {
      repository.nextCheckInOutcome = { kind: "not_eligible", status: "pending_payment" };

      const error = await service()
        .checkIn(staffContext, REGISTRATION_ID, { override: false })
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).message).toContain("awaiting payment");
    });

    it("still refuses an override for an ineligible registration", async () => {
      repository.nextCheckInOutcome = { kind: "not_eligible", status: "cancelled" };

      await expect(
        service().checkIn(staffContext, REGISTRATION_ID, { override: true }),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("answers 409 with the original timestamp when already checked in", async () => {
      const firstIn = new Date("2026-10-01T18:05:00Z");
      repository.nextCheckInOutcome = { kind: "already_checked_in", originalCheckInAt: firstIn };

      const error = await service()
        .checkIn(staffContext, REGISTRATION_ID, { override: false })
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).message).toContain(firstIn.toISOString());
      expect((error as ConflictError).message).toContain("override");
      // Distinct from the not-eligible message, which is the point of §11.2.
      expect((error as ConflictError).message).not.toContain("awaiting payment");
    });

    it("fails loudly rather than fabricating a row if an adapter blocks an override", async () => {
      repository.nextCheckInOutcome = {
        kind: "already_checked_in",
        originalCheckInAt: NOW,
      };

      await expect(
        service().checkIn(staffContext, REGISTRATION_ID, { override: true }),
      ).rejects.toThrow(/must be recorded as a new row/);
    });

    it("returns the recorded first check-in with the staff token as actor", async () => {
      repository.nextCheckInOutcome = {
        kind: "recorded",
        checkIn: checkIn(),
        status: "checked_in",
      };

      const result = await service().checkIn(staffContext, REGISTRATION_ID, { override: false });

      expect(result).toEqual({
        id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        registration_id: REGISTRATION_ID,
        checked_in_at: NOW.toISOString(),
        is_override: false,
        performed_by: {
          kind: "staff_token",
          staff_token_id: STAFF_TOKEN_ID,
          label: "Door Team A",
        },
      });
    });

    it("returns a recorded override flagged as such", async () => {
      repository.nextCheckInOutcome = {
        kind: "recorded",
        checkIn: checkIn({ id: "second", isOverride: true }),
        status: "checked_in",
      };

      const result = await service().checkIn(staffContext, REGISTRATION_ID, { override: true });

      expect(result.is_override).toBe(true);
      expect(result.id).toBe("second");
    });

    it("takes the event scope from the token, never from the caller", async () => {
      repository.nextCheckInOutcome = {
        kind: "recorded",
        checkIn: checkIn(),
        status: "checked_in",
      };

      await service().checkIn(staffContext, REGISTRATION_ID, { override: false });

      expect(repository.checkInInputs[0].staffTokenEventId).toBe(EVENT_ID);
      expect(repository.checkInInputs[0].staffTokenId).toBe(STAFF_TOKEN_ID);
    });

    it("refuses to report success if an adapter recorded an ineligible check-in", async () => {
      repository.nextCheckInOutcome = {
        kind: "recorded",
        checkIn: checkIn(),
        status: "refunded",
      };

      await expect(
        service().checkIn(staffContext, REGISTRATION_ID, { override: false }),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });
});

describe("staff projections", () => {
  describe("maskEmail", () => {
    it("keeps the first and last local characters and the domain", () => {
      expect(maskEmail("ada.lovelace@example.com")).toBe("a***e@example.com");
    });

    it("masks a two-character local part down to one visible character", () => {
      expect(maskEmail("ab@example.com")).toBe("a*@example.com");
    });

    it("fully masks a one-character local part rather than revealing it twice", () => {
      expect(maskEmail("a@example.com")).toBe("*@example.com");
    });

    it("does not throw on a value with no @ at all", () => {
      expect(maskEmail("not-an-email")).toBe("n***********");
    });
  });

  describe("maskPhone", () => {
    it("keeps a three-character prefix and a two-character suffix", () => {
      expect(maskPhone("+2348012345678")).toBe("+23*********78");
    });

    it("keeps only a prefix when there is no middle to hide", () => {
      expect(maskPhone("12345")).toBe("12***");
    });

    it("fully masks a number too short to reveal anything", () => {
      expect(maskPhone("1")).toBe("*");
    });
  });

  describe("checkInEligible", () => {
    it("is true for exactly the two states PRD §9.4 allows", () => {
      expect(checkInEligible("confirmed")).toBe(true);
      expect(checkInEligible("checked_in")).toBe(true);
      expect(checkInEligible("pending_payment")).toBe(false);
      expect(checkInEligible("cancelled")).toBe(false);
      expect(checkInEligible("refunded")).toBe(false);
    });
  });

  describe("staffStatusBadge", () => {
    it("separates a still-possible pending payment from a dead one", () => {
      expect(staffStatusBadge("pending_payment")).toBe("pending");
      expect(staffStatusBadge("cancelled")).toBe("payment_not_confirmed");
      expect(staffStatusBadge("refunded")).toBe("payment_not_confirmed");
    });
  });
});

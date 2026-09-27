/**
 * Centralised validation (AGENTS.md §4, §13; PRD v2 §11).
 *
 * Every mutating endpoint parses its body through a function in this file. No
 * route handler does ad-hoc field checks, and no rule is duplicated between
 * endpoints.
 *
 * Implemented by hand rather than with a schema library: the surface is a handful
 * of small fields, and AGENTS.md §4 requires stating why an existing tool cannot
 * do the job before adding a dependency. It cannot — there is no such dependency
 * in the project today, and explicit checks are smaller than the library.
 *
 * PRODUCT-OWNER DECISION 4 (2026-09-26) — the event-field thresholds below are
 * now product decisions rather than a documented placeholder. PRD v2 §11
 * ("Validation Rules") still specifies no event rules; it only requires `400` on
 * invalid fields. The decision set conservative, generous, human-scale limits
 * that are long enough not to reject real copy and short enough to keep a row
 * bounded:
 *
 *   | field         | rule                                  |
 *   |---------------|---------------------------------------|
 *   | name          | required, 1..200 characters           |
 *   | slug          | server-generated, 1..200 characters  |
 *   | description   | OPTIONAL, <= 5000 characters         |
 *   | venue         | required, 1..300 characters          |
 *   | starts_at     | required, offset-aware ISO 8601      |
 *   | ends_at       | required, offset-aware, > starts_at  |
 *
 * The slug limit is `src/domain/events/slug.ts`'s `MAX_SLUG_LENGTH`; the four
 * row limits are also CHECK constraints in the database, so each is proven to
 * reject a bad write by `npm run db:verify-constraints` rather than merely
 * present in application code.
 *
 * The `description` limit is the one place this file now *diverges* from the
 * PRD's field table: §7.2 L181 marks it Required. The decision made it optional,
 * §7.2 was not rewritten, and the divergence is reported in the task report.
 *
 * NOT covered by decision 4, and therefore deliberately left alone: the
 * `programme_items` title/description limits below. No decision covers them, so
 * they remain the documented placeholder they were rather than being quietly
 * resolved to match the event fields.
 *
 * The registration/payment parsers at the end of this file are a different kind of
 * case again: PRD v2 §11 *does* specify their rules (name 1–120, email valid, phone
 * required, `idempotency_key` a client-generated UUID), so they are transcription
 * rather than decision. The two bounds that are *not* in §11 — a 320-character
 * request cap on the email and a 64-character cap on the phone — are limits on what
 * a request may carry, in the same sense as the login route's password cap, and the
 * absence of any phone *format* rule is recorded as an open item rather than filled
 * in here.
 *
 * Two classes of check are deliberately *not* here, because they are not
 * properties of the request:
 *
 *   - `ends_at > starts_at` on a PATCH, which can only be judged against the
 *     stored row. `EventService.updateEvent` does that after merging.
 *   - status-transition legality, which is a property of current state.
 *
 * Both are validated (AGENTS.md §13) — just in the layer that can see enough to
 * answer them.
 */

import { ValidationError, type FieldIssues } from "@/domain/errors";
import {
  isEventStatus,
  type CreateEventCommand,
  type EventStatus,
  type EventWriteSet,
  type PageRequest,
  type ProgrammeItemInput,
  type ProgrammeItemPatch,
  type UpdateEventCommand,
} from "@/domain/events/event";
import type {
  CreateTicketTypeCommand,
  TicketTypePatch,
} from "@/domain/tickets/ticket-type";
import type { CreateRegistrationCommand } from "@/domain/registrations/registration";
import { isWellFormedReference } from "@/domain/registrations/reference";
import {
  isAttendeeRequestStatus,
  type AttendeeRequestStatus,
  type ResolveAttendeeRequestCommand,
  type SubmitAttendeeRequestCommand,
} from "@/domain/requests/request";
import {
  MAX_STAFF_SEARCH_PAGE_SIZE,
  MAX_STAFF_SEARCH_QUERY_LENGTH,
  MIN_STAFF_SEARCH_QUERY_LENGTH,
  type CheckInCommand,
  type IssueStaffTokenCommand,
} from "@/domain/staff/staff";

/**
 * Event-field limits — product-owner decision 4 (2026-09-26).
 *
 * The slug limit is not spelled here: it lives with the generator in
 * `src/domain/events/slug.ts` and is imported from there, so the number that
 * bounds the generator and the number that accepts the result cannot drift.
 */
const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 5_000;
const MAX_VENUE_LENGTH = 300;

/**
 * Programme-item limits — still the documented placeholder, NOT covered by
 * decision 4, which addressed event fields only. Recorded here as an open item
 * rather than aligned to the event limits, because aligning them would be
 * resolving an undecided question silently.
 */
const MAX_PROGRAMME_TITLE_LENGTH = 200;
const MAX_PROGRAMME_DESCRIPTION_LENGTH = 5_000;

/**
 * Ticket-tier limits — product-owner decision 5 (2026-09-26), deliberately the
 * SAME numbers as the event fields above so the schema has one convention rather
 * than one per table (migration `20260926000400_ticket_type_limits`).
 *
 *   | field             | rule                                    |
 *   |-------------------|-----------------------------------------|
 *   | name              | required, 1..200 characters             |
 *   | description       | optional, <= 5000 characters           |
 *   | price_minor_units | required, integer, >= 0                 |
 *   | currency          | required, ISO 4217 alphabetic, 3 letters |
 *   | quantity_total    | required, integer, > 0                  |
 *
 * The price, currency, and quantity rules are the skill's step 2, which is
 * transcribing a requirement rather than choosing a number. The name and
 * description limits are the ones this slice had to set, and they follow decision
 * 4's event values.
 *
 * All five are also database CHECK constraints: AGENTS.md §5 is explicit that a
 * rule living only in application code is not the same guarantee, so each is
 * proved to reject the bad write by `npm run db:verify-constraints`.
 *
 * NOT decided here, and worth stating: whether a currency is a *real* ISO 4217
 * code. Validating the shape (three ASCII letters, upper-cased) is what the
 * contract requires; checking a code against the ISO registry is not specified
 * anywhere and would need a list that goes stale. Reported as an open item — the
 * skill's own "Required output" lists currency handling as one.
 */
const MAX_TICKET_TYPE_NAME_LENGTH = 200;
const MAX_TICKET_TYPE_DESCRIPTION_LENGTH = 5_000;

/**
 * Pagination bounds from `.agents/rules/06`: "page default 1; page_size default
 * 20, max 50, hard cap".
 */
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

/** Accumulator so one response reports every bad field, not just the first. */
class IssueCollector {
  private readonly issues: Record<string, string[]> = {};

  add(field: string, message: string): void {
    (this.issues[field] ??= []).push(message);
  }

  get isEmpty(): boolean {
    return Object.keys(this.issues).length === 0;
  }

  toFieldIssues(): FieldIssues {
    return this.issues;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A required, trimmed, length-bounded string.
 *
 * Trimming happens here so the domain never sees padded input, and so
 * `"   "` is correctly rejected as empty rather than stored as a blank name.
 */
function requireBoundedString(
  body: Record<string, unknown>,
  field: string,
  maxLength: number,
  issues: IssueCollector,
): string {
  const raw = body[field];

  if (typeof raw !== "string") {
    issues.add(field, "Required, and must be a string.");
    return "";
  }

  const value = raw.trim();

  if (value === "") {
    issues.add(field, "Required, and cannot be blank.");
    return "";
  }

  if (value.length > maxLength) {
    issues.add(field, `Must be at most ${maxLength} characters.`);
  }

  return value;
}

/**
 * A required, offset-aware ISO 8601 timestamp.
 *
 * An explicit offset (or `Z`) is required because the column is `timestamptz`
 * and a naive local time has no single correct instant. Silently assuming UTC
 * would shift an event by hours for an organiser in another timezone.
 */
function requireIsoTimestamp(
  body: Record<string, unknown>,
  field: string,
  issues: IssueCollector,
): Date | null {
  const raw = body[field];

  if (typeof raw !== "string") {
    issues.add(field, "Required, and must be an ISO 8601 string with a UTC offset.");
    return null;
  }

  const value = raw.trim();
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);

  if (!hasOffset) {
    issues.add(
      field,
      'Must include a UTC offset, e.g. "2026-10-01T18:00:00Z" or "2026-10-01T19:00:00+01:00".',
    );
    return null;
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    issues.add(field, "Must be a valid ISO 8601 timestamp.");
    return null;
  }

  return parsed;
}

/**
 * Reject fields the contract does not define.
 *
 * This is a security control, not pedantry. PRD v2 §3 requires that ownership
 * come from the authenticated identity, and `.agents/rules/06` forbids
 * accepting client-supplied amounts or ownership assertions. A strict
 * allowlist makes `organiser_id`, `status`, and `slug` unimplementable from the
 * body rather than merely unused.
 */
function rejectUnknownFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
  issues: IssueCollector,
): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      issues.add(key, "Not a recognised field for this request.");
    }
  }
}

/**
 * Parse the `POST /api/v1/events` body (PRD v2 §12).
 *
 * The allowed fields are exactly those the PRD lists for this endpoint:
 * name, description, starts_at, ends_at, venue. `organiser_id` and `status` are
 * deliberately absent — the organiser comes from the auth context and the status
 * is a lifecycle transition with no endpoint in the contract.
 *
 * `description` is optional per decision 4. Absent and explicit `null` are both
 * accepted and both normalise to `null`, matching the column; sending `""` is a
 * validation error rather than being read as "clear it", because on create there
 * is nothing to clear and a blank string is almost always a client bug.
 */
export function parseCreateEventRequest(body: unknown): CreateEventCommand {
  if (!isPlainObject(body)) {
    throw new ValidationError("Request body must be a JSON object.", {
      body: [
        "Send a JSON object with name, starts_at, ends_at, and venue; description is optional.",
      ],
    });
  }

  const issues = new IssueCollector();
  rejectUnknownFields(body, ["name", "description", "starts_at", "ends_at", "venue"], issues);

  const name = requireBoundedString(body, "name", MAX_NAME_LENGTH, issues);
  const description = optionalNullableBoundedString(
    body,
    "description",
    MAX_DESCRIPTION_LENGTH,
    issues,
  );
  const venue = requireBoundedString(body, "venue", MAX_VENUE_LENGTH, issues);
  const startsAt = requireIsoTimestamp(body, "starts_at", issues);
  const endsAt = requireIsoTimestamp(body, "ends_at", issues);

  if (startsAt !== null && endsAt !== null && endsAt.getTime() <= startsAt.getTime()) {
    // Also relied upon by the staff-token expiry rule ("the event's end date
    // plus a short grace window"), which is meaningless for a zero-length event.
    issues.add("ends_at", "Must be after starts_at.");
  }

  if (!issues.isEmpty) {
    throw new ValidationError("The request body failed validation.", issues.toFieldIssues());
  }

  // Non-null by construction: every branch above that could leave a null has
  // already recorded an issue and thrown. `description` is the one field that is
  // allowed to be null, and `requireBoundedString` is not used for it.
  return {
    name,
    description: description ?? null,
    startsAt: startsAt as Date,
    endsAt: endsAt as Date,
    venue,
  };
}

/** Read a JSON body, turning malformed JSON into a `validation_failed` 400. */
export async function readJsonObject(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    throw new ValidationError("Request body must be valid JSON.", {
      body: ["The body could not be parsed as JSON."],
    });
  }
}

/** Was this key actually sent? Distinguishes "clear it" from "leave it alone". */
function isPresent(body: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, field);
}

function requireBodyObject(body: unknown): Record<string, unknown> {
  if (!isPlainObject(body)) {
    throw new ValidationError("Request body must be a JSON object.", {
      body: ["Send a JSON object with the fields listed for this endpoint."],
    });
  }

  return body;
}

/**
 * An optional, trimmed, length-bounded string.
 *
 * Returns `undefined` when the key is absent so the caller can tell "not
 * mentioned" from "sent as empty" — the difference between leaving a field alone
 * and clearing it.
 */
function optionalBoundedString(
  body: Record<string, unknown>,
  field: string,
  maxLength: number,
  issues: IssueCollector,
): string | undefined {
  if (!isPresent(body, field)) {
    return undefined;
  }

  const raw = body[field];

  if (typeof raw !== "string") {
    issues.add(field, "Must be a string.");
    return undefined;
  }

  const value = raw.trim();

  if (value === "") {
    issues.add(field, "Cannot be blank.");
    return undefined;
  }

  if (value.length > maxLength) {
    issues.add(field, `Must be at most ${maxLength} characters.`);
  }

  return value;
}

/** Optional bounded string that may also be explicitly `null` to clear it. */
function nullableBoundedString(
  body: Record<string, unknown>,
  field: string,
  maxLength: number,
  issues: IssueCollector,
): string | null | undefined {
  if (!isPresent(body, field)) {
    return undefined;
  }

  if (body[field] === null) {
    return null;
  }

  return optionalBoundedString(body, field, maxLength, issues);
}

/**
 * Optional bounded string for a field that may be absent, `null`, or present —
 * used by `POST`, where absent and `null` mean the same thing.
 *
 * Distinct from {@link nullableBoundedString} only in intent: on create there is
 * no stored row to "clear", so the caller collapses the two with `?? null`. Kept
 * as its own function so each endpoint's parser states its own semantics rather
 * than inheriting the other's.
 */
function optionalNullableBoundedString(
  body: Record<string, unknown>,
  field: string,
  maxLength: number,
  issues: IssueCollector,
): string | null | undefined {
  return nullableBoundedString(body, field, maxLength, issues);
}

/** Optional, offset-aware timestamp. Same offset rule as the create path. */
function optionalIsoTimestamp(
  body: Record<string, unknown>,
  field: string,
  issues: IssueCollector,
): Date | undefined {
  if (!isPresent(body, field)) {
    return undefined;
  }

  const probe = new IssueCollector();
  const parsed = requireIsoTimestamp(body, field, probe);

  if (probe.isEmpty) {
    return parsed ?? undefined;
  }

  for (const message of probe.toFieldIssues()[field] ?? []) {
    issues.add(field, message);
  }

  return undefined;
}

/** Optional timestamp that may also be explicitly `null` to clear it. */
function nullableIsoTimestamp(
  body: Record<string, unknown>,
  field: string,
  issues: IssueCollector,
): Date | null | undefined {
  if (!isPresent(body, field)) {
    return undefined;
  }

  if (body[field] === null) {
    return null;
  }

  return optionalIsoTimestamp(body, field, issues);
}

function requireNonNegativeInteger(
  body: Record<string, unknown>,
  field: string,
  issues: IssueCollector,
): number | undefined {
  const raw = body[field];

  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    issues.add(field, "Required, and must be an integer.");
    return undefined;
  }

  if (raw < 0) {
    issues.add(field, "Must be zero or greater.");
    return undefined;
  }

  return raw;
}

function optionalNonNegativeInteger(
  body: Record<string, unknown>,
  field: string,
  issues: IssueCollector,
): number | undefined {
  if (!isPresent(body, field)) {
    return undefined;
  }

  return requireNonNegativeInteger(body, field, issues);
}

/**
 * Parse the `PATCH /api/v1/events/{id}` body.
 *
 * `status` is allowed here — decision D2 puts the lifecycle transition on PATCH.
 * Whether the requested transition is *legal* is not answerable from the body
 * alone, so that check belongs to `EventService`, not here.
 *
 * At least one field must be present: an empty PATCH is a client mistake worth
 * reporting rather than silently answering `200` for a request that did nothing.
 */
export function parseUpdateEventRequest(body: unknown): UpdateEventCommand {
  const object = requireBodyObject(body);
  const issues = new IssueCollector();

  rejectUnknownFields(object, [...UPDATE_EVENT_FIELDS], issues);

  const name = optionalBoundedString(object, "name", MAX_NAME_LENGTH, issues);
  // Nullable, not merely optional: decision 4 made `description` optional, and
  // "absent means leave alone" is only half of that. Without an explicit `null`
  // an organiser could never remove a blurb they once wrote, because sending
  // `""` is rejected as blank. Absent still means "leave alone"; `null` clears.
  const description = nullableBoundedString(
    object,
    "description",
    MAX_DESCRIPTION_LENGTH,
    issues,
  );
  const venue = optionalBoundedString(object, "venue", MAX_VENUE_LENGTH, issues);
  const startsAt = optionalIsoTimestamp(object, "starts_at", issues);
  const endsAt = optionalIsoTimestamp(object, "ends_at", issues);

  let status: EventStatus | undefined;
  if (isPresent(object, "status")) {
    if (isEventStatus(object.status)) {
      status = object.status;
    } else {
      issues.add("status", 'Must be one of "draft", "published", "closed".');
    }
  }

  // Only complain about an empty body when no recognised key was sent at all.
  // If a key *was* sent and failed, its own field-level error already says what
  // is wrong; adding "send at least one field" as well would be misleading.
  if (!UPDATE_EVENT_FIELDS.some((field) => isPresent(object, field))) {
    issues.add("body", "Send at least one of name, description, starts_at, ends_at, venue, status.");
  }

  if (!issues.isEmpty) {
    throw new ValidationError("The request body failed validation.", issues.toFieldIssues());
  }

  return {
    ...definedOnly({ name }),
    ...definedOnly({ description }),
    ...definedOnly({ venue }),
    ...definedOnly({ startsAt }),
    ...definedOnly({ endsAt }),
    ...definedOnly({ status }),
  } as UpdateEventCommand;
}

/** Drop `undefined` values so an absent field is genuinely absent. */
function definedOnly<T extends object>(source: T): Partial<T> {
  const result: Partial<T> = {};

  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) {
      (result as Record<string, unknown>)[key] = value;
    }
  }

  return result;
}

const PROGRAMME_FIELDS = ["sort_order", "time", "title", "description"] as const;

/** Allowed `PATCH /api/v1/events/{id}` fields — `status` included (decision D2). */
const UPDATE_EVENT_FIELDS = [
  "name",
  "description",
  "starts_at",
  "ends_at",
  "venue",
  "status",
] as const;

/**
 * Parse `POST /api/v1/events/{id}/programme`.
 *
 * `sort_order` is a client-supplied integer because FR-2 requires the order to be
 * stored rather than inferred. It is validated as a non-negative integer and
 * deliberately *not* made unique: reordering is done by rewriting the integers.
 */
export function parseCreateProgrammeItemRequest(body: unknown): ProgrammeItemInput {
  const object = requireBodyObject(body);
  const issues = new IssueCollector();

  rejectUnknownFields(object, [...PROGRAMME_FIELDS], issues);

  const sortOrder = requireNonNegativeInteger(object, "sort_order", issues);
  const title = optionalBoundedString(
    object,
    "title",
    MAX_PROGRAMME_TITLE_LENGTH,
    issues,
  );
  const time = nullableIsoTimestamp(object, "time", issues);
  const description = nullableBoundedString(
    object,
    "description",
    MAX_PROGRAMME_DESCRIPTION_LENGTH,
    issues,
  );

  if (title === undefined && !isPresent(object, "title")) {
    issues.add("title", "Required, and cannot be blank.");
  }

  if (sortOrder === undefined && !isPresent(object, "sort_order")) {
    // `requireNonNegativeInteger` already reported a present-but-wrong value;
    // this covers the key being missing entirely.
    if (Object.keys(issues.toFieldIssues()).length === 0) {
      issues.add("sort_order", "Required, and must be an integer.");
    }
  }

  if (!issues.isEmpty) {
    throw new ValidationError("The request body failed validation.", issues.toFieldIssues());
  }

  return {
    sortOrder: sortOrder as number,
    time: time ?? null,
    title: title as string,
    description: description ?? null,
  };
}

/**
 * Parse `PATCH /api/v1/events/{id}/programme/{item_id}`.
 *
 * Explicit `null` clears `time` or `description`; omitting the key leaves it
 * alone. The service merges the result onto the stored line, so a partial body
 * never blanks a field the caller did not mention.
 */
export function parseUpdateProgrammeItemRequest(body: unknown): ProgrammeItemPatch {
  const object = requireBodyObject(body);
  const issues = new IssueCollector();

  rejectUnknownFields(object, [...PROGRAMME_FIELDS], issues);

  const sortOrder = optionalNonNegativeInteger(object, "sort_order", issues);
  const title = optionalBoundedString(object, "title", MAX_PROGRAMME_TITLE_LENGTH, issues);
  const time = nullableIsoTimestamp(object, "time", issues);
  const description = nullableBoundedString(
    object,
    "description",
    MAX_PROGRAMME_DESCRIPTION_LENGTH,
    issues,
  );

  if (!PROGRAMME_FIELDS.some((field) => isPresent(object, field))) {
    issues.add("body", "Send at least one of sort_order, time, title, description.");
  }

  if (!issues.isEmpty) {
    throw new ValidationError("The request body failed validation.", issues.toFieldIssues());
  }

  return {
    ...definedOnly({ sortOrder }),
    ...definedOnly({ title }),
    ...definedOnly({ time }),
    ...definedOnly({ description }),
  } as ProgrammeItemPatch;
}

const TICKET_TYPE_FIELDS = [
  "name",
  "description",
  "price_minor_units",
  "currency",
  "quantity_total",
] as const;

/**
 * An ISO 4217 alphabetic code: exactly three ASCII letters.
 *
 * Lower case is *accepted and upper-cased* rather than rejected, because the code
 * is a label a human types and `ngn` is the same currency as `NGN`. What is
 * rejected is anything that is not three letters — digits, symbols, empty strings
 * — since those cannot be a currency code at all. The upper-cased form is what
 * gets stored, and `ticket_types_currency_iso4217_check` independently requires
 * it, so a lowercase code can never reach the column by another path.
 */
function requireCurrencyCode(
  body: Record<string, unknown>,
  field: string,
  issues: IssueCollector,
): string | undefined {
  const raw = body[field];

  if (typeof raw !== "string") {
    issues.add(field, "Required, and must be a 3-letter ISO 4217 currency code.");
    return undefined;
  }

  const value = raw.trim().toUpperCase();

  if (!/^[A-Z]{3}$/.test(value)) {
    issues.add(field, 'Must be a 3-letter ISO 4217 currency code, e.g. "NGN" or "GBP".');
    return undefined;
  }

  return value;
}

/** A required integer strictly greater than zero. */
function requirePositiveInteger(
  body: Record<string, unknown>,
  field: string,
  issues: IssueCollector,
): number | undefined {
  const raw = body[field];

  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    issues.add(field, "Required, and must be an integer.");
    return undefined;
  }

  if (raw < 1) {
    issues.add(field, "Must be 1 or greater.");
    return undefined;
  }

  return raw;
}

/** Optional counterpart of {@link requirePositiveInteger}. */
function optionalPositiveInteger(
  body: Record<string, unknown>,
  field: string,
  issues: IssueCollector,
): number | undefined {
  if (!isPresent(body, field)) {
    return undefined;
  }

  return requirePositiveInteger(body, field, issues);
}

/** Optional ISO 4217 code, normalised the same way the create path normalises it. */
function optionalCurrencyCode(
  body: Record<string, unknown>,
  field: string,
  issues: IssueCollector,
): string | undefined {
  if (!isPresent(body, field)) {
    return undefined;
  }

  return requireCurrencyCode(body, field, issues);
}

/**
 * Parse the `POST /api/v1/events/{id}/ticket-types` body (PRD v2 §12, skill step 2).
 *
 * The allowed fields are exactly §12's four — name, price_minor_units, currency,
 * quantity_total — plus the optional `description` the skill lists. Two fields are
 * deliberately *absent from the allowlist*, which is what makes them unimplementable
 * rather than merely ignored:
 *
 *   - `event_id` comes from the path, and ownership of that event is checked
 *     server-side (PRD §3, rule 05);
 *   - `quantity_confirmed` / `quantity_held` are inventory, not input. They move
 *     only through the §9.3 conditional transitions, and a body that could set
 *     them would be a client choosing its own stock.
 *
 * PRD §12's error note for this endpoint is "400 on invalid pricing/quantity",
 * which is what the integer and code checks below produce.
 */
export function parseCreateTicketTypeRequest(body: unknown): CreateTicketTypeCommand {
  const object = requireBodyObject(body);
  const issues = new IssueCollector();

  rejectUnknownFields(object, [...TICKET_TYPE_FIELDS], issues);

  const name = requireBoundedString(object, "name", MAX_TICKET_TYPE_NAME_LENGTH, issues);
  const description = optionalNullableBoundedString(
    object,
    "description",
    MAX_TICKET_TYPE_DESCRIPTION_LENGTH,
    issues,
  );
  const priceMinorUnits = requireNonNegativeInteger(object, "price_minor_units", issues);
  const currency = requireCurrencyCode(object, "currency", issues);
  const quantityTotal = requirePositiveInteger(object, "quantity_total", issues);

  if (!issues.isEmpty) {
    throw new ValidationError("The request body failed validation.", issues.toFieldIssues());
  }

  // Non-null by construction: every branch that could leave one of these null has
  // already recorded an issue and thrown. `description` is the one field allowed
  // to be null, which is why it goes through the nullable-bounded parser and
  // `requireBoundedString` is not used for it.
  return {
    name,
    description: description ?? null,
    priceMinorUnits: priceMinorUnits as number,
    currency: currency as string,
    quantityTotal: quantityTotal as number,
  };
}

/**
 * Parse `PATCH /api/v1/events/{id}/ticket-types/{ticket_type_id}`.
 *
 * Same allow-list as the create body, and for the same reasons. Absent leaves a
 * column alone; an explicit `null` clears `description`; the service merges the
 * result onto the stored tier.
 *
 * `quantity_total` is validated as a positive integer here but NOT against the
 * tier's committed stock — that can only be judged against the stored row, and it
 * is the database CHECK that decides (skill step 9).
 */
export function parseUpdateTicketTypeRequest(body: unknown): TicketTypePatch {
  const object = requireBodyObject(body);
  const issues = new IssueCollector();

  rejectUnknownFields(object, [...TICKET_TYPE_FIELDS], issues);

  const name = optionalBoundedString(object, "name", MAX_TICKET_TYPE_NAME_LENGTH, issues);
  const description = nullableBoundedString(
    object,
    "description",
    MAX_TICKET_TYPE_DESCRIPTION_LENGTH,
    issues,
  );
  const priceMinorUnits = optionalNonNegativeInteger(object, "price_minor_units", issues);
  const currency = optionalCurrencyCode(object, "currency", issues);
  const quantityTotal = optionalPositiveInteger(object, "quantity_total", issues);

  // Only complain about an empty body when no recognised key was sent at all. If a
  // key *was* sent and failed, its own field-level error already says what is
  // wrong; adding "send at least one field" as well would be misleading.
  if (!TICKET_TYPE_FIELDS.some((field) => isPresent(object, field))) {
    issues.add("body", "Send at least one of name, description, price_minor_units, currency, quantity_total.");
  }

  if (!issues.isEmpty) {
    throw new ValidationError("The request body failed validation.", issues.toFieldIssues());
  }

  return {
    ...definedOnly({ name }),
    ...definedOnly({ description }),
    ...definedOnly({ priceMinorUnits }),
    ...definedOnly({ currency }),
    ...definedOnly({ quantityTotal }),
  } as TicketTypePatch;
}

/**
 * Pagination bounds, shared by every list endpoint (rule 06).
 *
 * Split out of `parseListEventsQuery` so the ticket-type list inherits the exact
 * same defaults, the same hard cap, and the same reject-rather-than-clamp choice
 * from one definition.
 *
 * `maxPageSize` exists because rule 06's "max 50" is the platform-wide ceiling, not
 * every list's own limit: PRD §11 caps a *search* at 20 results per request. A
 * per-endpoint ceiling can only be a smaller number than the global one without
 * contradicting it, so this narrows the cap rather than inventing a second rule.
 */
function parsePaginationParams(
  searchParams: URLSearchParams,
  issues: IssueCollector,
  maxPageSize: number = MAX_PAGE_SIZE,
): PageRequest {

  const page = parsePositiveIntegerParam(
    searchParams.get("page"),
    "page",
    DEFAULT_PAGE,
    issues,
  );

  const pageSize = parsePositiveIntegerParam(
    searchParams.get("page_size"),
    "page_size",
    DEFAULT_PAGE_SIZE,
    issues,
  );

  if (pageSize > maxPageSize) {
    issues.add("page_size", `Must be ${maxPageSize} or fewer.`);
  }

  return { page, pageSize };
}

/**
 * Parse `GET /api/v1/events/{id}/ticket-types` query parameters.
 *
 * Pagination only, and the absence of a filter is a decision rather than an
 * oversight. PRD §12's pagination contract states which list endpoints take extra
 * parameters — "Search additionally supports `query`; requests additionally
 * supports `status`" — and a ticket-type list is neither a search nor a requests
 * endpoint, so no filter is specified. The only scoping that is required is event
 * ownership, and that is enforced server-side rather than by a query parameter, so
 * a caller cannot widen it.
 *
 * An over-large `page_size` is rejected, not clamped — the same choice as the event
 * list, stated here so the two are visibly consistent rather than accidentally so.
 */
export function parseListTicketTypesQuery(searchParams: URLSearchParams): PageRequest {
  const issues = new IssueCollector();

  const pagination = parsePaginationParams(searchParams, issues);

  if (!issues.isEmpty) {
    throw new ValidationError("The query parameters failed validation.", issues.toFieldIssues());
  }

  return pagination;
}

/** Parse one positive integer from a query string, or record why it is invalid. */
function parsePositiveIntegerParam(
  raw: string | null,
  field: string,
  fallback: number,
  issues: IssueCollector,
): number {
  if (raw === null) {
    return fallback;
  }

  // `Number("")` is 0 and `Number("1e3")` is 1000; require plain digits only, so a
  // malformed parameter is rejected rather than silently reinterpreted.
  if (!/^\d+$/.test(raw)) {
    issues.add(field, "Must be a positive integer.");
    return fallback;
  }

  const value = Number(raw);

  if (value < 1) {
    issues.add(field, "Must be 1 or greater.");
    return fallback;
  }

  return value;
}

/**
 * Parse `GET /api/v1/events` query parameters (`.agents/rules/06` pagination).
 *
 * An over-large `page_size` is **rejected**, not clamped — the rule allows
 * either so long as it is stated consistently, and rejecting matches the
 * neighbouring "reject `0`/negative/non-numeric rather than silently defaulting".
 *
 * The optional `status` filter exists because §7.2 L190 specifies the
 * `(organiser_id, status)` index specifically "for organiser's event list"; it is
 * not a free-text search, which §10 scopes to staff registration search.
 */
export function parseListEventsQuery(searchParams: URLSearchParams): PageRequest & {
  status?: EventStatus;
} {
  const issues = new IssueCollector();

  const pagination = parsePaginationParams(searchParams, issues);

  let status: EventStatus | undefined;
  const rawStatus = searchParams.get("status");
  if (rawStatus !== null) {
    if (isEventStatus(rawStatus)) {
      status = rawStatus;
    } else {
      issues.add("status", 'Must be one of "draft", "published", "closed".');
    }
  }

  if (!issues.isEmpty) {
    throw new ValidationError("The query parameters failed validation.", issues.toFieldIssues());
  }

  return { ...pagination, ...definedOnly({ status }) };
}

// ---------------------------------------------------------------------------
// Registration & payment requests (PRD v2 §11, §12)
// ---------------------------------------------------------------------------

/**
 * PRD §11's attendee-name limit, transcribed.
 *
 * "Required, 1–120 characters" is the only attendee name rule in the source of truth,
 * so it is the only one applied here. It is stated rather than inherited from the
 * event/tier limits on purpose: those two sets are product-owner decisions
 * (4 and 5) that predate the registration slice, and silently extending them to a
 * third table would be a product decision made in a parser.
 */
const MAX_ATTENDEE_NAME_LENGTH = 120;

/**
 * A bound on what a *request* may carry, not a product limit on an address.
 *
 * 320 is RFC 5321's maximum total length of a forward-path address, so anything
 * longer cannot be a deliverable address at all. The same distinction the login
 * route draws for `password`.
 */
const MAX_EMAIL_LENGTH = 320;

/**
 * A bound on what a *request* may carry, not a product limit on a phone number.
 *
 * E.164 caps a subscriber number at 15 digits, but people write numbers with
 * spaces, dashes, brackets, and a leading `+`, and PRD §11 says only "required".
 * 64 characters is far beyond any written form of a real number while still
 * bounding the column.
 */
const MAX_PHONE_LENGTH = 64;

/**
 * A reference this platform could not have generated is refused at the door.
 *
 * `Provider.provider_reference` is base64url of 32 random bytes (see `reference.ts`),
 * and both `ticket_type_id` and `registration_id` are `uuid` columns in PostgreSQL.
 * Without these checks a malformed value would not produce a `400` — it would
 * produce a `500` from a driver error, or (worse, for the reference) a lookup
 * against a string that could never match, dressed up as "no such payment".
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A `tx_ref` is base64url; `.` `_` and `-` cover a hand-written test value too. */
const PROVIDER_REFERENCE_PATTERN = /^[A-Za-z0-9._~-]+$/;
const MAX_PROVIDER_REFERENCE_LENGTH = 200;

/**
 * A required, well-formed UUID.
 *
 * Used for `ticket_type_id`, `registration_id`, and `idempotency_key`. For the last
 * of those it is a PRD §11 requirement in its own right — "client-generated UUID" —
 * and for the first two it is a consequence of the column type, so in both cases a
 * malformed value is the caller's mistake and gets a `400` naming the field.
 */
function requireUuid(
  body: Record<string, unknown>,
  field: string,
  issues: IssueCollector,
): string | undefined {
  const raw = body[field];

  if (typeof raw !== "string") {
    issues.add(field, "Required, and must be a UUID string.");
    return undefined;
  }

  const value = raw.trim();

  if (value === "") {
    issues.add(field, "Required, and cannot be blank.");
    return undefined;
  }

  if (!UUID_PATTERN.test(value)) {
    issues.add(field, "Must be a UUID, e.g. 8-4-4-4-12 hexadecimal digits.");
    return undefined;
  }

  // Lower-cased so two spellings of the same id cannot reach the database as two
  // different strings and defeat a `UNIQUE` comparison that treats them as equal.
  return value.toLowerCase();
}

/**
 * A required, plausible email address (PRD §11: "required, valid format").
 *
 * What "valid format" is taken to mean is stated here because the PRD does not
 * define it, and a parser is the only place this decision can be recorded:
 *
 *   - no whitespace anywhere (RFC 5322 forbids it in an addr-spec);
 *   - exactly one `@`, with a non-empty local part and a non-empty domain;
 *   - the domain must contain at least one dot, so `attendee@localhost` is rejected.
 *     A registrable public domain always has one, and the address is the *second
 *     factor* of FR-15 evidence retrieval and the fallback search key of FR-17 —
 *     an address that can never receive mail would quietly make a ticket
 *     unretrievable, which is worse than a rejected submission.
 *
 * Deliberately **not** an attempt at RFC 5322/5321 full grammar: quoted local
 * parts, IP literals, and comments are all legal and all worthless here, and a
 * 40-line regex claiming to parse them is a worse filter than this one. This is a
 * shape check, and the comment says so rather than implying more.
 */
function requireEmail(
  body: Record<string, unknown>,
  field: string,
  issues: IssueCollector,
): string | undefined {
  const raw = body[field];

  if (typeof raw !== "string") {
    issues.add(field, "Required, and must be a valid email address.");
    return undefined;
  }

  const value = raw.trim();

  if (value === "") {
    issues.add(field, "Required, and cannot be blank.");
    return undefined;
  }

  if (value.length > MAX_EMAIL_LENGTH) {
    issues.add(field, `Must be at most ${MAX_EMAIL_LENGTH} characters.`);
    return value;
  }

  if (!/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(value)) {
    issues.add(field, 'Must be a valid email address, e.g. "attendee@example.com".');
  }

  return value;
}

/**
 * A required phone number.
 *
 * PRD §11 says "required" and nothing else, so this checks exactly that: present,
 * a string, and not blank. No format rule is invented here — see the note on
 * {@link MAX_PHONE_LENGTH} — and the absence of one is recorded as an open item in
 * `docs/evidence/requirements-matrix.md` rather than resolved silently, because a
 * format rule would change which attendees can buy a ticket.
 */
function requirePhone(
  body: Record<string, unknown>,
  field: string,
  issues: IssueCollector,
): string | undefined {
  const raw = body[field];

  if (typeof raw !== "string") {
    issues.add(field, "Required, and must be a string.");
    return undefined;
  }

  const value = raw.trim();

  if (value === "") {
    issues.add(field, "Required, and cannot be blank.");
    return undefined;
  }

  if (value.length > MAX_PHONE_LENGTH) {
    issues.add(field, `Must be at most ${MAX_PHONE_LENGTH} characters.`);
  }

  return value;
}

const REGISTRATION_FIELDS = [
  "attendee_name",
  "email",
  "phone",
  "ticket_type_id",
  "idempotency_key",
] as const;

/**
 * Parse `POST /api/v1/events/{id}/registrations` (PRD v2 §12, §11).
 *
 * The allowed fields are exactly §12's five: `attendee_name`, `email`, `phone`,
 * `ticket_type_id`, `idempotency_key`. Note the *names* — the body says `email` and
 * `phone`, while the stored columns are `attendee_email` and `attendee_phone`. That
 * asymmetry is the contract's, not a typo to be quietly corrected, and
 * `CreateRegistrationCommand` renames them for the domain.
 *
 * Three fields are absent from the allowlist, and each absence is what makes it
 * unimplementable rather than merely ignored:
 *
 *   - `event_id` — comes from the path;
 *   - `amount` / `currency` / `price_minor_units` — FR-11 requires the amount to be
 *     computed server-side from the tier, and rule 06 forbids a client-supplied one;
 *   - `status` — a lifecycle transition with no body-level representation.
 *
 * What is *not* checked here, because it is not knowable from a body: whether the
 * tier exists, is on this event, is published, has availability, or is priceable
 * (PRD §11's "must reference an existing, published tier with `available > 0`"). The
 * service and the adapter decide that, because only they can see the tier.
 */
export function parseCreateRegistrationRequest(body: unknown): CreateRegistrationCommand {
  const object = requireBodyObject(body);
  const issues = new IssueCollector();

  rejectUnknownFields(object, [...REGISTRATION_FIELDS], issues);

  const attendeeName = requireBoundedString(object, "attendee_name", MAX_ATTENDEE_NAME_LENGTH, issues);
  const email = requireEmail(object, "email", issues);
  const phone = requirePhone(object, "phone", issues);
  const ticketTypeId = requireUuid(object, "ticket_type_id", issues);
  const idempotencyKey = requireUuid(object, "idempotency_key", issues);

  if (!issues.isEmpty) {
    throw new ValidationError("The request body failed validation.", issues.toFieldIssues());
  }

  // Non-null by construction: every branch that could leave one of these undefined
  // has already recorded an issue and thrown.
  return {
    attendeeName,
    attendeeEmail: email as string,
    attendeePhone: phone as string,
    ticketTypeId: ticketTypeId as string,
    idempotencyKey: idempotencyKey as string,
  };
}

/**
 * Parse `POST /api/v1/payments/initiate` (PRD v2 §12).
 *
 * One field: `registration_id`. It identifies **our** registration row — the UUID
 * the response returns as no field at all, which is why the attendee-facing
 * `unique_reference` is not accepted here: it is the evidence-retrieval factor
 * (FR-15), not a purchase handle, and accepting it would turn the door reference
 * into something an attacker can pay through.
 */
export function parseInitiatePaymentRequest(body: unknown): { readonly registrationId: string } {
  const object = requireBodyObject(body);
  const issues = new IssueCollector();

  rejectUnknownFields(object, ["registration_id"], issues);

  const registrationId = requireUuid(object, "registration_id", issues);

  if (!issues.isEmpty) {
    throw new ValidationError("The request body failed validation.", issues.toFieldIssues());
  }

  return { registrationId: registrationId as string };
}

/** One `provider_reference`, from whichever channel the caller used. */
function readProviderReference(
  raw: string | null,
  field: string,
  issues: IssueCollector,
): string | undefined {
  if (raw === null) {
    issues.add(field, "Required, and cannot be blank.");
    return undefined;
  }

  const value = raw.trim();

  if (value === "") {
    issues.add(field, "Required, and cannot be blank.");
    return undefined;
  }

  if (value.length > MAX_PROVIDER_REFERENCE_LENGTH) {
    issues.add(field, `Must be at most ${MAX_PROVIDER_REFERENCE_LENGTH} characters.`);
    return value;
  }

  if (!PROVIDER_REFERENCE_PATTERN.test(value)) {
    issues.add(
      field,
      "Must be the payment reference this platform issued, made of letters, digits, '-', '_', '.', or '~'.",
    );
  }

  return value;
}

/**
 * Parse `POST /api/v1/payments/verify` (PRD v2 §12).
 *
 * §12 allows `POST` **or** `GET` for this endpoint, and the two channels differ in
 * more than their transport: a `GET` is the provider's own redirect back to us,
 * where the reference arrives as the parameter Flutterwave appends to
 * `redirect_url`, while a `POST` is a client asking about a reference it holds.
 */
export function parseVerifyPaymentBodyRequest(body: unknown): { readonly providerReference: string } {
  const object = requireBodyObject(body);
  const issues = new IssueCollector();

  rejectUnknownFields(object, ["provider_reference", "tx_ref"], issues);

  return finishProviderReference(object, issues, "The request body failed validation.");
}

/**
 * Parse `GET /api/v1/payments/verify` query parameters.
 *
 * `tx_ref` is accepted **in addition to** `provider_reference` because it is the
 * name the provider itself uses when it redirects the attendee back to
 * `redirect_url` (see `docs/evidence/flutterwave-verify-resolution.md` §2). Accepting
 * only the PRD's name would leave the redirect channel — the one this endpoint
 * exists for — unable to find its own payment.
 *
 * When both are sent they must agree, rather than one silently winning: a URL that
 * carries two different references is a caller that does not know which payment it
 * means, and picking one for it would be a guess about money.
 */
export function parseVerifyPaymentQuery(
  searchParams: URLSearchParams,
): { readonly providerReference: string } {
  const issues = new IssueCollector();
  const object: Record<string, unknown> = {};

  for (const name of ["provider_reference", "tx_ref"]) {
    // `getAll`, not `get`: a repeated parameter would otherwise be silently resolved
    // to its first value, and a redirect naming two different payments by the same
    // parameter is a caller that does not know which one it means.
    const values = searchParams.getAll(name);

    if (values.length > 1) {
      issues.add(name, "Must be sent only once.");
      continue;
    }

    if (values.length === 1) {
      object[name] = values[0];
    }
  }

  return finishProviderReference(object, issues, "The query parameters failed validation.");
}

/**
 * A field that may be absent, but may not be anything other than a string.
 *
 * The `String(...)` coercion this replaces would have turned a JSON number like
 * `12345` into the reference `"12345"` and let it through the pattern, so a
 * client could send a number and receive a `200` for a payment it never named. A
 * value of the wrong *type* is a client mistake, so it is reported as one.
 */
function optionalString(
  object: Record<string, unknown>,
  field: string,
  issues: IssueCollector,
): string | null {
  if (!(field in object)) {
    return null;
  }

  const raw = object[field];

  if (typeof raw !== "string") {
    issues.add(field, "Must be a string.");
    return null;
  }

  return raw;
}

/**
 * Resolve `provider_reference` / `tx_ref` from either source, preferring the PRD's
 * name and requiring agreement when both are present.
 */
function finishProviderReference(
  object: Record<string, unknown>,
  issues: IssueCollector,
  message: string,
): { readonly providerReference: string } {
  const primary = optionalString(object, "provider_reference", issues);
  const alias = optionalString(object, "tx_ref", issues);

  if (primary !== null && alias !== null && primary.trim() !== alias.trim()) {
    issues.add("provider_reference", "Must match tx_ref when both are sent.");
  }

  const source =
    primary !== null
      ? { field: "provider_reference", raw: primary }
      : alias !== null
        ? { field: "tx_ref", raw: alias }
        : { field: "provider_reference", raw: null };

  const providerReference = readProviderReference(source.raw, source.field, issues);

  if (!issues.isEmpty) {
    throw new ValidationError(message, issues.toFieldIssues());
  }

  return { providerReference: providerReference as string };
}

export type { EventWriteSet };

// ---------------------------------------------------------------------------
// Staff tokens, search & check-in (PRD v2 §11, §12; the staff skill's step 3/7)
// ---------------------------------------------------------------------------

/**
 * A cap on what a *request* may carry, in the same sense as the 320-character email
 * and 64-character phone caps above: PRD §7.2 gives `StaffToken.label` a plain
 * `String` column with no limit, so this bounds the request rather than
 * transcribing a field rule. 200 matches every other organiser-authored label in
 * the system (event name, tier name), so the API has one convention.
 */
const MAX_STAFF_TOKEN_LABEL_LENGTH = 200;

/**
 * Parse `POST /api/v1/events/{id}/staff-tokens` (PRD v2 §12, §4.6.1).
 *
 * Both fields are optional in the PRD's sense — "optionally labeled" for `label`,
 * and `expires_at` has a documented default — so the accepted body is `{}`.
 *
 * `label` accepts `null` as well as being absent, and both mean the same thing: an
 * unlabelled token. Sent as `""` it is a validation error, matching how the event
 * and tier routes treat a blank required string, because an organiser who meant to
 * write "Door Team A" and submitted an empty box should hear about it rather than
 * get a working token with no name on the list.
 *
 * `expires_at` is only *shape*-checked here. Whether it is in the future depends on
 * the current time, so that is `StaffService`'s judgement, in the layer that also
 * knows the event's end date for the default (PRD §3).
 */
export function parseCreateStaffTokenRequest(body: unknown): IssueStaffTokenCommand {
  if (!isPlainObject(body)) {
    throw new ValidationError("Request body must be a JSON object.", {
      body: [
        "Send a JSON object; both label and expires_at are optional, so {} is valid.",
      ],
    });
  }

  const issues = new IssueCollector();
  rejectUnknownFields(body, ["label", "expires_at"], issues);

  const label = optionalNullableBoundedString(
    body,
    "label",
    MAX_STAFF_TOKEN_LABEL_LENGTH,
    issues,
  );
  const expiresAt = nullableIsoTimestamp(body, "expires_at", issues);

  if (!issues.isEmpty) {
    throw new ValidationError("The request body failed validation.", issues.toFieldIssues());
  }

  return { label: label ?? null, expiresAt: expiresAt ?? null };
}

/**
 * Parse `GET /api/v1/events/{id}/registrations/search` query parameters.
 *
 * `query` is required here rather than defaulted. §12 says search "additionally
 * supports `query`" and §11 sets a minimum length, so a request without one has no
 * defined meaning — and defaulting it to the empty string would then fail the
 * minimum anyway, via a message about length rather than about a missing parameter.
 *
 * An over-large `page_size` is rejected, not clamped, for consistency with the other
 * two list endpoints in this file.
 *
 * The ceiling here is 20, not rule 06's platform-wide 50: PRD §11 caps a search at
 * "20 results per request". A door list is not a report — the client renders a
 * phone-sized result list and pages through it, so a larger page buys nothing and
 * makes the one query that has a p95 budget (§18) do more work per request. Reusing
 * the shared cap of 50 would have been a silent widening of the contract.
 */
export function parseStaffSearchQuery(
  searchParams: URLSearchParams,
): PageRequest & { readonly query: string } {
  const issues = new IssueCollector();

  const pagination = parsePaginationParams(searchParams, issues, MAX_STAFF_SEARCH_PAGE_SIZE);

  const raw = searchParams.get("query");

  if (raw === null) {
    issues.add("query", "Required, and cannot be blank.");
  } else {
    const value = raw.trim();

    if (value.length < MIN_STAFF_SEARCH_QUERY_LENGTH) {
      issues.add("query", `Must be at least ${MIN_STAFF_SEARCH_QUERY_LENGTH} characters.`);
    }

    if (value.length > MAX_STAFF_SEARCH_QUERY_LENGTH) {
      issues.add("query", `Must be at most ${MAX_STAFF_SEARCH_QUERY_LENGTH} characters.`);
    }
  }

  if (!issues.isEmpty) {
    throw new ValidationError("The query parameters failed validation.", issues.toFieldIssues());
  }

  // Non-null by construction: every branch that could leave this null recorded an
  // issue above and threw.
  return { ...pagination, query: (raw as string).trim() };
}

/**
 * Parse `POST /api/v1/registrations/{id}/check-in` (PRD v2 §12).
 *
 * `override` defaults to `false`, which §12 states and which is the safe direction:
 * a repeat check-in must be a deliberate act (BR-4), so a client that omits the
 * field has not asked for one.
 *
 * Strictly typed. `"true"` is rejected rather than coerced, because the whole
 * contract of this field is that it is a *deliberate* override — a truthy string
 * silently becoming `true` is exactly the way a UI bug turns a re-click into an
 * auditable override nobody intended.
 *
 * An absent or empty body is valid, since a first check-in carries no fields. The
 * route reaches this with {@link readOptionalJsonObject} rather than
 * {@link readJsonObject}, which would reject the empty body many clients send.
 */
export function parseCheckInRequest(body: unknown): CheckInCommand {
  if (body === undefined || body === null) {
    return { override: false };
  }

  if (!isPlainObject(body)) {
    throw new ValidationError("Request body must be a JSON object when present.", {
      body: ['Send {} or { "override": true }, or no body at all.'],
    });
  }

  const issues = new IssueCollector();
  rejectUnknownFields(body, ["override"], issues);

  let override = false;

  if ("override" in body) {
    const raw = body.override;

    if (typeof raw === "boolean") {
      override = raw;
    } else {
      issues.add("override", "Must be true or false.");
    }
  }

  if (!issues.isEmpty) {
    throw new ValidationError("The request body failed validation.", issues.toFieldIssues());
  }

  return { override };
}

/**
 * Parse `GET /api/v1/events/{id}/staff-tokens` query parameters.
 *
 * Pagination only, and for the same reason the ticket-type list has none: §12 names
 * exactly two list endpoints that take an extra parameter — "search additionally
 * supports `query`; requests additionally supports `status`" — and this is neither.
 * The scoping that matters here is ownership of the event in the path, which is
 * checked server-side and cannot be widened from a query string.
 *
 * Filtering by `status` would be the obvious thing to add, and it is deliberately
 * not: the list is bounded by an organiser's own handful of door-team tokens, and
 * the `status` field on each row is already one of three readable values, so a
 * client-side filter is both sufficient and impossible to get wrong about the
 * server's own rules.
 */
export function parseListStaffTokensQuery(searchParams: URLSearchParams): PageRequest {
  const issues = new IssueCollector();

  const pagination = parsePaginationParams(searchParams, issues);

  if (!issues.isEmpty) {
    throw new ValidationError("The query parameters failed validation.", issues.toFieldIssues());
  }

  return pagination;
}

/**
 * Parse `DELETE /api/v1/events/{id}/staff-tokens?token_id=…` (PRD v2 §12, §4.6.2).
 *
 * WHY A QUERY PARAMETER, which is the one contract judgement in this file:
 *
 *   §12 gives the staff-tokens row a single path for all three methods —
 *   `POST/GET/DELETE /api/v1/events/{id}/staff-tokens` — and no `{tokenId}`
 *   segment. So `DELETE` has to name its target some other way, and there are only
 *   two candidates:
 *
 *   - **A JSON body on `DELETE`.** Legal, and routinely stripped by proxies, CDNs,
 *     and HTTP client libraries. A revocation that silently does nothing when the
 *     body is dropped is a security control that fails open in production.
 *   - **A query parameter.** Supported everywhere a `DELETE` is supported, visible
 *     in an access log next to the path it applies to, and impossible for an
 *     intermediary to drop.
 *
 * The third option — adding `/staff-tokens/{tokenId}` — is ruled out by rule 06:
 * that is a route §12 does not list, and every addition needs flagging and approval
 * first. Recorded as design position P-11 in
 * `docs/evidence/requirements-matrix.md`.
 *
 * The id is lower-cased, as everywhere else in this file, so two spellings of one
 * UUID cannot reach the database as two different strings.
 */
export function parseRevokeStaffTokenQuery(
  searchParams: URLSearchParams,
): { readonly staffTokenId: string } {
  const issues = new IssueCollector();
  const raw = searchParams.get("token_id");

  if (raw === null) {
    issues.add("token_id", "Required, and must be a UUID string.");
  } else if (!UUID_PATTERN.test(raw.trim())) {
    issues.add("token_id", "Must be a UUID, e.g. 8-4-4-4-12 hexadecimal digits.");
  }

  if (!issues.isEmpty) {
    throw new ValidationError("The query parameters failed validation.", issues.toFieldIssues());
  }

  return { staffTokenId: (raw as string).trim().toLowerCase() };
}

/**
 * A UUID taken from the request path, e.g. `POST /api/v1/registrations/{id}/check-in`.
 *
 * Path segments reach the route module as raw strings, so a malformed one has to be
 * refused here. It matters more than it looks: the check-in's guarded write compares
 * `r."id" = $1::uuid`, so a value that is not a UUID would be rejected by the *cast*
 * and surface as a `500` from the driver — the caller made a typo, and would be told
 * the server is broken. The other direction is worse: an unvalidated id reaching a
 * lookup turns "not a valid id" into "no such registration", which is the kind of
 * dressed-up `404` the same comment on {@link requireUuid} describes.
 *
 * The value is lower-cased for the same reason as everywhere else in this file, so
 * two spellings of one id cannot reach the database as two different strings.
 */
export function requirePathUuid(value: string, field: string): string {
  const trimmed = value.trim();

  if (!UUID_PATTERN.test(trimmed)) {
    throw new ValidationError("The request path failed validation.", {
      [field]: ["Must be a UUID, e.g. 8-4-4-4-12 hexadecimal digits."],
    });
  }

  return trimmed.toLowerCase();
}

/**
 * Read a JSON body that is allowed to be empty.
 *
 * `readJsonObject` rejects an empty body, which is right for every endpoint that
 * requires one and wrong for check-in, where `POST` with no body is the normal shape
 * of a first check-in. An empty or whitespace-only body becomes `{}`; anything that
 * is present but not a JSON object still fails in {@link parseCheckInRequest}.
 */
export async function readOptionalJsonObject(request: Request): Promise<unknown> {
  const text = await request.text();

  if (text.trim() === "") {
    return {};
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ValidationError("Request body must be valid JSON.", {
      body: ["The body could not be parsed as JSON."],
    });
  }
}

// ---------------------------------------------------------------------------
// Ticket evidence, attendee requests, and the organiser queue
// (PRD v2 §11, §12 rows 8, 11, 12; FR-15, FR-19, FR-23, FR-23a, FR-24)
// ---------------------------------------------------------------------------

/**
 * Parse `GET /api/v1/registrations/evidence?unique_reference=…&email=…`
 * (PRD v2 §12 row 8, FR-15).
 *
 * Both parameters are **required**, and that is the endpoint's whole design: the
 * reference is printed on the ticket, the email is what the registration was made with,
 * and neither alone is a capability (rule 08's anti-enumeration rule treats a lookup key
 * and a second factor as different things). A default for either would silently weaken
 * it, so a missing parameter is a `400` that names it.
 *
 * The reference is shape-checked with the domain's own {@link isWellFormedReference} —
 * the same predicate the generator's output is tested against — so a malformed reference
 * is refused here as a `400` instead of becoming a query against a string that could
 * never match, which is the "dressed-up 404" the `requirePathUuid` comment describes. It
 * remains a *cheap filter only*: a well-formed reference matching nothing is the
 * service's `403`, which is the same refusal a wrong email gets.
 *
 * The email goes through the same shape check as a registration's, for the same reason
 * `requireEmail` documents: this address is the second factor of a possession proof, and
 * a shape check is what a parser can honestly do.
 *
 * Duplicated parameters are rejected. `searchParams.get` returns the *first* of two
 * values, so a smuggled second value would be read by nothing and ignored — the caller
 * would believe a value they sent was checked, and it was not. The other list parsers in
 * this file take the same position for the same reason.
 */
export function parseEvidenceQuery(searchParams: URLSearchParams): {
  readonly uniqueReference: string;
  readonly email: string;
} {
  const issues = new IssueCollector();

  rejectDuplicateParams(searchParams, ["unique_reference", "email"], issues);

  const rawReference = searchParams.get("unique_reference");
  let uniqueReference: string | undefined;

  if (rawReference === null) {
    issues.add("unique_reference", "Required, and must be the reference printed on the ticket.");
  } else {
    const value = rawReference.trim();

    if (value === "") {
      issues.add("unique_reference", "Required, and cannot be blank.");
    } else if (!isWellFormedReference(value)) {
      issues.add(
        "unique_reference",
        "Must be a 40-64 character URL-safe reference, exactly as printed on the ticket.",
      );
    } else {
      uniqueReference = value;
    }
  }

  const email = requireEmailParam(searchParams, "email", issues);

  if (!issues.isEmpty) {
    throw new ValidationError("The query parameters failed validation.", issues.toFieldIssues());
  }

  return { uniqueReference: uniqueReference as string, email: email as string };
}

/**
 * Refuse a query parameter that appears more than once.
 *
 * `URLSearchParams.get` returns the first value and silently drops the rest, so a
 * duplicated parameter is a value the caller believes the server checked and did not.
 * Rejecting is the only way to keep the check's promise.
 */
function rejectDuplicateParams(
  searchParams: URLSearchParams,
  fields: readonly string[],
  issues: IssueCollector,
): void {
  for (const field of fields) {
    if (searchParams.getAll(field).length > 1) {
      issues.add(field, "Must be supplied exactly once.");
    }
  }
}

/** {@link requireEmail} for a query string, where the value is not in a body. */
function requireEmailParam(
  searchParams: URLSearchParams,
  field: string,
  issues: IssueCollector,
): string | undefined {
  const raw = searchParams.get(field);

  if (raw === null) {
    issues.add(field, "Required, and must be the email address used to register.");
    return undefined;
  }

  const value = raw.trim();

  if (value === "") {
    issues.add(field, "Required, and cannot be blank.");
    return undefined;
  }

  if (value.length > MAX_EMAIL_LENGTH) {
    issues.add(field, `Must be at most ${MAX_EMAIL_LENGTH} characters.`);
    return value;
  }

  if (!/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(value)) {
    issues.add(field, 'Must be a valid email address, e.g. "attendee@example.com".');
  }

  return value;
}

/**
 * The message and resolution-notes length cap (design position P-14).
 *
 * `attendee_requests.message` and `resolution_notes` are plain `String` columns in §7.2,
 * with no limit stated, so this is a bound on what a *request* may carry — the same
 * category as the email and phone caps above, and the same reasoning: 5000 characters is
 * far beyond an email-form field and far below anything that would make an unbounded
 * column a problem. The `message` cap matches `Event.description`'s, so the platform has
 * one convention for free-text.
 *
 * It is imported from the request domain rather than duplicated, so the bound the parser
 * enforces and the bound the service documents are one number.
 */
const MAX_ATTENDEE_REQUEST_TEXT_LENGTH = 5_000;

/**
 * Parse `POST /api/v1/registrations/{id}/requests` (PRD v2 §12 row 11, FR-23).
 *
 * The four allowed fields are §12's: `unique_reference`, `email`, `message`,
 * `idempotency_key`. The *path* supplies the registration id, and the body re-supplies
 * the reference and email that prove the caller owns it — the redundancy is the contract,
 * and it is what lets the endpoint be stateless about the attendee (PRD §3: no account).
 *
 * `idempotency_key` is a client-generated UUID for the same reason the registration's is
 * (FR-10a): a debounced double-submit (FR-23a) must produce one request, not two, and
 * only a client-stable key can do that across two requests.
 *
 * `message` must be a non-blank string. A request with no message is a request the
 * organiser cannot act on, and §12 lists it as required.
 */
export function parseSubmitAttendeeRequestRequest(
  body: unknown,
  registrationId: string,
): SubmitAttendeeRequestCommand {
  const object = requireBodyObject(body);
  const issues = new IssueCollector();

  rejectUnknownFields(
    object,
    ["unique_reference", "email", "message", "idempotency_key"],
    issues,
  );

  const rawReference = object.unique_reference;
  let uniqueReference: string | undefined;

  if (typeof rawReference !== "string") {
    issues.add("unique_reference", "Required, and must be the reference printed on the ticket.");
  } else {
    const value = rawReference.trim();

    if (value === "") {
      issues.add("unique_reference", "Required, and cannot be blank.");
    } else if (!isWellFormedReference(value)) {
      issues.add(
        "unique_reference",
        "Must be a 40-64 character URL-safe reference, exactly as printed on the ticket.",
      );
    } else {
      uniqueReference = value;
    }
  }

  const email = requireEmail(object, "email", issues);
  const message = requireBoundedString(object, "message", MAX_ATTENDEE_REQUEST_TEXT_LENGTH, issues);
  const idempotencyKey = requireUuid(object, "idempotency_key", issues);

  if (!issues.isEmpty) {
    throw new ValidationError("The request body failed validation.", issues.toFieldIssues());
  }

  return {
    registrationId,
    uniqueReference: uniqueReference as string,
    attendeeEmail: email as string,
    message,
    idempotencyKey: idempotencyKey as string,
  };
}

/**
 * Parse `GET /api/v1/events/{id}/requests` query parameters (PRD v2 §12 row 12).
 *
 * Pagination plus the `status` filter §12 grants this endpoint specifically ("requests
 * additionally supports `status`") — the same phrase that keeps `page`/`page_size` off
 * the ticket-type list, applied the other way round.
 *
 * The filter is a *filter*, so the unfiltered total is what `total` reports only when no
 * filter is given: with `status=open`, `total` counts open requests, because rule 06
 * requires `total` to be the count of the filtered set. The parser therefore returns
 * `null` for "no filter" rather than defaulting to a status, which would silently hide
 * resolved requests from a client that asked for everything.
 *
 * An unrecognised status is a `400` rather than an empty page: `status=resolvedd` is a
 * typo, and answering it with "no requests" would read to the organiser as "all my
 * requests are answered", which is the opposite of the truth.
 */
export function parseListAttendeeRequestsQuery(searchParams: URLSearchParams): PageRequest & {
  readonly status: AttendeeRequestStatus | null;
} {
  const issues = new IssueCollector();

  const pagination = parsePaginationParams(searchParams, issues);

  const rawStatus = searchParams.get("status");
  let status: AttendeeRequestStatus | null = null;

  if (rawStatus !== null) {
    if (isAttendeeRequestStatus(rawStatus)) {
      status = rawStatus;
    } else {
      issues.add("status", 'Must be one of "open", "resolved".');
    }
  }

  if (!issues.isEmpty) {
    throw new ValidationError("The query parameters failed validation.", issues.toFieldIssues());
  }

  return { ...pagination, status };
}

/**
 * Parse `PATCH /api/v1/events/{id}/requests/{request_id}` (PRD v2 §12 row 12, FR-24,
 * R-5 G-3).
 *
 * Both fields are optional, because §12's `PATCH` is a partial update and the two do
 * different jobs: `status: "resolved"` is the lifecycle transition, `resolution_notes` is
 * the text. Either alone is meaningful, and both together is the ordinary resolution.
 *
 * Two checks are deliberately *not* made here:
 *
 *   - `resolution_notes` may be `null`/absent on a **resolve**, which §12 and the
 *     service reject with a field-level `400` — but that depends on `status`, and whether
 *     a resolution is meaningful is a rule about the command, not the shape of a string.
 *     `RequestService` decides it, in the layer that holds the stored state.
 *   - an **empty** body (`{}`) is likewise refused by the service, not here, for the same
 *     reason: "no fields" is a statement about the command rather than about a field's
 *     type, and the service is where the lifecycle lives.
 *
 * `status: "open"` **is** accepted here and means nothing harmful: a `PATCH` that asks
 * for a status the request already has is a no-op, and the service folds it into "leave
 * the status alone" rather than attempting a backward transition. A reopen of a
 * *resolved* request is rejected by the service with the retained resolution, which is
 * the answer §14's terminal-state rule requires.
 */
export function parseResolveAttendeeRequestRequest(body: unknown): ResolveAttendeeRequestCommand {
  const object = requireBodyObject(body);
  const issues = new IssueCollector();

  rejectUnknownFields(object, ["status", "resolution_notes"], issues);

  let status: AttendeeRequestStatus | undefined;

  if ("status" in object) {
    const raw = object.status;

    if (typeof raw !== "string") {
      issues.add("status", 'Must be one of "open", "resolved".');
    } else if (!isAttendeeRequestStatus(raw)) {
      issues.add("status", 'Must be one of "open", "resolved".');
    } else {
      status = raw;
    }
  }

  const resolutionNotes = optionalNullableBoundedString(
    object,
    "resolution_notes",
    MAX_ATTENDEE_REQUEST_TEXT_LENGTH,
    issues,
  );

  if (!issues.isEmpty) {
    throw new ValidationError("The request body failed validation.", issues.toFieldIssues());
  }

  return {
    ...(status === undefined ? {} : { status }),
    ...(resolutionNotes === undefined || resolutionNotes === null
      ? {}
      : { resolutionNotes }),
  };
}

/**
 * Event domain types (PRD v2 §7.2).
 *
 * Framework- and database-agnostic: these are plain shapes, not Prisma models.
 * The persistence adapter maps `Prisma.EventModel` onto these so that the
 * domain never imports the generated client.
 *
 * Lifecycle rules for `status` are in `EVENT_STATUS_TRANSITIONS` below, which
 * records a product-owner decision rather than a PRD transcription — see its
 * comment. `POST`, `PATCH`, `DELETE`, and the programme routes added on
 * 2026-09-26 are implemented in this file's companion modules.
 */

export const EVENT_STATUSES = ["draft", "published", "closed"] as const;

export type EventStatus = (typeof EVENT_STATUSES)[number];

/**
 * Legal `status` transitions — product-owner decision R-3 (2026-09-26).
 *
 * NOT derivable from PRD v2. FR-1 (L100) names the three status *values* and
 * §7.2 (L185) supplies the `draft` default, but §9 defines lifecycles for
 * Payment, Registration, Ticket Availability, and Check-in only — there is no
 * Event lifecycle, so `.agents/rules/03` had no contract to apply.
 *
 * Approved shape: forward-only, and `closed` is terminal. Unpublishing
 * (`published -> draft`) and re-opening (`closed -> published`) are both
 * forbidden: attendees who have already paid hold a claim to a listing that must
 * not be retractable after the fact, which is the same reasoning as §9.2 having no
 * backward transitions. `closed` is terminal because a shut event has nothing to
 * re-open.
 */
export const EVENT_STATUS_TRANSITIONS: Readonly<
  Record<EventStatus, readonly EventStatus[]>
> = {
  draft: ["published", "closed"],
  published: ["closed"],
  closed: [],
};

export function isEventStatusTransitionAllowed(from: EventStatus, to: EventStatus): boolean {
  return EVENT_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * Event fields whose changes are recorded in `EventEditLog` (decision D6).
 *
 * Every field an organiser can change is included, plus `status` and the
 * `deleted_at` stamp — a soft delete of a published event *is* a change to a
 * published event, and §14's audit purpose plainly covers hiding one.
 *
 * System bookkeeping is excluded: `id` and `slug` are never client-writable, and
 * `created_at`/`updated_at` are excluded because `updated_at` moves on every
 * write, so logging it would record every request — including the no-op writes
 * D6 explicitly says not to log.
 */
export const AUDITED_EVENT_FIELDS = [
  "name",
  "description",
  "startsAt",
  "endsAt",
  "venue",
  "status",
  "deletedAt",
] as const;

export type AuditedEventField = (typeof AUDITED_EVENT_FIELDS)[number];

/**
 * One field's before and after value.
 *
 * BR-6 (L158) requires answering "why did this change", so both sides are
 * stored: a list of touched field names cannot answer it. Timestamps render as
 * ISO-8601 strings and a `null` date stays `null`.
 */
export interface EventFieldChange {
  readonly from: string | null;
  readonly to: string | null;
}

/**
 * Wire spelling of each audited field, used as the `changes` object key.
 *
 * The audit trail is read by humans against PRD §7.2, so it stores `starts_at`
 * rather than the domain's `startsAt`. Keeping the map in the domain (rather than
 * building keys ad hoc in the service) is what lets `EventChangeSet` be typed by
 * what is actually written.
 */
export const AUDITED_EVENT_FIELD_KEYS = {
  name: "name",
  description: "description",
  startsAt: "starts_at",
  endsAt: "ends_at",
  venue: "venue",
  status: "status",
  deletedAt: "deleted_at",
} as const satisfies Readonly<Record<AuditedEventField, string>>;

export type AuditedEventFieldKey =
  (typeof AUDITED_EVENT_FIELD_KEYS)[AuditedEventField];

export type EventChangeSet = Readonly<
  Partial<Record<AuditedEventFieldKey, EventFieldChange>>
>;

export function isEventStatus(value: unknown): value is EventStatus {
  return typeof value === "string" && (EVENT_STATUSES as readonly string[]).includes(value);
}

export interface EventRecord {
  readonly id: string;
  readonly organiserId: string;
  readonly name: string;
  readonly slug: string;
  /** Optional (product-owner decision 4, 2026-09-26): an event may have no blurb. */
  readonly description: string | null;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly venue: string;
  readonly status: EventStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** Soft delete (§14). `null` for a live event. */
  readonly deletedAt: Date | null;
}

export interface ProgrammeItemRecord {
  readonly id: string;
  readonly eventId: string;
  readonly sortOrder: number;
  /** Nullable per the approved schema decision: an item may have no fixed time. */
  readonly time: Date | null;
  readonly title: string;
  readonly description: string | null;
}

/**
 * One ticket tier (PRD v2 §7.2 `TicketType`).
 *
 * Carries MORE than the public `TicketTypeSummaryDTO` exposes, and that gap is
 * the point: the two counters are real, load-bearing state (BR-3) that the public
 * projection deliberately withholds (PRD §13, rule 06). `description`,
 * `created_at`, and `updated_at` were added with the organiser-facing slice
 * (2026-09-26); the public mapper in `event.dto.ts` predates them and must keep
 * ignoring them, which is why the record is not `Pick`-ed into either DTO.
 */
export interface TicketTypeRecord {
  readonly id: string;
  readonly eventId: string;
  readonly name: string;
  readonly description: string | null;
  readonly priceMinorUnits: number;
  readonly currency: string;
  readonly quantityTotal: number;
  readonly quantityConfirmed: number;
  readonly quantityHeld: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * One immutable audit row: who changed a published event, when, and exactly what
 * moved from what to what (PRD v2 §14 L420, §20 L501, BR-6 L158).
 *
 * Append-only. Nothing in the application updates or deletes one, and the
 * database rejects both.
 */
export interface EventEditLogRecord {
  readonly id: string;
  readonly eventId: string;
  readonly organiserId: string;
  readonly changedAt: Date;
  readonly changes: EventChangeSet;
}

/**
 * Everything a public event page needs, in one aggregate.
 *
 * Only `published`, non-deleted events are ever loaded into this shape — the
 * filter lives in the repository query and is re-asserted by the service.
 */
export interface PublicEventAggregate {
  readonly event: EventRecord;
  readonly programme: readonly ProgrammeItemRecord[];
  readonly ticketTypes: readonly TicketTypeRecord[];
}

/** Validated, domain-level input for creating an event. */
export interface CreateEventCommand {
  readonly name: string;
  /** Optional (decision 4); `null` and `""` both mean "no description". */
  readonly description: string | null;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly venue: string;
}

/**
 * Validated, domain-level input for updating an event.
 *
 * Every field is optional because a PATCH carries only what changes.
 * `status` rides on this same command: decision D2 puts the lifecycle transition
 * on `PATCH /api/v1/events/{id}` rather than on separate publish/close routes.
 * An absent field means "leave alone"; `name`/`venue`/`startsAt`/`endsAt` cannot
 * be nulled, but an explicit `description: null` clears the blurb.
 */
export interface UpdateEventCommand {
  readonly name?: string;
  readonly description?: string | null;
  readonly startsAt?: Date;
  readonly endsAt?: Date;
  readonly venue?: string;
  readonly status?: EventStatus;
}

/**
 * The columns a PATCH is allowed to write.
 *
 * Deliberately mutable and deliberately *not* `Pick<EventRecord, …>`: this is a
 * sparse set of proposed values, not a record, and the merge against the stored
 * row happens in the service.
 */
export interface EventWriteSet {
  name?: string;
  description?: string | null;
  startsAt?: Date;
  endsAt?: Date;
  venue?: string;
  status?: EventStatus;
}

/**
 * A programme line, as authored (PRD v2 FR-2).
 *
 * `sortOrder` is an explicit stored integer supplied by the organiser: FR-2
 * requires the order to be *stored*, never inferred, so the service does not
 * renumber or re-sort behind the client's back. The `(event_id, sort_order)`
 * index is deliberately NOT unique, so a caller may reorder by rewriting the
 * integers.
 */
export interface ProgrammeItemInput {
  readonly sortOrder: number;
  readonly time: Date | null;
  readonly title: string;
  readonly description: string | null;
}

/**
 * A sparse edit to an existing programme line.
 *
 * `null` and "absent" mean different things on purpose: absent leaves the column
 * alone, an explicit `null` clears it. That is what makes `time` and
 * `description` (both nullable) settable back to empty.
 */
export interface ProgrammeItemPatch {
  readonly sortOrder?: number;
  readonly time?: Date | null;
  readonly title?: string;
  readonly description?: string | null;
}

/** Paged request, already bounds-checked (`.agents/rules/06` pagination contract). */
export interface PageRequest {
  readonly page: number;
  readonly pageSize: number;
}

/** A page of results plus the count of the whole *filtered* set, not the table. */
export interface PagedResult<T> {
  readonly items: readonly T[];
  readonly total: number;
}

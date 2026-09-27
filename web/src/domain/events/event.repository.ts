/**
 * Persistence port for events.
 *
 * The domain declares the interface it needs; `src/server/db` supplies the
 * Prisma implementation. That inversion is what lets every business rule be
 * unit-tested with an in-memory fake and no database (AGENTS.md §4).
 */

import type {
  CreateEventCommand,
  EventChangeSet,
  EventRecord,
  EventStatus,
  EventWriteSet,
  PagedResult,
  PageRequest,
  ProgrammeItemInput,
  ProgrammeItemRecord,
  PublicEventAggregate,
} from "./event";

export interface CreateEventRecord {
  readonly organiserId: string;
  readonly slug: string;
  readonly command: CreateEventCommand;
}

/** The subset of event columns a PATCH may write. */
export interface UpdateEventRecord {
  readonly id: string;
  readonly changes: EventWriteSet;
}

export interface ListEventsQuery extends PageRequest {
  readonly organiserId: string;
  /** Optional filter, served by the `(organiser_id, status)` index from §7.2. */
  readonly status?: EventStatus;
}

export interface AppendEditLogRecord {
  readonly eventId: string;
  readonly organiserId: string;
  readonly changes: EventChangeSet;
}

export interface EventRepository {
  /**
   * Run `work` against a handle bound to a single database transaction, and
   * return its result. If `work` throws, every write made through the handle is
   * rolled back.
   *
   * This exists for product-owner decision 7 (2026-09-26): editing an event and
   * appending its audit row are one fact and must land together. Before this,
   * `updateEvent` and `appendEditLog` were two independent statements, so an
   * audit failure left a mutated event with no record of the change — exactly the
   * silent-edit failure §14 exists to prevent.
   *
   * The handle passed to `work` is itself an `EventRepository`, and `transact` is
   * available on it too, so nesting is well defined rather than a special case.
   * Because the handle is a real transaction scope, the *reads* the service
   * performs inside `work` — ownership, lifecycle, the no-op diff — are covered
   * by the same atomicity as the writes. That is what closes the
   * check-then-write gap in the soft-delete path: a concurrent delete can no
   * longer land between the "is this editable?" read and the write.
   *
   * Implementations must not commit early, and must not catch-and-swallow.
   */
  transact<T>(work: (repository: EventRepository) => Promise<T>): Promise<T>;

  /**
   * Insert a new event.
   *
   * Implementations must surface a unique-constraint violation on `slug` as a
   * domain `ConflictError`; the service relies on that to answer `409` even
   * though slug collision is normally pre-empted.
   */
  createEvent(input: CreateEventRecord): Promise<EventRecord>;

  /** `true` when an event already uses this slug (including soft-deleted rows). */
  slugExists(slug: string): Promise<boolean>;

  /**
   * Load the public projection for a slug.
   *
   * MUST return `null` for any event that is not `published`, or that is
   * soft-deleted — including `draft` and `closed`. The service re-asserts this
   * so the rule holds even if a future query forgets the filter.
   */
  findPublicEventBySlug(slug: string): Promise<PublicEventAggregate | null>;

  /**
   * Load one event by id, regardless of owner.
   *
   * Deliberately *not* scoped by organiser: the service has to tell "no such
   * event" (`404`) apart from "not yours" (`403`), because `.agents/rules/06`
   * assigns those two codes different meanings. The service performs the
   * ownership comparison and never returns a non-owned row to a caller.
   */
  findEventById(id: string): Promise<EventRecord | null>;

  /**
   * Apply a partial update and return the stored result.
   *
   * `updated_at` is advanced by the implementation. Implementations must NOT
   * write a row that is soft-deleted — the service checks that first, so a
   * deleted event cannot be edited back into existence through a PATCH.
   */
  updateEvent(input: UpdateEventRecord): Promise<EventRecord>;

  /**
   * Stamp `deleted_at` (PRD v2 §14 L421: soft delete, never hard delete).
   *
   * Idempotent: deleting an already-deleted event returns it unchanged rather
   * than failing, so a repeated `DELETE` is not an error.
   */
  softDeleteEvent(id: string, deletedAt: Date): Promise<EventRecord>;

  /** One page of the caller's own events, newest first, plus the filtered total. */
  listEvents(query: ListEventsQuery): Promise<PagedResult<EventRecord>>;

  /**
   * Append one audit row. Never updated, never deleted.
   *
   * `changes` must be non-empty; the database CHECK rejects an empty object, and
   * the service declines to call this for a no-op write.
   */
  appendEditLog(input: AppendEditLogRecord): Promise<void>;

  /** An event's programme in stored `sort_order`, for the organiser's own view. */
  listProgrammeItems(eventId: string): Promise<readonly ProgrammeItemRecord[]>;

  createProgrammeItem(eventId: string, input: ProgrammeItemInput): Promise<ProgrammeItemRecord>;

  updateProgrammeItem(
    itemId: string,
    input: ProgrammeItemInput,
  ): Promise<ProgrammeItemRecord>;

  /**
   * Remove one programme line.
   *
   * `ProgrammeItem.event_id` is `CASCADE`, so a hard-deleted *event* takes its
   * programme with it. This method is the deliberate exception used by
   * `DELETE /api/v1/events/{id}/programme/{item_id}`; deleting a single line is
   * not an audit-traded fact, unlike the event itself.
   */
  deleteProgrammeItem(itemId: string): Promise<void>;
}

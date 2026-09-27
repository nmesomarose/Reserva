/**
 * Event business rules (PRD v2 FR-1, FR-2, §12).
 *
 * This is the only layer allowed to decide what "creating an event" means
 * (AGENTS.md §4). Route handlers parse a request, call one of these methods,
 * and translate the result — they contain no rules of their own.
 *
 * Scope note: the routes implemented here are the ones approved for this slice on
 * 2026-09-26 — `POST /api/v1/events`, `GET /api/v1/events`,
 * `PATCH`/`DELETE /api/v1/events/{id}`, and the programme routes. PRD v2 §12
 * originally listed only the first and the public read, so §12 itself is the
 * product-owner decision recorded in `.agents/rules/03` "Resolved
 * product-owner decisions" (R-3) and the skill's "Resolved decisions" section.
 */

import {
  ConflictError,
  IllegalTransitionError,
  NotFoundError,
  ValidationError,
} from "../errors";
import {
  AUDITED_EVENT_FIELD_KEYS,
  AUDITED_EVENT_FIELDS,
  EVENT_STATUS_TRANSITIONS,
  isEventStatusTransitionAllowed,
  type AuditedEventField,
  type CreateEventCommand,
  type EventChangeSet,
  type EventFieldChange,
  type EventRecord,
  type EventStatus,
  type EventWriteSet,
  type PageRequest,
  type ProgrammeItemInput,
  type ProgrammeItemPatch,
  type ProgrammeItemRecord,
  type PublicEventAggregate,
  type UpdateEventCommand,
} from "./event";
import { requireOrganiserId, requireOwnedEvent } from "./event-ownership";
import {
  toOrganiserEventDTO,
  toOrganiserProgrammeItemDTO,
  toPublicProgrammeItemDTO,
  toTicketTypeSummaryDTO,
  type OrganiserEventDTO,
  type OrganiserProgrammeItemDTO,
  type PaginatedResponse,
  type PublicEventDTO,
} from "./event.dto";
import type { EventRepository } from "./event.repository";
import { MAX_SLUG_LENGTH, randomSlugCandidate, slugCandidates, slugify } from "./slug";

/**
 * Shown instead of a real "no such event" for every lookup miss.
 *
 * One constant for every failure mode so a caller cannot tell a missing slug
 * from a draft, a closed, or a soft-deleted event (PRD v2 §12 security rules on
 * enumeration).
 */
const EVENT_NOT_FOUND_MESSAGE = "No published event exists for this slug.";

/** Render an auditable value for storage in `changes`. */
function renderAuditedValue(field: AuditedEventField, event: EventRecord): string | null {
  const value = event[field];

  if (value === null) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : String(value);
}

export class EventService {
  constructor(private readonly repository: EventRepository) {}

  /**
   * Create an event on behalf of an authenticated organiser (PRD v2 FR-1).
   *
   * The organiser identity is a *parameter derived from the server-side auth
   * context* — never from the request body — so one organiser can never create
   * an event owned by another (PRD v2 §3).
   *
   * New events are always `draft`: the column default applies and the client
   * cannot set a status, because PRD v2 §12's request fields do not include one
   * and there is no publish endpoint in the contract.
   */
  async createEvent(
    organiserId: string,
    command: CreateEventCommand,
  ): Promise<OrganiserEventDTO> {
    this.requireOrganiserId(organiserId);

    const base = slugify(command.name);
    if (base === "") {
      throw new ValidationError(
        "The event name cannot be turned into a URL slug.",
        {
          name: [
            "Use at least one letter or digit (a-z, 0-9) so the event gets a public URL.",
          ],
        },
      );
    }

    const slug = await this.allocateSlug(base);

    return toOrganiserEventDTO(
      await this.repository.createEvent({ organiserId, slug, command }),
    );
  }

  /**
   * Public event page projection (PRD v2 FR-2, §13).
   *
   * Throws `NotFoundError` for anything not publicly visible, which the HTTP
   * layer renders as `404`.
   */
  async getPublicEvent(slug: string): Promise<PublicEventDTO> {
    const aggregate = await this.repository.findPublicEventBySlug(slug);

    if (aggregate === null || !this.isPubliclyVisible(aggregate)) {
      throw new NotFoundError(EVENT_NOT_FOUND_MESSAGE);
    }

    return this.toPublicDTO(aggregate);
  }

  /**
   * List the caller's own events, paginated (`.agents/rules/06` envelope).
   *
   * Soft-deleted events are excluded by the repository: a deleted event is not
   * part of the organiser's working set. An empty page is a `200` with no rows.
   */
  async listEvents(
    organiserId: string,
    request: PageRequest & { readonly status?: EventStatus },
  ): Promise<PaginatedResponse<OrganiserEventDTO>> {
    this.requireOrganiserId(organiserId);

    const result = await this.repository.listEvents({ ...request, organiserId });

    return {
      data: result.items.map(toOrganiserEventDTO),
      page: request.page,
      page_size: request.pageSize,
      total: result.total,
    };
  }

  /**
   * Apply a partial update to an owned event (PRD v2 FR-4: edits both before and
   * after publication; §12 `PATCH /api/v1/events/{id}`).
   *
   * A field that is absent from the command is left untouched; a field that is
   * present but identical to the stored value is *also* left untouched and is
   * not recorded — decision D6 logs only what actually changed, so a repeated
   * identical PATCH is a genuine no-op with no `updated_at` bump and no audit
   * row.
   *
   * A `status` in the command is a lifecycle transition, not a field assignment,
   * so it is checked against `EVENT_STATUS_TRANSITIONS` and answered with `409`
   * when it is not legal from the current state.
   *
   * ATOMICITY (product-owner decision 7, 2026-09-26): the ownership read, the
   * lifecycle and no-op checks, the write, and the audit append are one unit of
   * work. Two things depend on the *reads* being inside it and not merely the two
   * writes:
   *
   *   - a concurrent delete can no longer land between "is this editable?" and
   *     the write, so a PATCH cannot resurrect or edit a row someone just deleted;
   *   - a failed audit append rolls the mutation back, so there is no state in
   *     which an event changed without an `EventEditLog` row describing it.
   */
  async updateEvent(
    organiserId: string,
    eventId: string,
    command: UpdateEventCommand,
  ): Promise<OrganiserEventDTO> {
    this.requireOrganiserId(organiserId);

    return this.repository.transact(async (tx) => {
      const existing = await this.requireOwnedEvent(organiserId, eventId, tx);

      if (existing.deletedAt !== null) {
        // A soft-deleted event is not resettable through a PATCH: the only way
        // back would be a hard delete, and §14 forbids that once money is involved.
        throw new ConflictError("This event has been deleted and can no longer be edited.");
      }

      const changes = this.diffForWrite(existing, command);

      if (Object.keys(changes).length === 0) {
        return toOrganiserEventDTO(existing);
      }

      // Cross-field validity depends on the *merged* row: a PATCH that only moves
      // `ends_at` cannot be judged until it is compared with the stored
      // `starts_at`, which the request never mentions. Doing this here rather than
      // in the request parser is the whole reason the service owns business rules.
      const mergedStartsAt = command.startsAt ?? existing.startsAt;
      const mergedEndsAt = command.endsAt ?? existing.endsAt;

      if (mergedEndsAt.getTime() <= mergedStartsAt.getTime()) {
        throw new ValidationError("The request body failed validation.", {
          ends_at: ["Must be after the event's start time."],
        });
      }

      if (command.status !== undefined && command.status !== existing.status) {
        this.assertStatusTransitionAllowed(existing.status, command.status);
      }

      const updated = await tx.updateEvent({ id: eventId, changes });

      await this.auditIfPublished(existing, updated, organiserId, tx);

      return toOrganiserEventDTO(updated);
    });
  }

  /**
   * Soft-delete an owned event (PRD v2 §14 L421).
   *
   * Sets `deleted_at`; never removes the row. Idempotent, because a second
   * `DELETE` on an already-deleted event is not a client error — the desired
   * state already holds. The public route excludes soft-deleted events, so the
   * event disappears from `GET /api/v1/events/{slug}` immediately.
   *
   * Transactional for the same reason as `updateEvent` (decision 7): the delete
   * and its audit row are one fact.
   */
  async softDeleteEvent(organiserId: string, eventId: string): Promise<OrganiserEventDTO> {
    this.requireOrganiserId(organiserId);

    return this.repository.transact(async (tx) => {
      const existing = await this.requireOwnedEvent(organiserId, eventId, tx);

      if (existing.deletedAt !== null) {
        return toOrganiserEventDTO(existing);
      }

      const deleted = await tx.softDeleteEvent(eventId, new Date());

      // Recorded through the same path as an edit: hiding a published event is a
      // change to a published event, and §20 L501's auditability requirement is
      // about exactly that.
      await this.auditIfPublished(existing, deleted, organiserId, tx);

      return toOrganiserEventDTO(deleted);
    });
  }

  /** The organiser's ordered programme for an owned event (PRD v2 FR-2). */
  async listProgramme(
    organiserId: string,
    eventId: string,
  ): Promise<readonly OrganiserProgrammeItemDTO[]> {
    await this.requireOwnedEvent(organiserId, eventId);

    const items = await this.repository.listProgrammeItems(eventId);

    return [...items]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(toOrganiserProgrammeItemDTO);
  }

  /** Append a programme line to an owned event (PRD v2 FR-2). */
  async addProgrammeItem(
    organiserId: string,
    eventId: string,
    input: ProgrammeItemInput,
  ): Promise<OrganiserProgrammeItemDTO> {
    await this.requireOwnedEvent(organiserId, eventId);

    return toOrganiserProgrammeItemDTO(
      await this.repository.createProgrammeItem(eventId, input),
    );
  }

  /**
   * Merge a sparse edit into one programme line.
   *
   * The line is looked up *through the owned event* rather than by id alone, so a
   * valid `item_id` belonging to somebody else's event is a miss rather than a
   * cross-event write.
   *
   * The merge happens here, not in the route and not in the adapter: an absent key
   * means "leave alone" and an explicit `null` means "clear", and only the
   * business layer holds the stored row needed to tell those apart.
   */
  async patchProgrammeItem(
    organiserId: string,
    eventId: string,
    itemId: string,
    patch: ProgrammeItemPatch,
  ): Promise<OrganiserProgrammeItemDTO> {
    const item = await this.requireOwnedProgrammeItem(organiserId, eventId, itemId);

    const merged: ProgrammeItemInput = {
      sortOrder: patch.sortOrder ?? item.sortOrder,
      time: patch.time === undefined ? item.time : patch.time,
      title: patch.title ?? item.title,
      description: patch.description === undefined ? item.description : patch.description,
    };

    return toOrganiserProgrammeItemDTO(
      await this.repository.updateProgrammeItem(item.id, merged),
    );
  }

  /** Remove one programme line from an owned event. */
  async removeProgrammeItem(
    organiserId: string,
    eventId: string,
    itemId: string,
  ): Promise<void> {
    const item = await this.requireOwnedProgrammeItem(organiserId, eventId, itemId);

    await this.repository.deleteProgrammeItem(item.id);
  }

  /**
   * Reject an identity the auth boundary should never produce.
   *
   * Delegates to the shared guard in `event-ownership.ts`, which the TicketType
   * slice uses too, so the two cannot drift on what counts as an organiser.
   */
  private requireOrganiserId(organiserId: string): void {
    requireOrganiserId(organiserId);
  }

  /**
   * Load an event the caller owns, or fail.
   *
   * `repository` defaults to the service's own handle and is passed explicitly
   * by the callers that already hold a transaction scope (decision 7), so this
   * ownership read lands in the same transaction as the write it guards.
   */
  private async requireOwnedEvent(
    organiserId: string,
    eventId: string,
    repository: EventRepository = this.repository,
  ): Promise<EventRecord> {
    return requireOwnedEvent(repository, organiserId, eventId);
  }

  /**
   * Resolve a programme line that belongs to an event the caller owns.
   *
   * Reading the event's items and matching locally — rather than deleting or
   * updating by `item_id` directly — is what makes a foreign `item_id` a `404`
   * instead of a cross-event mutation.
   */
  private async requireOwnedProgrammeItem(
    organiserId: string,
    eventId: string,
    itemId: string,
  ): Promise<ProgrammeItemRecord> {
    await this.requireOwnedEvent(organiserId, eventId);

    const item = (await this.repository.listProgrammeItems(eventId)).find(
      (candidate) => candidate.id === itemId,
    );

    if (item === undefined) {
      throw new NotFoundError("No such programme item exists on this event.");
    }

    return item;
  }

  /**
   * The write set for a PATCH: only fields the caller supplied *and* that
   * actually differ from the stored row.
   *
   * Filtering out no-op assignments here is what lets D6's "log only what
   * changed" be honoured downstream, and it keeps `updated_at` meaningful.
   */
  private diffForWrite(existing: EventRecord, command: UpdateEventCommand): EventWriteSet {
    const changes: EventWriteSet = {};

    if (command.name !== undefined && command.name !== existing.name) {
      changes.name = command.name;
    }
    if (command.description !== undefined && command.description !== existing.description) {
      changes.description = command.description;
    }
    if (command.startsAt !== undefined && command.startsAt.getTime() !== existing.startsAt.getTime()) {
      changes.startsAt = command.startsAt;
    }
    if (command.endsAt !== undefined && command.endsAt.getTime() !== existing.endsAt.getTime()) {
      changes.endsAt = command.endsAt;
    }
    if (command.venue !== undefined && command.venue !== existing.venue) {
      changes.venue = command.venue;
    }
    if (command.status !== undefined && command.status !== existing.status) {
      changes.status = command.status;
    }

    return changes;
  }

  /** Reject a status change that is not in the approved transition table. */
  private assertStatusTransitionAllowed(from: EventStatus, to: EventStatus): void {
    if (isEventStatusTransitionAllowed(from, to)) {
      return;
    }

    const legal =
      from === to
        ? "no change"
        : EVENT_STATUS_TRANSITIONS[from].length === 0
          ? `${from} is terminal and has no onward transitions`
          : EVENT_STATUS_TRANSITIONS[from].join(", ");

    throw new IllegalTransitionError(
      `An event cannot move from ${from} to ${to}; legal targets are ${legal}.`,
    );
  }

  /**
   * Append an audit row when — and only when — the event was `published` at the
   * time of the request (decision D6).
   *
   * The check is against the row as it was *read*, before the write, so the
   * answer does not depend on how a database happens to order statements within
   * the request. A `draft -> published` PATCH therefore logs nothing (it was not
   * published while the edit was requested) and a `published -> closed` PATCH
   * does (it was).
   *
   * Drafts are deliberately unlogged: §14 L420 scopes the requirement to edits of
   * *published* events, and logging every keystroke on an unpublished event would
   * bury the rows that matter.
   *
   * `repository` is the caller's transaction handle (decision 7) so the append
   * commits or rolls back together with the mutation it describes.
   */
  private async auditIfPublished(
    before: EventRecord,
    after: EventRecord,
    organiserId: string,
    repository: EventRepository,
  ): Promise<void> {
    if (before.status !== "published") {
      return;
    }

    const changes = this.diffForAudit(before, after);

    if (Object.keys(changes).length === 0) {
      return;
    }

    await repository.appendEditLog({ eventId: after.id, organiserId, changes });
  }

  /**
   * Before/after for every audited field that moved.
   *
   * Both sides are recorded because BR-6 (L158) requires answering "why did this
   * change": a list of field names cannot distinguish a venue rename from a date
   * moved by a month. Keys use the PRD's wire spelling (`starts_at`, not
   * `startsAt`) so the log is readable against §7.2.
   */
  private diffForAudit(before: EventRecord, after: EventRecord): EventChangeSet {
    const changes: Record<string, EventFieldChange> = {};

    for (const field of AUDITED_EVENT_FIELDS) {
      const from = renderAuditedValue(field, before);
      const to = renderAuditedValue(field, after);

      if (from !== to) {
        changes[AUDITED_EVENT_FIELD_KEYS[field]] = { from, to };
      }
    }

    return changes as EventChangeSet;
  }

  /**
   * Defence in depth: the repository query already filters, but visibility is a
   * business rule, so the service refuses to serialise an event it would not
   * show even if a query regressed.
   */
  private isPubliclyVisible(aggregate: PublicEventAggregate): boolean {
    return aggregate.event.status === "published" && aggregate.event.deletedAt === null;
  }

  private toPublicDTO(aggregate: PublicEventAggregate): PublicEventDTO {
    const { event } = aggregate;

    return {
      name: event.name,
      slug: event.slug,
      description: event.description,
      starts_at: event.startsAt.toISOString(),
      ends_at: event.endsAt.toISOString(),
      venue: event.venue,
      // Programme is authored as an ordered list, so the order is the contract,
      // not a sort the client should have to re-derive.
      programme: [...aggregate.programme]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map(toPublicProgrammeItemDTO),
      ticket_types: aggregate.ticketTypes.map(toTicketTypeSummaryDTO),
    };
  }

  /**
   * First free candidate, then a random-token fallback (decision 3).
   *
   * A collision is never surfaced: the loop always terminates in a free slug. The
   * service still asserts the length bound, because this is the last place that
   * can be sure the value is in range before it becomes a database write — and
   * `events_slug_length_check` would otherwise turn a logic error here into an
   * opaque 500.
   */
  private async allocateSlug(base: string): Promise<string> {
    for (const candidate of slugCandidates(base)) {
      if (!(await this.repository.slugExists(candidate))) {
        return this.assertSlugWithinLimit(candidate);
      }
    }

    return this.assertSlugWithinLimit(randomSlugCandidate(base));
  }

  private assertSlugWithinLimit(slug: string): string {
    if (slug.length === 0 || slug.length > MAX_SLUG_LENGTH) {
      throw new ValidationError("The event name cannot produce a usable URL slug.", {
        name: [
          `Use a name that yields a slug of 1 to ${MAX_SLUG_LENGTH} characters after normalisation.`,
        ],
      });
    }

    return slug;
  }
}

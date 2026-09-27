/**
 * Attendee-request rules (PRD v2 §5.8, §12 rows 11-12, §14, §15, §16; FR-23, FR-23a,
 * FR-24; rules 05, 06, 07, 08).
 *
 * Two audiences meet in this one service, and the PRD gives them one authorisation
 * basis between them:
 *
 *   - **Attendee** (`submitRequest`): no account (PRD §3), so ownership of the
 *     registration is proved by the **reference + email** pair, re-verified on every
 *     request rather than remembered from an earlier lookup — rule 05 says so
 *     explicitly. A pair that does not resolve is a `400`, which is §12's own status
 *     for this endpoint and the skill's step 6.
 *   - **Organiser** (`listRequests`, `respondToRequest`): their session, and the
 *     event must be theirs (IDOR, rule 05). The `404`/`403` split for *that* check
 *     is `requireOwnedEvent`'s, fixed by product-owner decision R-3 rather than by
 *     this service: an unknown event id is `404`, and an event that exists and
 *     belongs to somebody else is `403` (rule 06 assigns `403` to an access-control
 *     failure and `404` to a row that genuinely does not exist). What is decided
 *     here, and is specific to requests, is that a **request id** naming another
 *     event's request is reported as `404` - a request id is a bare uuid the caller
 *     only ever saw in a queue, so a `403` about it would confirm that it exists.
 *
 * ## Why the mismatch messages are identical
 *
 * Rule 08 requires the evidence refusal not to differ "in shape, timing, or wording"
 * between a reference that does not exist and one whose email is wrong. The same
 * reasoning is applied here in the form §12 dictates: one message, one field set,
 * whether the reference is unknown, the email is wrong, or the pair is valid but
 * belongs to a different registration than the path names.
 *
 * ## Why a resolution is written once
 *
 * §14 requires the request *and its resolution* to be retained, never deleted.
 * Allowing a resolved request's notes to be rewritten would satisfy "the row still
 * exists" while destroying the resolution text, which is the thing §14 is protecting.
 * So `resolved` is terminal: a repeat write is a `409` that names when the request was
 * resolved, and a reopen is the same `409` rather than a `400`, because the request
 * was well-formed — it collided with state (rule 06's `409` column).
 */

import {
  ConflictError,
  IllegalTransitionError,
  NotFoundError,
  ValidationError,
} from "../errors";
import { requireOrganiserId, requireOwnedEvent } from "../events/event-ownership";
import type { EventRepository } from "../events/event.repository";
import type { PageRequest } from "../events/event";
import type { PaginatedResponse } from "../events/event.dto";
import type { RegistrationRepository } from "../registrations/registration.repository";
import { emailsMatch } from "../registrations/registration";
import {
  toAttendeeRequestDTO,
  toOrganiserRequestDTO,
  type AttendeeRequestDTO,
  type OrganiserRequestDTO,
} from "./request.dto";
import type {
  AttendeeRequestRepository,
  RecordAttendeeRequestResolutionInput,
} from "./request.repository";
import {
  isAttendeeRequestTransitionAllowed,
  type AttendeeRequestStatus,
  type ResolveAttendeeRequestCommand,
  type SubmitAttendeeRequestCommand,
} from "./request";

/**
 * The one refusal text for a reference/email pair that does not name a registration.
 *
 * Deliberately says nothing about *which* half failed and nothing about the
 * registration's existence — the same reasoning as `EvidenceService`'s refusal, and
 * the reason this is a `400` naming the two fields rather than a `403` on the
 * reference alone: §12 assigns `403` to the *evidence* endpoint specifically, and
 * this row assigns `400` here, so each is followed literally.
 */
const REQUEST_REGISTRATION_NOT_FOUND_MESSAGE =
  "No registration matches that reference and email address.";

const REQUEST_NOT_ON_EVENT_MESSAGE = "No such attendee request exists on this event.";

const REQUEST_ALREADY_RESOLVED_MESSAGE = "This attendee request was already resolved.";

/** The result of a submission, with the fact the route needs to choose `201` vs `200`. */
export interface AttendeeRequestSubmission {
  readonly request: AttendeeRequestDTO;
  /**
   * `false` for a replay (FR-23a: the original request, not a second row). The route
   * maps this to `200` instead of `201` for the same reason the registration route
   * does — a `201` on a replay tells an idempotent client it created something it
   * already had.
   */
  readonly created: boolean;
}

export class RequestService {
  constructor(
    private readonly eventRepository: EventRepository,
    private readonly registrations: RegistrationRepository,
    private readonly repository: AttendeeRequestRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Attendee: submit a request against their own registration (FR-23, FR-23a).
   *
   * The ownership proof is `findRegistrationByReference` followed by an email
   * comparison and an id comparison — three facts, one of which is the path segment.
   * The registration is read *here* rather than trusted from the path because a path
   * id is client input (rule 05: "resolve the target resource and its owning id
   * server-side").
   */
  async submitRequest(command: SubmitAttendeeRequestCommand): Promise<AttendeeRequestSubmission> {
    const registration = await this.registrations.findRegistrationByReference(
      command.uniqueReference,
    );

    if (
      registration === null ||
      !emailsMatch(registration.attendeeEmail, command.attendeeEmail) ||
      registration.id !== command.registrationId
    ) {
      throw new ValidationError("The request body failed validation.", {
        unique_reference: [REQUEST_REGISTRATION_NOT_FOUND_MESSAGE],
        email: [REQUEST_REGISTRATION_NOT_FOUND_MESSAGE],
      });
    }

    const creation = await this.repository.createAttendeeRequest({
      registrationId: registration.id,
      message: command.message,
      idempotencyKey: command.idempotencyKey,
    });

    if (creation.outcome === "replayed") {
      // A key reused for a materially different request is a conflict, not a silent
      // return of the old row (rule 06, and the same position P-3 takes for
      // registration replay).
      const stored = creation.request;

      if (stored.registrationId !== command.registrationId || stored.message !== command.message) {
        throw new ConflictError(
          "This idempotency key was already used for a different attendee request.",
        );
      }
    }

    return {
      request: toAttendeeRequestDTO(creation.request),
      created: creation.outcome === "created",
    };
  }

  /**
   * Organiser: their event's request queue (FR-24, §12 row 12).
   *
   * Ownership is verified before the query runs, so a non-owner cannot use response
   * timing or a `total` to learn whether another organiser has requests.
   *
   * Newest first, `id` as the tiebreak, for the same reason the staff token list
   * orders that way: two requests created in the same millisecond must not swap
   * places between pages.
   */
  async listRequests(
    organiserId: string,
    eventId: string,
    page: PageRequest,
    status: AttendeeRequestStatus | null,
  ): Promise<PaginatedResponse<OrganiserRequestDTO>> {
    requireOrganiserId(organiserId);
    await requireOwnedEvent(this.eventRepository, organiserId, eventId);

    const result = await this.repository.listAttendeeRequests({
      eventId,
      status,
      page: page.page,
      pageSize: page.pageSize,
    });

    return {
      data: result.items.map(toOrganiserRequestDTO),
      page: page.page,
      page_size: page.pageSize,
      total: result.total,
    };
  }

  /**
   * Organiser: record a response, or resolve the request (FR-24, R-5 G-3, §14).
   *
   * Order of decisions, and why:
   *
   *   1. Ownership of the event, before anything is read (rule 05's checklist step 4).
 *   2. Does the request belong to this event? `404` otherwise, and the same `404` for
 *      "unknown" and "someone else's" so an id cannot be probed across tenants.
   *   3. Is the command a legal transition *from the stored state*? A resolved request
   *      is terminal, so any write to it is a `409` naming when it was resolved. A
   *      reopen (`status: "open"`) therefore lands on that same branch rather than
   *      reaching the adapter, which is why the port's `status` cannot express `open`.
   *   4. Resolving without notes is a `400` naming `resolution_notes`: a resolution
   *      nobody can read is not a resolution, and §12 requires field-level detail.
   *   5. A patch that says nothing is a `400`, not a no-op write. §12's `PATCH` is a
   *      partial update, and "no fields" is the one input that is not a partial update
   *      of anything — accepting it would return `200` for work nobody asked to do.
   *   6. The write itself re-asserts both the event scope and the `open` precondition,
   *      so a concurrent second organiser cannot overwrite the first one's resolution.
   */
  async respondToRequest(
    organiserId: string,
    eventId: string,
    requestId: string,
    command: ResolveAttendeeRequestCommand,
  ): Promise<OrganiserRequestDTO> {
    requireOrganiserId(organiserId);
    await requireOwnedEvent(this.eventRepository, organiserId, eventId);

    const existing = await this.repository.findAttendeeRequestForEvent(eventId, requestId);

    if (existing === null) {
      throw new NotFoundError(REQUEST_NOT_ON_EVENT_MESSAGE);
    }

    if (existing.status === "resolved") {
      throw new ConflictError(
        `${REQUEST_ALREADY_RESOLVED_MESSAGE} Its resolution is retained and is not changed. It was resolved at ${describeResolvedAt(
          existing.resolvedAt,
        )}.`,
      );
    }

    if (command.status !== undefined && !isAttendeeRequestTransitionAllowed(existing.status, command.status)) {
      throw new IllegalTransitionError(
        `An attendee request cannot move from "${existing.status}" to "${command.status}".`,
      );
    }

    if (command.status === "resolved" && isBlank(command.resolutionNotes)) {
      throw new ValidationError("The request body failed validation.", {
        resolution_notes: ["Required when resolving a request; a resolution nobody can read is not a resolution."],
      });
    }

    if (command.status === undefined && command.resolutionNotes === undefined) {
      throw new ValidationError("The request body failed validation.", {
        status: ["Supply status, resolution_notes, or both; an empty update does nothing."],
        resolution_notes: ["Supply status, resolution_notes, or both; an empty update does nothing."],
      });
    }

    // `status: "open"` on an already-open request is a no-op, not a backward
    // transition, so it becomes `null` here. The port cannot be handed an `open` at
    // all, which is what makes "resolved is terminal" a type-level property of the
    // write rather than a check the adapter has to remember.
    const input: RecordAttendeeRequestResolutionInput = {
      eventId,
      requestId,
      status: command.status === "resolved" ? "resolved" : null,
      resolutionNotes: command.resolutionNotes ?? null,
      resolvedAt: this.now(),
    };

    const outcome = await this.repository.recordAttendeeRequestResolution(input);

    switch (outcome.kind) {
      case "not_found":
        // The read above found it. Reaching this branch means it moved between the
        // read and the write — only possible if it was resolved by someone else in
        // that window, since requests are never deleted (§14).
        throw new NotFoundError(REQUEST_NOT_ON_EVENT_MESSAGE);

      case "already_resolved":
        throw new ConflictError(
          `${REQUEST_ALREADY_RESOLVED_MESSAGE} Its resolution is retained and is not changed. It was resolved at ${
            describeResolvedAt(outcome.request.resolvedAt)
          }.`,
        );

      case "updated":
        return toOrganiserRequestDTO(outcome.request);
    }
  }
}

/**
 * Whether a note is "nobody can read this".
 *
 * Trimmed rather than compared to `""`, so the rule belongs to the domain and not to the
 * transport: the HTTP parser already rejects a blank field, but a caller that is not a
 * route (a script, a future background job) must not be able to write a resolution of
 * `"   "` and have the lifecycle move to a terminal state nobody can read.
 */
function isBlank(value: string | undefined): boolean {
  return (value ?? "").trim() === "";
}

/**
 * A `resolved_at` for a refusal message, degrading honestly.
 *
 * A resolved request with no `resolved_at` is refused by the database's CHECK
 * constraint, so `null` here can only mean the row was written before that constraint
 * existed. The message says so rather than printing `null` at a human.
 */
function describeResolvedAt(resolvedAt: Date | null): string {
  return resolvedAt === null ? "an unrecorded instant" : resolvedAt.toISOString();
}

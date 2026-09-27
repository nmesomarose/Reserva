/**
 * Staff business rules (PRD v2 §4.3, §4.4, §4.6, FR-17–FR-21, BR-4, BR-5, §9.4,
 * §10, §12; rule 05, rule 06, rule 07).
 *
 * Two services' worth of behaviour lives here, because the PRD's §12 table gives
 * staff exactly two capabilities and gives the *organiser* the token lifecycle:
 *
 *   - **Staff** (event-scoped, bearer token): `searchRegistrations` and
 *     `checkIn`. Nothing else — no event reads, no tiers, no dashboard, no
 *     requests, no token management, no second event. Rule 05 lists that
 *     prohibition explicitly, and the narrowness is enforced structurally here:
 *     a {@link StaffContext} carries exactly one event id, so there is no
 *     parameter through which a wider scope could arrive.
 *   - **Organiser** (their own session): `issueStaffToken`, `listStaffTokens`,
 *     `revokeStaffToken` (§4.6).
 *
 * The messages below are load-bearing rather than incidental. AGENTS.md §11.2
 * requires "already checked in" and "not eligible" to be distinguishable, and an
 * expired/revoked staff token to be distinguishable from a generic auth error; a
 * client cannot present a right message for a wrong one, and the whole premise of
 * the product is that state is never misrepresented.
 */

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from "../errors";
import type { PaginatedResponse } from "../events/event.dto";
import { requireOrganiserId, requireOwnedEvent } from "../events/event-ownership";
import type { EventRepository } from "../events/event.repository";
import type { PageRequest } from "../events/event";
import {
  toCheckInDTO,
  toStaffSearchResultDTO,
  toStaffTokenDTO,
  type CheckInDTO,
  type IssuedStaffTokenDTO,
  type StaffSearchResultDTO,
  type StaffTokenDTO,
} from "./staff.dto";
import type { ListStaffTokensQuery, StaffRepository } from "./staff.repository";
import {
  checkInEligible,
  MIN_STAFF_SEARCH_QUERY_LENGTH,
  STAFF_TOKEN_GRACE_MS,
  type CheckInCommand,
  type IssueStaffTokenCommand,
  type StaffContext,
  type StaffTokenIssuer,
} from "./staff";

// --- Messages (AGENTS.md §11.2: each state gets its own) ------------------------

/** No usable credential presented at all. */
const STAFF_NO_TOKEN_MESSAGE = "This request has no valid staff access token.";

/** A token that was pulled. Distinct from the generic message above, on purpose. */
const STAFF_TOKEN_REVOKED_MESSAGE = "This staff access token has been revoked.";

/** A token past its `expires_at`. Also distinct: the remedy is different. */
const STAFF_TOKEN_EXPIRED_MESSAGE = "This staff access token has expired.";

/**
 * A client-supplied event that is not the token's event.
 *
 * Rule 05 and the staff skill both say a disagreeing `event_id` is "a rejected
 * request, not a scope override", which is this. It is `403` rather than `404`
 * because the caller *did* authenticate, and a `404` would imply the event might
 * not exist — the token already proved this token is scoped elsewhere, and telling
 * a staff member to go and find the right URL is not the job here.
 */
const STAFF_EVENT_SCOPE_MESSAGE =
  "This staff access token is not valid for that event.";

/**
 * A registration outside the token's event.
 *
 * The opposite choice from the message above, and the reason is the shape of the
 * two requests. Here the client supplied a *registration id* and no event at all,
 * so there is no claim to contradict — the question is whether that id names
 * something this token may touch. Answering `404` means the token cannot be used to
 * learn whether a given registration id exists in another event, which is the
 * enumeration PRD §15/§18 exist to prevent. It therefore reads exactly like an
 * unknown id.
 */
const REGISTRATION_NOT_IN_EVENT_MESSAGE = "No such registration exists in this event.";

/** A token id that is not one of this event's. Same anti-enumeration reasoning. */
const STAFF_TOKEN_NOT_ON_EVENT_MESSAGE = "No such staff access token exists on this event.";

export class StaffService {
  constructor(
    private readonly eventRepository: EventRepository,
    private readonly repository: StaffRepository,
    private readonly issuer: StaffTokenIssuer,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Resolve a presented credential to a staff identity, or refuse.
   *
   * This is the check every staff route depends on, and it fails closed in four
   * distinct ways — missing, unknown, revoked, expired — with the last two
   * reported differently from the first two. That distinction is a requirement
   * (rule 05, §4.6.3, AGENTS.md §11.2): a door supervisor whose token lapsed at
   * midnight needs to be told "expired" so they ask the organiser for a new one,
   * not handed a generic failure they cannot act on.
   *
   * Revocation and expiry are checked *here*, on the request, rather than being
   * assumed because a token that is revoked mid-shift has to stop working on the
   * very next call (§4.6.3). Nothing in the UI is involved in that decision.
   */
  async resolveStaffToken(secret: string): Promise<StaffContext> {
    if (secret === "") {
      throw new UnauthenticatedError(STAFF_NO_TOKEN_MESSAGE);
    }

    const token = await this.repository.findStaffTokenByTokenHash(this.issuer.hash(secret));

    if (token === null) {
      throw new UnauthenticatedError(STAFF_NO_TOKEN_MESSAGE);
    }

    const now = this.now();

    if (token.revokedAt !== null) {
      throw new UnauthenticatedError(STAFF_TOKEN_REVOKED_MESSAGE);
    }

    if (token.expiresAt.getTime() <= now.getTime()) {
      throw new UnauthenticatedError(STAFF_TOKEN_EXPIRED_MESSAGE);
    }

    return {
      staffTokenId: token.id,
      eventId: token.eventId,
      // `""` on the row means unlabelled (see `StaffTokenRecord.label`).
      label: token.label === "" ? null : token.label,
    };
  }

  /**
   * Organiser: issue a staff token for an event they own (§4.6.1, §12).
   *
   * Ownership is verified before anything is minted, so a caller cannot spend CSPRNG
   * output or learn anything about another organiser's event by trying.
   *
   * The plaintext is returned exactly once, here, and only its hash is stored. This
   * is the single response in the product that contains a usable credential, which
   * is also why `GET` cannot be given one: the hash is not reversible and the
   * plaintext is not stored (rule 06, AGENTS.md §14).
   */
  async issueStaffToken(
    organiserId: string,
    eventId: string,
    command: IssueStaffTokenCommand,
  ): Promise<IssuedStaffTokenDTO> {
    requireOrganiserId(organiserId);

    const event = await requireOwnedEvent(this.eventRepository, organiserId, eventId);

    const secret = this.issuer.issue();

    const record = await this.repository.createStaffToken({
      eventId,
      tokenHash: secret.tokenHash,
      label: command.label,
      expiresAt: this.resolveExpiry(event.endsAt, command.expiresAt),
    });

    return { ...toStaffTokenDTO(record, this.now()), token: secret.token };
  }

  /**
   * Organiser: their own tokens for an event, with status (§4.6.2).
   *
   * Listed newest-first, because the question an organiser opens this list to ask
   * is "which of these do I still need", and the one they just created is the one
   * they copied. A `total` of the whole filtered set comes with it, per the
   * pagination contract — an event with no tokens is a `200` with `data: []`.
   */
  async listStaffTokens(
    organiserId: string,
    eventId: string,
    page: PageRequest,
  ): Promise<PaginatedResponse<StaffTokenDTO>> {
    requireOrganiserId(organiserId);

    await requireOwnedEvent(this.eventRepository, organiserId, eventId);

    const query: ListStaffTokensQuery = { eventId, page: page.page, pageSize: page.pageSize };
    const result = await this.repository.listStaffTokens(query);

    const now = this.now();

    return {
      data: result.items.map((record) => toStaffTokenDTO(record, now)),
      page: page.page,
      page_size: page.pageSize,
      total: result.total,
    };
  }

  /**
   * Organiser: revoke a token immediately (§4.6.2 — revocation, not deletion).
   *
   * Idempotent, so a retried or double-clicked revoke is a `200` rather than a
   * confusing `404`/`409`: the requested state is already true. The row survives
   * because the check-in rows referencing it are `RESTRICT` and because "this token
   * existed and was pulled on this date" is audit information.
   *
   * The event is passed *into* the write. A token from another event therefore
   * matches no row and nothing is stamped — the `404` below is the whole of the
   * response, with no side effect behind it. Revoking first and comparing the
   * returned `event_id` afterwards would have been the same answer with a
   * cross-tenant write hidden inside it.
   */
  async revokeStaffToken(
    organiserId: string,
    eventId: string,
    staffTokenId: string,
  ): Promise<StaffTokenDTO> {
    requireOrganiserId(organiserId);

    await requireOwnedEvent(this.eventRepository, organiserId, eventId);

    const existing = await this.repository.revokeStaffToken(eventId, staffTokenId, this.now());

    if (existing === null) {
      throw new NotFoundError(STAFF_TOKEN_NOT_ON_EVENT_MESSAGE);
    }

    return toStaffTokenDTO(existing, this.now());
  }

  /**
   * Staff: search one event's registrations (FR-17, §4.3, §4.4).
   *
   * FR-17's precedence is implemented as a *scoring* order, not as three
   * separate result sets: name matches come first, then email/phone, and a row
   * matching both appears once. Staff are looking for a person at a door, and the
   * first page has to be the most likely person — with a `query` that is a surname,
   * the name matches are the answer and the email matches are the fallback.
   *
   * Zero matches is a `200` with an empty `data`, never a `404` and never a
   * "no registration found" error: §4.4.1 wants an explicit empty state *with an
   * escalation path*, which is a client concern the response enables by
   * answering normally. Multiple matches are simply several rows — the
   * disambiguation list of §4.4.2 is the client rendering `data`, and the
   * server's part of that promise is that it never picks one for them.
   */
  async searchRegistrations(
    context: StaffContext,
    eventId: string,
    query: string,
    page: PageRequest,
  ): Promise<PaginatedResponse<StaffSearchResultDTO>> {
    this.requireEventScope(context, eventId);
    this.requireSearchableQuery(query);

    const trimmed = query.trim();

    const result = await this.repository.searchRegistrations({
      eventId: context.eventId,
      query: trimmed,
      page: page.page,
      pageSize: page.pageSize,
    });

    return {
      data: result.items.map(toStaffSearchResultDTO),
      page: page.page,
      page_size: page.pageSize,
      total: result.total,
    };
  }

  /**
   * Staff: check a registration in (FR-20, FR-21, §9.4, skill steps 5–9).
   *
   * The whole of §4.4.4 and BR-4 is decided by the adapter's outcome plus one
   * question this service asks itself, which is the caller's intent:
   *
   *   - eligible, no prior check-in   -> record, `is_override = false`
   *   - already checked in, no flag    -> `409`, naming the original timestamp
   *   - already checked in, `override` -> a **second row**, `is_override = true`
   *   - not eligible                   -> `409`, a *different* message
   *
   * Two separate `409`s because §11.2 requires them to be distinguishable and they
   * need different human responses: one means "this attendee is already inside, find
   * out who let them in", the other means "this person has not paid, escalate to
   * the organiser". Collapsing them would make the door unable to act on either.
   */
  async checkIn(
    context: StaffContext,
    registrationId: string,
    command: CheckInCommand,
  ): Promise<CheckInDTO> {
    const outcome = await this.repository.recordCheckIn({
      staffTokenId: context.staffTokenId,
      staffTokenEventId: context.eventId,
      registrationId,
      command,
      checkedInAt: this.now(),
    });

    switch (outcome.kind) {
      case "not_found":
        throw new NotFoundError(REGISTRATION_NOT_IN_EVENT_MESSAGE);

      case "not_eligible":
        throw new ConflictError(
          `This registration is ${describeStatus(outcome.status)} and cannot be checked in. Only a confirmed ticket is valid for entry.`,
        );

      case "already_checked_in":
        if (command.override) {
          // Unreachable through the Prisma adapter, by construction: an explicit
          // override is recorded inside the same transaction and comes back as
          // `recorded`. Throwing rather than returning a fabricated success means an
          // adapter that got this wrong fails loudly in its test, instead of
          // answering a check-in request with a row id that does not exist.
          throw new Error(
            "A check-in override must be recorded as a new row, not reported as blocked.",
          );
        }

        // §4.4.4: show the original timestamp. Not a convenience — it is what
        // turns "already in" into something the door can act on.
        throw new ConflictError(
          `This registration was already checked in at ${outcome.originalCheckInAt.toISOString()}. Re-checking it in requires an explicit override.`,
        );

      case "recorded":
        // Post-condition on the adapter, not a re-check of its input. If a future
        // adapter ever reports a recorded check-in for a state §9.4 forbids, this
        // refuses to hand back a success body for it — the FR-21 guarantee then
        // holds even if the guarded write is wrong.
        if (!checkInEligible(outcome.status)) {
          throw new ConflictError(
            `This registration is ${describeStatus(outcome.status)} and cannot be checked in. Only a confirmed ticket is valid for entry.`,
          );
        }

        // Labelled with the acting token's own label rather than by re-reading
        // `staff_tokens`: the transaction has committed by now, and a cosmetic field
        // is not worth a second round trip inside a request whose p95 matters.
        return toCheckInDTO(outcome.checkIn, context.label);
    }
  }

  /**
   * The default expiry, and the only validation applied to an explicit one.
   *
   * Default: the event's end plus the grace window in `staff.ts` (PRD §3).
   *
   * Explicit: must be in the future. The PRD does not cap it, and inventing a
   * maximum would be a product decision this slice has no mandate to make — an
   * organiser running a multi-day event legitimately wants a token that outlives
   * the default. A past or present instant is refused because a token that is
   * already dead at creation is a mistake worth reporting rather than a row that
   * silently never works.
   */
  private resolveExpiry(eventEndsAt: Date, requested: Date | null): Date {
    if (requested === null) {
      return new Date(eventEndsAt.getTime() + STAFF_TOKEN_GRACE_MS);
    }

    if (requested.getTime() <= this.now().getTime()) {
      throw new ValidationError("A staff access token must expire in the future.", {
        expires_at: ["Must be a time in the future."],
      });
    }

    return requested;
  }

  /**
   * A client-supplied event that is not this token's event is refused, not honoured.
   *
   * Scoped to the search route only. The check-in route has no event in its path at
   * all — its scope check is the registration's own `event_id`, inside the guarded
   * write — so this is not a shared helper, and pretending otherwise would hide
   * that the two are enforced at different points on purpose.
   */
  private requireEventScope(context: StaffContext, requestedEventId: string): void {
    if (context.eventId !== requestedEventId) {
      throw new ForbiddenError(STAFF_EVENT_SCOPE_MESSAGE);
    }
  }

  /**
   * §11: "Search query: minimum 2 characters."
   *
   * Enforced here as well as in the validation layer, because this is a rule about
   * what a search *means* — a one-character query matches most of an event and
   * becomes an attendee list — and a domain method reached from anywhere should
   * still be unable to ask for it. The validation layer remains the one that
   * renders the `400` with field detail.
   */
  private requireSearchableQuery(query: string): void {
    if (query.trim().length < MIN_STAFF_SEARCH_QUERY_LENGTH) {
      throw new ValidationError("The search query failed validation.", {
        query: [`Must be at least ${MIN_STAFF_SEARCH_QUERY_LENGTH} characters.`],
      });
    }
  }
}

/**
 * Status words for the "not eligible" `409`.
 *
 * The attendee-facing statuses are named in the message rather than echoed as a raw
 * enum value, because a door volunteer reads this on a screen and
 * `pending_payment` means nothing to them. It is the same distinction the badge
 * makes, in words.
 */
function describeStatus(status: StaffSearchResultDTO["status"]): string {
  switch (status) {
    case "pending_payment":
      return "still awaiting payment";
    case "cancelled":
      return "cancelled";
    case "refunded":
      return "refunded";
    default:
      return status;
  }
}

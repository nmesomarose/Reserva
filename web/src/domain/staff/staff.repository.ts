/**
 * Persistence port for the staff slice (AGENTS.md §4: the domain depends on an
 * interface, not on Prisma).
 *
 * Two things in here are shaped the way they are because of how this data is
 * raced, and both are worth stating before the adapter is read:
 *
 *   1. `searchRegistrations` takes the event id as a required argument and the
 *      adapter filters on it in the query. Event scope is not a post-filter and not
 *      something a caller can widen by passing a different id: the whole point of a
 *      staff token is that it grants exactly one event, so scope is part of the
 *      lookup, not a decision made afterwards.
 *   2. `recordCheckIn` returns a *discriminated outcome* instead of throwing, and
 *      is a single unit of work. The adapter must decide eligibility, the "already
 *      checked in" state, and the insert against a locked registration row, then
 *      report which of those it found. The service turns facts into `409`s; the
 *      adapter does not own the HTTP contract.
 *
 * `transact` matches the shape used by `EventRepository` and
 * `TicketTypeRepository` so all three ports read alike, and so a caller already
 * holding a transaction can pass its handle in.
 */

import type { PagedResult } from "../events/event";
import type {
  CheckInCommand,
  RecordCheckInOutcome,
  StaffSearchQuery,
  StaffSearchRow,
  StaffTokenRecord,
} from "./staff";

export interface CreateStaffTokenInput {
  readonly eventId: string;
  /** Already hashed by the injected {@link StaffTokenIssuer}. Never plaintext. */
  readonly tokenHash: string;
  readonly label: string | null;
  readonly expiresAt: Date;
}

export interface ListStaffTokensQuery {
  readonly eventId: string;
  readonly page: number;
  readonly pageSize: number;
}

export interface RecordCheckInInput {
  /**
   * The token's own event. Read from the token server-side, never from the path or
   * body, and compared against the registration's event inside the transaction —
   * this pair is the cross-event check (rule 05, PRD §18).
   */
  readonly staffTokenId: string;
  readonly staffTokenEventId: string;
  readonly registrationId: string;
  readonly command: CheckInCommand;
  readonly checkedInAt: Date;
}

export interface StaffRepository {
  transact<T>(work: (repository: StaffRepository) => Promise<T>): Promise<T>;

  /** Store a new token. The plaintext is never passed in. */
  createStaffToken(input: CreateStaffTokenInput): Promise<StaffTokenRecord>;

  /**
   * One page of an event's tokens, plus the count of the whole set.
   *
   * A `PagedResult` rather than a bare array so `total` cannot be computed from the
   * page — rule 06 requires the count of the *whole* filtered set, and asking the
   * adapter for both is what keeps the two statements agreeing on the filter.
   */
  listStaffTokens(query: ListStaffTokensQuery): Promise<PagedResult<StaffTokenRecord>>;

  /**
   * Set `revoked_at` if it is not already set; return the row either way.
   *
   * `eventId` is part of the statement, not a check the caller makes afterwards. A
   * `WHERE id = ?` alone would mean a guessed token id from another event gets
   * *mutated* before anyone notices the mismatch — a cross-tenant write hidden
   * behind a `404`. Scoping the `UPDATE` itself is what makes the refusal free of
   * side effects: no row matches, so nothing is stamped.
   *
   * Idempotent on purpose. Revoking twice is what a double-clicked button or a
   * retried request looks like, and the second one must not fail — the organiser's
   * intent ("this token must not work") is already satisfied. `revoked_at` is
   * stamped once and never moved, because "when was this pulled" is audit data
   * (PRD §4.6.2).
   *
   * Returns `null` for a token that does not exist, or one belonging to another
   * event; the two are deliberately indistinguishable to the caller.
   */
  revokeStaffToken(eventId: string, id: string, revokedAt: Date): Promise<StaffTokenRecord | null>;

  /**
   * Find a token by the hash of the presented credential, revoked or expired ones
   * included.
   *
   * Including them is deliberate: the service has to tell "revoked" from "expired"
   * from "no such token", because rule 05 and AGENTS.md §11.2 require distinct
   * messages for an expired/revoked token and a generic auth error. Filtering them
   * out in the query would collapse the three into one indistinguishable `null`.
   */
  findStaffTokenByTokenHash(tokenHash: string): Promise<StaffTokenRecord | null>;

  /**
   * Case-insensitive substring search over attendee name first, then email, then
   * phone (FR-17: name primary, email/phone secondary/fallback), scoped to one
   * event, ordered deterministically, and paged.
   */
  searchRegistrations(query: StaffSearchQuery): Promise<PagedResult<StaffSearchRow>>;

  /**
   * The guarded check-in write: read the registration `FOR UPDATE`, refuse an
   * out-of-scope or ineligible target, insert one append-only row, and set the
   * `checked_in` projection — all in one transaction.
   *
   * `not_found` is returned for a registration that does not exist *or* belongs to
   * another event, so the token cannot be used to probe other events' registrations.
   */
  recordCheckIn(input: RecordCheckInInput): Promise<RecordCheckInOutcome>;
}

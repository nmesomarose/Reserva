/**
 * Staff tokens and check-ins: the records, the small pure rules, and the
 * vocabulary the rest of the slice shares (PRD v2 §4.3, §4.4, §4.6, §5.6, §5.7,
 * §7.2, §9.4, §10).
 *
 * This is the event-day half of the product. Its whole premise, stated in PRD §1
 * and §18, is that a non-confirmed payment is *never* presented as a valid
 * ticket. Everything in this file exists to keep that true:
 *
 *   - `checkInEligible` is the *definition* of a state the check-in endpoint
 *     accepts. It is not a UI hint: `staff.service.ts` turns a `false` into the
 *     `409` that FR-21 requires, and the search projection exposes it so a client
 *     can leave the control out of the response entirely (AGENTS.md §11.2 asks for
 *     the control to be *absent*, not disabled-looking).
 *   - `staffStatusBadge` is PRD's own four-label vocabulary, not an invention.
 *     §4.3.3 names them: Confirmed / Payment Not Confirmed / Pending / Checked In.
 *
 * NOT in this slice, deliberately:
 *
 *   - A QR/scanner check-in path — explicitly out of scope (PRD §20), and the
 *     staff skill lists it as a stop condition.
 *   - Any offline check-in or manual "let them in anyway" path. That would
 *     contradict FR-21/BR-5 outright, so it is a product decision to raise, not
 *     an implementation to guess at (staff skill, stop conditions).
 *   - Ranked/fuzzy/phonetic search matching. The skill makes "matching appears to
 *     need fuzzy or ranking beyond the PRD contract" a stop condition: flag, do
 *     not build. Matching here is a case-insensitive substring over name, then
 *     email, then phone.
 */

import type { PageRequest } from "../events/event";
import type { RegistrationStatus } from "../registrations/registration";

/**
 * `StaffToken` (PRD §7.2): `id, event_id (FK Event, CASCADE), token_hash, label,
 * expires_at, revoked_at (nullable), created_at`.
 *
 * `tokenHash` never leaves the persistence boundary. No DTO in this slice has a
 * field for it, and rule 06 lists `StaffToken.token_hash` among the values that
 * must not be returned to *any* role — including the organiser who issued it.
 */
export interface StaffTokenRecord {
  readonly id: string;
  /** The one event this token may act in. Read server-side, never from a request. */
  readonly eventId: string;
  readonly tokenHash: string;
  /**
   * The organiser's own text for this token, e.g. "Door Team A" (§4.6.1).
   *
   * Typed `string` because that is what the column is: PRD §7.2 marks only
   * `revoked_at` as nullable, so `label` is `NOT NULL` and "optionally labeled" in
   * §4.6.1 means the organiser may *omit* one, not that the row may lack the field.
   * An unlabelled token therefore holds `""` here, and the projection turns that back
   * into `null` so a client sees one representation of "no label" rather than an
   * empty string it has to guess the meaning of. See `toStaffTokenDTO`.
   */
  readonly label: string;
  readonly expiresAt: Date;
  /** `null` while the token is live. Revocation, not deletion (§4.6.2). */
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

/**
 * `CheckIn` (PRD §7.2). Append-only: nothing in this slice updates or deletes one.
 *
 * `isOverride` is `true` for a *repeat* check-in — the second and any later rows —
 * and is the flag that makes an override separately auditable (BR-4).
 *
 * The actor is exactly one of two columns. PRD §7.2 calls this single field
 * `checked_in_by`; rule 02 records why it is two nullable FKs with a CHECK that
 * exactly one is set, because the two actor kinds live in different tables and a
 * polymorphic single FK cannot be constrained. `staffTokenId` is therefore always
 * present on a staff check-in and `organiserId` always `null`.
 */
export interface CheckInRecord {
  readonly id: string;
  readonly registrationId: string;
  readonly checkedInAt: Date;
  readonly organiserId: string | null;
  readonly staffTokenId: string | null;
  readonly isOverride: boolean;
  readonly createdAt: Date;
}

/**
 * One row of staff search output, already joined to its ticket tier.
 *
 * The raw `attendee_email`/`attendee_phone` are here because matching needs them;
 * `staff.dto.ts` masks them before anything is returned. Keeping the unmasked
 * values inside the domain and out of every DTO is what makes "search responses
 * mask email/phone" (skill integrity checks) a property of one file rather than a
 * rule repeated per projection.
 *
 * `latestCheckInAt` is the "already checked in at" timestamp §4.4.4 requires to be
 * shown. It comes from the Check-in log — the source of truth for *when* and *by
 * whom* — rather than from `status`, which is only a projection of it (PRD §7.4).
 */
export interface StaffSearchRow {
  readonly registrationId: string;
  readonly eventId: string;
  readonly attendeeName: string;
  readonly attendeeEmail: string;
  readonly attendeePhone: string;
  readonly status: RegistrationStatus;
  readonly ticketTypeId: string;
  readonly ticketTypeName: string;
  /** `null` until the first check-in; the latest row's timestamp thereafter. */
  readonly latestCheckInAt: Date | null;
}

/** PRD §11: "Search query: minimum 2 characters". */
export const MIN_STAFF_SEARCH_QUERY_LENGTH = 2;

/**
 * PRD §11: "Search results: capped at 20 per request."
 *
 * A narrower ceiling than rule 06's platform-wide 50, and deliberately so. §11 gives
 * the search endpoint its own cap because a door list is a phone-sized list to page
 * through, not a report to export — and because search is the one staff query with a
 * stated p95 budget (§18), so a bigger page is more work per request for nothing.
 *
 * Named here rather than in the validation layer so the contract lives with the rest
 * of §11's search bounds instead of as a literal inside a parser.
 */
export const MAX_STAFF_SEARCH_PAGE_SIZE = 20;

/**
 * PRD §11 caps the query length too, but not at a stated number.
 *
 * A 200-character cap: long enough that an attendee pasting a whole email address
 * or a full phone number with country code is never truncated, short enough that the
 * `ILIKE '%…%'` pattern cannot be used to ask the database for an unbounded scan
 * disguised as a search. Percent, underscore and backslash are escaped, so the
 * pattern is matched literally rather than as a wildcard.
 */
export const MAX_STAFF_SEARCH_QUERY_LENGTH = 200;

/**
 * How long past the event's end a staff token stays valid by default.
 *
 * PRD §3 fixes the *shape* — "`expires_at` defaults to the event's end date plus a
 * short grace window" — and does not give a number, so one is chosen here rather
 * than left implicit:
 *
 *   - 24 hours covers a door team still clearing a queue after a late-running
 *     event, and covers an organiser who created the token before the doors opened
 *     on a multi-day timetable.
 *   - It is not longer. The token grants exactly two capabilities, both of which
 *     are useless once the event is over, so a long lifetime would be pure standing
 *     exposure. Expiry is the control; revocation is the emergency one.
 *
 * Recorded as design position P-12 in `docs/evidence/requirements-matrix.md`. An
 * organiser can still pass an explicit `expires_at`, which this only defaults.
 */
export const STAFF_TOKEN_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * A staff token is a bearer credential, so the plaintext is 32 bytes of CSPRNG
 * output, base64url-encoded — byte-for-byte the same construction as the organiser
 * session token (`src/server/auth/auth.service.ts`), for the same reasons: nothing
 * in the client's possession to tamper with, and nothing to brute-force.
 *
 * The `[VERIFY]` part of PRD §19/§21.5 is the *transport*, and this is the decision
 * for it (product-owner decision 2, 2026-09-27, recorded in `.agents/rules/03`):
 *
 *   - `Authorization: Bearer <token>`, presented per request, not a cookie.
 *   - Only a SHA-256 hash is stored (`staff_tokens.token_hash`, `UNIQUE`).
 *
 * A cookie would have been the wrong shape: staff tokens are used on shared door
 * devices, and a cookie is ambient — it would be attached to any request that
 * device makes, including to the organiser's own surfaces if the same browser is
 * used for both. A bearer header is presented only where it is meant to be, which
 * keeps a staff token from ever being attached to an organiser-scoped route.
 *
 * SHA-256 rather than a slow KDF, unlike a password: the input is 256 bits of
 * random data, so there is nothing to brute-force, and this is the identical
 * argument the session token already makes.
 */
export interface StaffTokenSecret {
  /** The plaintext. Returned once, at creation, and never stored or logged. */
  readonly token: string;
  /** What goes in the database. */
  readonly tokenHash: string;
}

/**
 * The port through which the domain mints and hashes staff secrets.
 *
 * Both operations are `node:crypto`, so they are injected rather than imported:
 * the domain stays free of the runtime (AGENTS.md §4's layer separation) and a
 * test can supply a deterministic issuer. `hash` is on the same port as `issue`
 * because resolving a presented credential needs exactly the same primitive, and
 * the two must never drift — a hash computed with one algorithm and looked up with
 * another is a token that silently never matches.
 *
 * Note the asymmetry with the organiser session, whose `AuthService` mints its own
 * token: the difference is that staff tokens are also *created* by
 * organiser-scoped code, and the domain must not reach into the server-only auth
 * module's session machinery to do it.
 */
export interface StaffTokenIssuer {
  issue(): StaffTokenSecret;
  /** SHA-256 of a presented credential, as stored in `staff_tokens.token_hash`. */
  hash(secret: string): string;
}

/**
 * The authenticated staff identity, as business logic is allowed to see it.
 *
 * `eventId` is the token's own scope and is the *only* event this principal may
 * act in. It reaches the domain from the verified credential and from nowhere
 * else — there is no path from a path segment, a query parameter, or a body field
 * to this property (rule 05, PRD §18).
 *
 * Deliberately not a "staff account": there is no such table (PRD §3, §7.1), so
 * there is no id of the person holding the token, only the token itself. `label` is
 * the organiser's own text for it, which is what the audit log can honestly show.
 */
export interface StaffContext {
  readonly staffTokenId: string;
  readonly eventId: string;
  readonly label: string | null;
}

/**
 * FR-21 / PRD §9.4: only `confirmed` and `checked_in` may be checked in.
 *
 * A repeated check-in is eligible precisely because §4.4.4 allows an explicit
 * override of an *already checked in* registration — the override is what creates
 * the new append-only row, and the row is only ever created for one of these two
 * states. Everything else (`pending_payment`, `cancelled`, `refunded`) is `409`.
 */
export function checkInEligible(status: RegistrationStatus): boolean {
  return status === "confirmed" || status === "checked_in";
}

/**
 * PRD §4.3.3 / §4.4.3's four status labels, as a machine-readable value.
 *
 * The mapping is the requirement, not the display text; §11.2 forbids colour-only
 * status, so a client pairs this with a label of its own and the DTO deliberately
 * does not ship prose.
 *
 *   - `confirmed`        -> Confirmed. The only state that may be checked in.
 *   - `checked_in`       -> Checked In.
 *   - `pending_payment`  -> Pending. The payment is not resolved yet; §11.2 forbids
 *                          this ever looking like a success.
 *   - `cancelled`,
 *     `refunded`         -> Payment Not Confirmed. Distinct from Pending on
 *                          purpose: a cancelled or refunded payment will not become
 *                          a ticket, whereas a pending one still might.
 */
export const STAFF_STATUS_BADGES = [
  "confirmed",
  "checked_in",
  "pending",
  "payment_not_confirmed",
] as const;

export type StaffStatusBadge = (typeof STAFF_STATUS_BADGES)[number];

export function staffStatusBadge(status: RegistrationStatus): StaffStatusBadge {
  switch (status) {
    case "confirmed":
      return "confirmed";
    case "checked_in":
      return "checked_in";
    case "pending_payment":
      return "pending";
    default:
      return "payment_not_confirmed";
  }
}

/** Organiser-supplied issue request (PRD §12's `label, expires_at`). */
export interface IssueStaffTokenCommand {
  /** Optional in the PRD ("optionally labeled", §4.6.1). */
  readonly label: string | null;
  /** `null` -> the default in {@link resolveStaffTokenExpiry}. */
  readonly expiresAt: Date | null;
}

/** Validated search input: the query plus the pagination PRD §12 fixes. */
export interface StaffSearchQuery extends PageRequest {
  readonly eventId: string;
  readonly query: string;
}

/** A check-in request body. `override` defaults to `false` (PRD §12). */
export interface CheckInCommand {
  readonly override: boolean;
}

/**
 * What the guarded write actually did.
 *
 * The adapter returns the *fact* and the service assigns the meaning, because the
 * same fact deserves different answers depending on what the caller asked for:
 * a registration that is already `checked_in` is a `409` without `override` and a
 * recorded row with it (skill step 7).
 */
export type RecordCheckInOutcome =
  | { readonly kind: "recorded"; readonly checkIn: CheckInRecord; readonly status: RegistrationStatus }
  | { readonly kind: "not_found" }
  | {
      readonly kind: "not_eligible";
      readonly status: RegistrationStatus;
    }
  | { readonly kind: "already_checked_in"; readonly originalCheckInAt: Date };

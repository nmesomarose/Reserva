/**
 * Staff-facing projections (rule 06: hand-defined DTOs, never serialized rows).
 *
 * Three things every DTO here does, each of them a requirement rather than a
 * style choice:
 *
 *   1. **No secret, to any role.** `StaffTokenRecord.tokenHash` has no field in any
 *      DTO below, and the issued-token response is the only one that carries the
 *      plaintext, once. Rule 06 and AGENTS.md §14 forbid returning a staff-token
 *      hash even to the organiser who issued it.
 *   2. **Masked contact details.** PRD §4.4.2 requires a disambiguation list
 *      showing "name + masked email/phone"; the staff skill repeats it as an
 *      integrity check. Door staff need to tell two Ada Lovelaces apart, not to
 *      read a stranger's address book.
 *   3. **Honest state.** A non-confirmed registration is never dressed as a
 *      ticket. `status` is the stored value, `status_badge` is PRD's own label, and
 *      `check_in_eligible` is `false` — the field a client reads to leave the
 *      check-in control out of the response entirely (AGENTS.md §11.2).
 *
 * What staff do *not* get, and it is worth being explicit because these are the
 * fields an attendee-facing endpoint would plausibly have: tier prices, tier
 * inventory counters, `unique_reference`, the payment row, and any provider
 * payload. Staff need to answer "is this person in, and has anyone let them in
 * already", and nothing else.
 */

import { staffStatusBadge, type CheckInRecord, type StaffSearchRow, type StaffStatusBadge, type StaffTokenRecord } from "./staff";

/**
 * A staff token as the organiser sees it: metadata and status, never a usable
 * secret (rule 05, "Organiser staff-token listing returns metadata and status").
 */
export interface StaffTokenDTO {
  readonly id: string;
  readonly event_id: string;
  readonly label: string | null;
  readonly expires_at: string;
  readonly revoked_at: string | null;
  readonly created_at: string;
  /**
   * `revoked` wins over `expired`. A token can only be `active` when it is neither,
   * and the order matters to the reader: a revoked token stays revoked forever
   * regardless of what its clock says, because "who pulled this" is the question an
   * organiser is actually asking when they look at a stale list.
   */
  readonly status: "active" | "revoked" | "expired";
}

/**
 * The one and only response that contains a usable token (PRD §4.6.1: "The
 * plaintext is shown once at creation, if at all"). It is not in the listing
 * projection above, and it is never logged.
 */
export interface IssuedStaffTokenDTO extends StaffTokenDTO {
  readonly token: string;
}

/**
 * One search hit.
 *
 * `check_in_eligible` is the field that makes FR-21 renderable: §4.3.4 requires the
 * action to be *absent* for a non-confirmed registration, which a client can only
 * do if the response says so explicitly rather than the client re-deriving it from
 * a status string.
 */
export interface StaffSearchResultDTO {
  readonly registration_id: string;
  readonly event_id: string;
  readonly attendee_name: string;
  readonly ticket_tier: string;
  /** The stored `Registration.status` — PRD's own enum, for machine branching. */
  readonly status: StaffSearchRow["status"];
  /** One of PRD §4.3.3's four labels. */
  readonly status_badge: StaffStatusBadge;
  /**
   * Whether `POST /registrations/{id}/check-in` would accept this registration
   * *as it stands*. `false` for a repeat check-in too, because a second attempt
   * needs an explicit `override` the client must ask for deliberately.
   */
  readonly check_in_eligible: boolean;
  readonly attendee_email_masked: string;
  readonly attendee_phone_masked: string;
  /**
   * The original check-in timestamp, or `null`. PRD §4.4.4: a registration that is
   * already checked in shows *when it first happened*, so staff are not asked to
   * guess from a badge. Read from the Check-in log, the source of truth (PRD §7.4).
   */
  readonly checked_in_at: string | null;
}

/**
 * Who performed a check-in, in a shape a client can render without a second
 * lookup. Auditability is mandatory (FR-20, PRD §14), so the actor is never
 * reduced to a boolean.
 *
 * The `kind` discriminant exists because the two actor kinds come from different
 * tables (rule 02's two-column representation of §7.2's `checked_in_by`), and a
 * client must not have to guess which id it is looking at.
 */
export type CheckInActorDTO =
  | { readonly kind: "staff_token"; readonly staff_token_id: string; readonly label: string | null }
  | { readonly kind: "organiser"; readonly organiser_id: string };

/** A recorded check-in row, as returned by the check-in endpoint. */
export interface CheckInDTO {
  readonly id: string;
  readonly registration_id: string;
  readonly checked_in_at: string;
  /**
   * `true` for a repeat check-in. The client is expected to treat it as a
   * deliberate, separately-auditable action (BR-4), never as a normal completion.
   */
  readonly is_override: boolean;
  readonly performed_by: CheckInActorDTO;
}

/**
 * The plaintext of an email, reduced to enough to disambiguate and no more.
 *
 * First and last character of the local part, the domain kept: `a***e@example.com`.
 * The domain is kept because it is the part that actually separates two people on
 * staff's lists — `ada@gmail.com` vs `ada@work.example` — and it identifies an
 * employer or provider, not a person. Everything that could be used to contact
 * someone is gone.
 *
 * Degenerate inputs are handled rather than assumed away, because "there is always
 * an `@`" is a claim about data that §11 only partially guarantees (it validates
 * email *format*, and a local part is never empty in practice):
 *
 *   - no `@` at all  -> mask all but the first character;
 *   - a one-character local part -> `*@domain`, since first *and* last of a single
 *     character is the character itself and would defeat the masking.
 */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");

  if (at === -1) {
    return maskTail(email, 1);
  }

  const local = email.slice(0, at);
  const domain = email.slice(at + 1);

  if (local.length <= 1) {
    return `*@${domain}`;
  }

  if (local.length === 2) {
    return `${local[0]}*@${domain}`;
  }

  return `${local[0]}***${local[local.length - 1]}@${domain}`;
}

/**
 * A phone number, reduced to its country/area prefix and last two digits:
 * `+23*********78`.
 *
 * The first three characters are kept because on staff lists the country or area
 * code is often the *point* of the disambiguation — the same person registering
 * with two numbers, or two people whose names differ only by a digit. The rest is
 * replaced with a fixed-width run of `*` so the string's length still reads as "a
 * phone number" without revealing it.
 *
 * A number too short to have a hidden middle keeps only its first characters, which
 * keeps the same prefix-is-the-useful-part rule rather than switching to a suffix.
 * Truncating rather than rejecting: this is a display projection, and a short
 * stored phone is still something the attendee gave us to be shown to a door
 * supervisor, not something to fail a search over.
 */
export function maskPhone(phone: string): string {
  const VISIBLE_PREFIX = 3;
  const VISIBLE_SUFFIX = 2;

  if (phone.length <= VISIBLE_SUFFIX) {
    return "*".repeat(Math.max(phone.length, 0));
  }

  if (phone.length <= VISIBLE_PREFIX + VISIBLE_SUFFIX) {
    return maskTail(phone, VISIBLE_SUFFIX);
  }

  const hidden = phone.length - VISIBLE_PREFIX - VISIBLE_SUFFIX;

  return `${phone.slice(0, VISIBLE_PREFIX)}${"*".repeat(hidden)}${phone.slice(-VISIBLE_SUFFIX)}`;
}

/** Keep the first `visiblePrefix` characters, mask everything after them. */
function maskTail(value: string, visiblePrefix: number): string {
  if (value.length <= visiblePrefix) {
    return "*".repeat(value.length);
  }

  return `${value.slice(0, visiblePrefix)}${"*".repeat(value.length - visiblePrefix)}`;
}

export function toStaffTokenDTO(
  token: StaffTokenRecord,
  now: Date = new Date(),
): StaffTokenDTO {
  return {
    id: token.id,
    event_id: token.eventId,
    // `""` is how an unlabelled token is stored (PRD §7.2's non-null column); `null`
    // is how it is reported. The wire shape gets one representation of "no label".
    label: token.label === "" ? null : token.label,
    expires_at: token.expiresAt.toISOString(),
    revoked_at: token.revokedAt === null ? null : token.revokedAt.toISOString(),
    created_at: token.createdAt.toISOString(),
    status: staffTokenStatus(token, now),
  };
}

/**
 * `active` / `revoked` / `expired`, evaluated server-side.
 *
 * The organiser's view is a list of their own tokens, so there is no enumeration
 * risk in being exact about which is which — and the distinction is the point of
 * the listing (§4.6.2: "view active tokens and revoke any of them immediately").
 */
export function staffTokenStatus(
  token: StaffTokenRecord,
  now: Date = new Date(),
): "active" | "revoked" | "expired" {
  if (token.revokedAt !== null) {
    return "revoked";
  }

  if (token.expiresAt.getTime() <= now.getTime()) {
    return "expired";
  }

  return "active";
}

/**
 * `StaffSearchRow` -> the one search hit a door staff sees.
 *
 * `check_in_eligible` is `status === "confirmed"` and nothing wider, which is
 * *not* the same test as the endpoint's {@link checkInEligible} guard, and the
 * difference is the requirement:
 *
 *   - The endpoint accepts `confirmed` **or** `checked_in` when `override=true`,
 *     because §4.4.4 allows a deliberate repeat check-in and the endpoint is the
 *     thing that must still refuse it without the flag.
 *   - The rendered control is offered for `confirmed` only. §4.3.4: "The
 *     check-in action is only rendered/enabled when status = Confirmed" — so a
 *     `checked_in` row shows its original timestamp and no plain control, and the
 *     override is a separate, deliberately-flagged action the operator has to ask
 *     for on purpose (BR-4).
 *
 * Answering `true` for a `checked_in` row would put a button on screen whose
 * ordinary click is a `409`, which is precisely the "re-click that looks like an
 * error" the PRD rules out.
 */
export function toStaffSearchResultDTO(row: StaffSearchRow): StaffSearchResultDTO {
  return {
    registration_id: row.registrationId,
    event_id: row.eventId,
    attendee_name: row.attendeeName,
    ticket_tier: row.ticketTypeName,
    status: row.status,
    status_badge: staffStatusBadge(row.status),
    check_in_eligible: row.status === "confirmed",
    attendee_email_masked: maskEmail(row.attendeeEmail),
    attendee_phone_masked: maskPhone(row.attendeePhone),
    checked_in_at: row.latestCheckInAt === null ? null : row.latestCheckInAt.toISOString(),
  };
}

/**
 * `CheckInRecord` -> DTO, with the actor resolved.
 *
 * `label` is passed in rather than looked up, because the caller is the one that
 * already read the acting token: the check-in transaction must not go back to
 * `staff_tokens` for a cosmetic field after it has committed.
 */
export function toCheckInDTO(checkIn: CheckInRecord, staffTokenLabel: string | null): CheckInDTO {
  if (checkIn.staffTokenId !== null) {
    return {
      id: checkIn.id,
      registration_id: checkIn.registrationId,
      checked_in_at: checkIn.checkedInAt.toISOString(),
      is_override: checkIn.isOverride,
      performed_by: {
        kind: "staff_token",
        staff_token_id: checkIn.staffTokenId,
        label: staffTokenLabel,
      },
    };
  }

  if (checkIn.organiserId === null) {
    // Unreachable: `check_ins_exactly_one_actor_check` rejects a row with neither
    // actor, and this is the last branch. Throwing beats emitting a check-in
    // record that claims nobody did it — an audit row with no actor is worse than a
    // loud failure, because it looks like data.
    throw new Error("A check-in row must name exactly one actor (organiser or staff token).");
  }

  return {
    id: checkIn.id,
    registration_id: checkIn.registrationId,
    checked_in_at: checkIn.checkedInAt.toISOString(),
      is_override: checkIn.isOverride,
      performed_by: { kind: "organiser", organiser_id: checkIn.organiserId },
    };
}


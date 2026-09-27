# Skill — Staff Event-Day Search & Check-in

## Purpose

Let a holder of an **event-scoped staff token** find the right attendee fast and
check them in **only** when payment is genuinely confirmed — with server-side
event scoping, an honest zero/many-match state, an **absent** check-in control for
non-confirmed registrations, and an append-only, auditable check-in log.

## When to use

- `GET /api/v1/events/{id}/registrations/search` (staff, event-scoped)
- `POST /api/v1/registrations/{id}/check-in` (staff, event-scoped)
- Organiser-side staff-token issue/list/revoke (`/staff-tokens`) when it affects
  who can search/check in
- Any change to search matching, status badges, or check-in behaviour

## Preconditions

- `StaffToken` exists with `event_id` scope, `token_hash`, `label`, `expires_at`,
  `revoked_at` (PRD §7.2); the transport mechanism itself is `[VERIFY /
  decide at implementation time]` (PRD §19; AGENTS.md §21.5) — the scope model
  does not depend on the choice.
- `Registration` indexes `(event_id, attendee_name)` and `(event_id, status)`
  exist to serve search and the dashboard.
- `Check-in` table exists (append-only) with index
  `(registration_id, checked_in_at DESC)`.
- The check-in eligibility guard (FR-21) is implemented **server-side** in the
  domain layer, not only in the UI (rule 03).
- The organiser auth mechanism exists (to issue/revoke tokens).

## Source requirements

PRD §3 (staff model), §4.3, §4.4, §4.6, §5.6 (FR-17, FR-18, FR-19),
§5.7 (FR-20, FR-21, FR-22), §6 (BR-4, BR-5), §7.2 (Check-in, StaffToken),
§9.4 (append-only lifecycle), §10 (search edge cases, double check-in),
§11 (search min 2 chars), §12 (search + check-in rows), §15 (`409` cases),
§16 (access-control + duplicate check-in tests), §18 (staff scoping, payload
privacy). AGENTS.md §7, §9, §10, §11.2, §14.

## Procedure

1. **Authenticate the staff token server-side.** Verify signature/format,
   `expires_at`, and `revoked_at`. A revoked or expired token is rejected **on
   this request** — not merely hidden in the UI (PRD §4.6.3, §18). Reject with a
   message distinct from a generic auth error (AGENTS.md §11.2).
2. **Derive the event scope from the token — never from the request.** The
   effective event is the token's `event_id`, resolved server-side. A
   client-supplied `event_id` that disagrees is a **rejected request**, not a
   scope override (PRD §18). Every query below is filtered by that scope.
3. **Search (FR-17).** Query by attendee **name** (primary), with
   **email/phone** as secondary/fallback. Validate `query` ≥ 2 characters.
   Return a paginated envelope with `page`, `page_size` (default 20, **max 50**).
   Show name, ticket tier, and status (Confirmed / Payment Not Confirmed /
   Pending / Checked In) with **masked** email/phone.
4. **Handle result states honestly (PRD §4.4).**
   - **Zero matches** → explicit "no registration found" **empty state with an
     escalation path** (manual lookup by email/phone), returned as **`200`** with
     an empty result set — never `404`, never a blank screen.
   - **Multiple matches** → a **disambiguation list** (name + masked email/phone +
     tier) so staff confirm identity before acting. Never an arbitrary single
     auto-pick.
   - **Payment not confirmed** → distinct status badge; the check-in control is
     **absent**, with an explicit escalation path to the organiser.
5. **Check in (FR-20/FR-21).** The eligibility guard runs server-side **inside
   the write transaction**: the registration must be in status `confirmed` or
   `checked_in`. Anything else → **`409`**. This endpoint-level rejection is the
   security boundary — a hidden button is not (AGENTS.md §7).
6. **Write append-only (BR-4, §9.4).** Insert a new `Check-in` row with
   `checked_in_at` and the acting identity. Never update or delete an existing
   row — both are rejected by database triggers, not merely discouraged.
   **The actor is written as exactly one of two nullable FKs**, `organiser_id`
   (organiser acting) or `staff_token_id` (staff token acting), never both and
   never neither. PRD §7.2 calls this single field `checked_in_by`; see rule 02
   "Schema representation decisions" for why it is two columns. The scope check
   still comes from the token's own `event_id`, read server-side — the FK records
   *who acted*, it never widens what they may touch.
7. **First vs repeat.** If no check-in exists → `is_override = false`. If one
   already exists → require an explicit `override = true` from the caller; with
   it, insert a **second, distinct** row with `is_override = true` (separately
   auditable). Without it → **`409`**, and the response shows the **original**
   check-in timestamp. An override is a deliberate, distinctly-flagged action,
   not a silent re-click.
8. **Update the cached projection in the same transaction.** Set
   `Registration.status = checked_in` in the **same transaction** as the insert
   (PRD §7.4). The Check-in log remains the source of truth for *when* and *by
   whom*.
9. **Surface the outcome.** Immediate, unambiguous check-in success; distinct
   messages distinguishing "already checked in" from "not eligible" for `409`
   (AGENTS.md §11.2).

## Integrity checks

- Staff scope comes from the **token's** `event_id`, server-side; never from a
  client-supplied `event_id` (rule 05).
- Staff can **only** search and check in. No event/tier configuration, no
  dashboard, no requests, no staff-token management, no other event, no raw
  provider data.
- Check-in eligibility (`confirmed` / `checked_in`) is enforced **by the
  endpoint**, returning `409` — not by disabling a UI control (FR-21, BR-5).
- A non-confirmed registration is **never** shown as a valid ticket (FR-19), and
  the check-in control is **absent**, not merely labelled (PRD §4.3.4).
- Check-in rows are **append-only**; no in-place edits or deletes (§9.4, §14).
  Database triggers reject both, so this is enforced rather than documented.
- A second check-in requires explicit `override=true` and is a **distinct**
  auditable row; without it, `409`.
- The actor FKs record **who** performed the check-in (staff token identity or
  organiser) — auditability is mandatory (FR-20, §14). A CHECK constraint
  enforces exactly one of `organiser_id` / `staff_token_id`.
- The `Registration.status` projection is written in the same transaction as the
  insert.
- Search responses **mask** email/phone; raw `raw_provider_payload` is never
  exposed to staff (rule 08).
- Empty search → `200` + empty set; multiple matches → disambiguation, never a
  silent single pick.

## Verification

- Staff token for event A cannot search or check in anything in event B; a
  forged/disagreeing `event_id` in the request is rejected.
- Revoked token → rejected on the **very next** request; expired token likewise.
- Search by name (primary) and by email/phone (fallback) both work; `query` < 2
  chars is rejected per validation.
- Zero-match → `200` with an empty set and a visible escalation path (not `404`).
- Multi-match → disambiguation list with masked contact details.
- Non-confirmed registration → check-in returns **`409`**, and the control is
  absent in the UI.
- First check-in → new row `is_override = false`; `Registration.status` becomes
  `checked_in` in the same transaction.
- Second check-in **without** override → `409` + original timestamp shown;
  **with** `override = true` → a second, distinct row with `is_override = true`.
- Concurrent duplicate check-ins do not produce two `is_override = false` rows.
- Search stays within the p95 < 500ms target (PRD §17) using the specified
  indexes.

## Stop conditions

- Matching appears to need fuzzy/phonetic search or ranking beyond the PRD
  contract → out of scope; flag, do not build.
- A check-in must be possible for a non-confirmed registration (e.g. an offline
  override) → that would contradict FR-21/BR-5; stop and raise it as a product
  decision.
- QR/scanner-based check-in is requested → explicitly out of scope (PRD §20).
- The staff-token transport is still `[VERIFY]` and you are about to fix a format
  → stop; the scope model is fixed, the transport is not.

## Required output

Report: what changed; the PRD requirements satisfied (FR-17/18/19/20/21, BR-4/5,
§4.4, §9.4, §12); files changed; how event isolation, revocation, the `409`
non-confirmed path, and the override row were tested; the search p95 evidence;
and any `[VERIFY]`/open item (staff-token transport) relied on.

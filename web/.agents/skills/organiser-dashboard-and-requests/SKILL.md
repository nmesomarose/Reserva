# Skill — Organiser Dashboard & Attendee Requests

## Purpose

Give the owning organiser (a) a truthful per-event operational picture —
registration counts, payment-status breakdown, tier sales/availability, check-in
counts, with check-ins propagating within 5 seconds — and (b) a working
attendee-request queue (view / respond / resolve) tied to the registration
record. Both are organiser-only, both read real data rather than derived
guesses.

## When to use

- `GET /api/v1/events/{id}/dashboard` (organiser)
- `GET /api/v1/events/{id}/requests` (organiser, `status` filter, paginated)
- `POST /api/v1/registrations/{id}/requests` (attendee, reference + email) — the
  write side that feeds this queue
- The dashboard's real-time check-in counter (SSE) and its propagation guarantee
- The individual registration record view, including full payment-attempt history
  and full check-in log (FR-26)

## Preconditions

- Organiser auth exists and the ownership check
  (`event.organiser_id == current_user.id`) is wired server-side on every request
  (rule 05).
- `Registration` indexes `(event_id, status)` (dashboard aggregation) and
  `(event_id, attendee_name)` exist; `Payment (registration_id)` and
  `Check-in (registration_id, checked_in_at DESC)` exist for the full record.
- `AttendeeRequest` exists with `UNIQUE(idempotency_key)`.
- Dashboard transport decision settled: **SSE** for the check-in counter
  (one-directional), per PRD §13. **WebSockets are not used** (AGENTS.md §16).
- Public ticket-availability on the public page is **short-interval polling
  (5–10s)**, not SSE — a different surface with a different decision (PRD §13).

## Source requirements

PRD §5.7 (FR-22, 5-second propagation), §5.8 (FR-23, FR-23a, FR-24),
§5.9 (FR-25, FR-26), §7.4 (cached `Registration.status` projection),
§10 (payment-status breakdown sources of truth), §12 (dashboard + requests
rows), §13 (real-time decisions), §14 (requests/resolutions retained),
§15 (status codes). AGENTS.md §7, §8, §10, §15, §16.

## Procedure

1. **Authorise first.** Organiser only, and verify ownership of
   `events/{id}` **server-side** before any query runs. Deny before reading data
   (IDOR — rule 05). Staff tokens and attendees never reach these endpoints.
2. **Dashboard aggregates (FR-25).** Return per-event counts:
   - total **registrations**;
   - **payment-status breakdown** — derive it from the authoritative source per
     status (the `Payment` rows and their lifecycle, not a guess). Note
     `Registration.status` is a cached projection; aggregate the *payment*
     breakdown from the payment lifecycle (rule 02);
   - **tier sales / availability** — per tier: `quantity_total`,
     `quantity_confirmed`, `quantity_held`, and derived `available`
     (`= total − confirmed − held`);
   - **check-ins** count (FR-25). Source of truth is the Check-in log
     (append-only); the cached `Registration.status = checked_in` may be used as
     the fast filter (PRD §7.4), with the log as the authority.
3. **Zero-discrepancy requirement.** "Dashboard counts match underlying data with
   zero discrepancy" (PRD §17). If a count and the underlying rows disagree, that
   is a defect (usually a projection written outside its transaction — rule
   03/07) — fix the write path, not the number.
4. **Real-time check-in counter (FR-22, §13).** Push check-in count updates to
   the organiser dashboard over **SSE**, one-directional, meeting the **≤ 5
   second** propagation target. Do **not** introduce WebSockets (AGENTS.md §16).
   The SSE stream is organiser-scoped to their event.
5. **Individual registration record (FR-26).** Organiser-only view returning the
   **full** record: registration + **all** `Payment` attempts (not just the
   latest) + the **full** `Check-in` log (not just current status). This is the
   organiser/audit surface, so `raw_provider_payload` may be included here and
   **only** here (rule 08).
6. **Attendee request — write (FR-23, FR-23a).** Attendee submits `message` +
   required `idempotency_key` against a registration authorised by
   **reference + email**. A missing/incorrect pair → `400` per the contract.
   Duplicate rapid-fire submissions are debounced by `idempotency_key`
   (FR-23a) — `UNIQUE` + transaction, replay returns the original.
7. **Requests queue — read (FR-24).** `GET /events/{id}/requests` with optional
   `status` filter (`open`/`resolved`) and the standard paginated envelope
   (`page`, `page_size` default 20 / max 50, `{ data, page, page_size, total }`).
   Ownership-checked; requests are scoped to the event's registrations.
8. **Respond & resolve.** The organiser can respond and mark a request
   `resolved`, recording `resolution_notes` and `resolved_at`. **Requests and
   their resolutions are retained, never deleted** (PRD §14, §20).

## Integrity checks

- Organiser-only, ownership verified server-side **before** any data read
  (IDOR; rule 05).
- Dashboard counts derive from the authoritative rows; the cached
  `Registration.status` is used only as the sanctioned fast filter (PRD §7.4),
  never as a substitute for the payment lifecycle for the payment breakdown.
- `available` is **derived** (`total − confirmed − held`), never read from a
  client or stored as a third counter.
- Check-in count propagation ≤ 5s via **SSE only**; no WebSockets introduced.
- Attendee-request submission requires **reference + email** authorisation and a
  client-supplied `idempotency_key`; replays return the original and create no
  duplicate row.
- Requests/resolutions are **retained**, never deleted (PRD §14).
- `raw_provider_payload` is organiser/audit-only — never in attendee or staff
  responses (rule 08).
- The individual-record view returns **all** payment attempts and **all**
  check-in rows (FR-26), not a truncated latest-only view.

## Verification

- Organiser sees only their own event's dashboard; another organiser gets denied
  (IDOR test); a staff token is denied.
- Dashboard counts reconcile with the underlying rows (registrations, per-status
  payment counts, per-tier confirmed/held/available, check-in count) — zero
  discrepancy.
- Check-in counter on the dashboard updates within **5 seconds** of a check-in
  (SSE).
- Individual registration record shows every payment attempt and every check-in
  row, including overrides.
- Attendee submits a request with reference+email → appears in the organiser
  queue; wrong email → `400` per the contract; duplicate `idempotency_key` →
  original returned, no second row.
- Organiser filters requests by `status`; pagination envelope and `page_size ≤
  50` behave as specified.
- A resolved request's notes/timestamp are retained and visible; nothing is
  hard-deleted.

## Stop conditions

- A new dashboard metric, filter, or breakdown is requested that FR-25 does not
  name → flag; do not add speculative metrics.
- Real-time is requested for the **public** availability page → PRD §13 specifies
  polling (5–10s) there, SSE only on the organiser dashboard; stop and clarify.
- WebSockets are proposed for anything → explicitly rejected (AGENTS.md §16);
  require an explicit PRD update first.
- The cached `Registration.status` projection and the Check-in log disagree and
  the cause is not a missing same-transaction write → stop and report rather
  than recomputing/patching the stored value ad hoc (rule 03).

## Required output

Report: what changed; the PRD requirements satisfied (FR-22/23/23a/24/25/26,
§13, §14, §17); files changed; how zero-discrepancy counts, the ≤5s SSE
propagation, request idempotency, and IDOR denial were verified; and any
`[VERIFY]`/open item relied on.

# Rule 05 — Authentication, Authorization & Event Scope

**Axis: who may perform an action, and over which event.** Rule 08 owns what
data may be exposed once access is granted.

PRD §3 fixes the **authorization model** (who can do what, scoped how). The
session/token technology is explicitly an implementation-time decision
(`[VERIFY / decide at implementation time]`, PRD §19; AGENTS.md §21.4–5) — do
not invent a scheme and present it as decided. **Whatever** is chosen, the model
below is non-negotiable.

**All authorization is server-side.** A client-provided `event_id`, role claim,
ownership assertion, or status value is never trusted without a server-side
check against the authenticated identity (PRD §18, AGENTS.md §4, §7).

## Three access tiers

### Public / Attendee — no platform account

Can: view a published event; submit a registration; initiate/complete payment;
retrieve **their own** evidence via **reference + email**; submit an issue tied
to their own registration.

Cannot: view any organiser dashboard, any staff search, any check-in, or any
event not `published`.

There is no attendee login, no attendee account table, and no cross-event
attendee identity (PRD §7.1, §20).

### Organiser — full platform account

Can manage **only** events where `event.organiser_id == current_user.id`:
event CRUD, programme, tiers, dashboard, attendee requests, staff-token issue
and revocation, and the full registration record.

- The ownership check is performed **server-side on every organiser-scoped
  request** — not once at login, not cached as a client assumption (AGENTS.md
  §14).
- `event_id` in a path or body is an **input to the check**, never the check
  itself. Another organiser's event id must yield denial, not their data.
- IDOR is an explicit test case (PRD §16), not a theoretical concern.
- One organiser may own many events; there are no teams, sub-accounts, or
  per-event organiser roles (PRD §20).

### Staff / Usher — event-scoped token, **not** an account

Granted per event by the organiser as a time-limited invite (PRD §3, §4.6).

`StaffToken` carries: `event_id` (the scope), `token_hash`, `label`,
`expires_at`, `revoked_at`, `created_at`.

Within its one event, staff may **only**: search registrations, and check
attendees in.

Staff must **not**:

- see any other event, or the existence of other events;
- create, edit, or delete events, programme items, or tiers;
- view the organiser dashboard or attendee requests;
- see raw payment-provider data or any internal counter (rule 08);
- issue, list, or revoke staff tokens;
- act as an organiser on any resource.

**Scope is read from the token server-side, never from the request.** A staff
request's effective event is the token's `event_id` — a body/query `event_id`
that disagrees is a rejected request, not a scope override (PRD §18).

## Token lifecycle

- **Expiry:** `expires_at` defaults to the event's end date plus a short grace
  window (PRD §3). The `[VERIFY]`-open part is the transport format, not the
  expiry semantics.
- **Revocation:** the organiser can invalidate immediately. `DELETE` on the
  staff-tokens endpoint is revocation, not row deletion.
- **A revoked or expired token is rejected server-side on its very next
  request** — not merely hidden in the UI (PRD §4.6.3, §18). The rejection is
  distinct from a generic auth error so the UI can show the right message
  (AGENTS.md §11.2).
- Only a **hash** of the token is stored. The plaintext is shown once at
  creation, if at all, and never persisted or logged (rule 08).
- Organiser staff-token listing returns metadata and status — never a usable
  secret or its hash.

## Attendee evidence lookup — two-factor

- Retrieval requires **unique_reference AND matching email**. Reference alone is
  **not sufficient**: it must resist enumeration (PRD §3, §15, §18).
- Compare the supplied email against the stored `attendee_email`; on mismatch
  return **`403`, never `404`** — a `404` would confirm which references exist
  (rule 06 owns the status-code contract; the enumeration rationale is rule 08).
- The same reference+email pair is the authorization basis for submitting an
  attendee request, and it must be re-verified per request — not cached from an
  earlier evidence lookup in the same session.
- Evidence returns **live** event details (name, date, venue), not a snapshot
  (BR-6, rule 02).

## Server-side enforcement checklist

For every non-public endpoint, before any business logic:

1. Identify the caller's tier from the **verified** credential, not the request.
2. Resolve the target resource and its owning `event_id` server-side.
3. Compare the resolved scope against the caller's permitted scope.
4. Deny **before** reading or returning resource data.
5. Record the denial in a way that is auditable without logging secrets.

Failure mode to design against: a handler that reads the row first and checks
ownership afterwards, or that returns `404` where `403` is specified (or vice
versa) and thereby leaks existence.

## Stop conditions

- The chosen token/session mechanism cannot express per-event scope with
  revocation — stop; the scope model is not negotiable, the transport is
  (PRD §3).
- A requirement appears to need a platform-wide role, a cross-event staff
  account, or a shared attendee identity → out of scope (PRD §7.1, §20); stop
  and report rather than widening the model.
- A new endpoint is needed with an auth context the PRD §12 table does not
  cover → that is an API-contract change (rule 06); stop and flag it.

## Related

- `06-api-contract-and-validation.md` — the per-endpoint auth context
- `07-concurrency-idempotency-and-check-in.md` — duplicate check-in behaviour
- `08-security-privacy-and-evidence.md` — token secrecy, evidence privacy

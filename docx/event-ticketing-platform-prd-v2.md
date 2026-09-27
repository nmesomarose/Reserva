# Product Requirements Document: Event Management & Ticketing Platform (v2)

**Status:** Revised v2 — incorporates audit corrections
**Author:** Product/Engineering
**Last updated:** 2026-09-25
**Supersedes:** v1 (2026-09-25)

> **Changelog from v1 (audit-driven):** Registration↔Payment corrected to 1:N; Registration↔Check-in corrected to 1:N; organiser/usher authentication & authorization model added (was entirely absent); explicit field types, constraints, and indexes added to the data model; monetary values specified as integer minor units; forbidden lifecycle transitions enumerated; API contracts made literal and versioned (`/api/v1`); pagination/filtering contracts added; duplicate-submission (idempotency-key) protection added; the "payment verified but ticket creation fails" failure mode is now addressed; vague language replaced with numeric thresholds; Attendee entity folded into Registration to remove an unresolved cross-event identity ambiguity (documented as a deliberate scope decision below); a deliberate-denormalisation section added.

---

## 1. Problem Statement

Event organisers today struggle to reliably answer one question on event day: *"Is this person actually registered, and what did they pay for?"* Attendees, meanwhile, are often left uncertain about what they've paid for, whether their payment "counted," and what to expect once they arrive.

This product exists to close that gap. It gives attendees a frictionless way to discover event details, pay securely, and carry verifiable proof of registration. It gives organisers and their on-the-ground staff (ushers) a fast, reliable way to confirm that proof at the door — without manual lookup, without ambiguity, and without ever falsely confirming a ticket that hasn't actually been paid for.

The product is not a general-purpose event marketing or community platform. Its job is registration, payment, verification, and check-in, done correctly.

---

## 2. Personas & Responsibilities

| Persona | Description | Responsibilities / Goals | Account type |
|---|---|---|---|
| **Attendee** | A person registering for and/or attending an event. | Understand what they're paying for, pay without friction, receive proof of registration, get checked in smoothly, raise issues if something's wrong. | No platform account required — identified by registration reference + email. |
| **Organiser** | The owner of an event — creates it, configures ticket tiers, needs operational visibility. | Create/manage events and ticket types, monitor registrations/payments/check-ins, resolve attendee issues, manage staff access. | Full platform account (email + password or magic link — `[VERIFY final auth method against build stack]`). |
| **Staff / Usher** | Event-day personnel who verify and check in attendees. | Search for an attendee quickly, see registration + tier status unambiguously, mark them checked in. | **Event-scoped staff access**, granted by the organiser as a time-limited invite (see Section 3 below). Not a full organiser account. |

**Roles considered and rejected:**
- *Dedicated attendee-support agent role* — rejected; issues route to the organiser's own inbox view, tied to the registration record. [ASSUMPTION, unchanged from v1]
- *Platform-wide super-admin* — out of scope for v1 (Section 20).

---

## 3. Authentication & Authorization Model *(new in v2 — corrects a critical gap)*

This section did not exist in v1. Its absence meant every access-control statement elsewhere in the document ("access-controlled to the owning organiser") was unenforceable. It is now a **must-have**, not an implementation detail deferred to later.

- **Organiser accounts** are full platform accounts. An organiser can own multiple events. All organiser-scoped resources (events, ticket types, dashboard, attendee requests) are authorized by checking `event.organiser_id == current_user.id`.
- **Staff/usher access** is granted **per event**, not as a platform-wide role. An organiser generates a **staff access token** scoped to one event, with:
  - an expiry (defaults to the event's end date + a short grace window),
  - a revocation capability (organiser can invalidate it at any time),
  - no ability to see other events, edit event/tier configuration, or view payment provider details — staff access is scoped strictly to search + check-in for that one event.
- **Attendees** do not have platform accounts. Ticket-evidence retrieval is authorized by possession of the unique registration reference **plus** the registration email (two-factor lookup — reference alone is not sufficient to prevent enumeration; see Section 12 Security).
- **All API endpoints below are annotated with their required authorization context.**
- Session/token mechanism (JWT vs. server session, exact staff-token format) is an implementation choice deferred to the engineering phase — this PRD fixes the *authorization model* (who can do what, scoped how), not the specific token technology. `[VERIFY / decide at implementation time]`

---

## 4. Primary User Journeys

*(Unchanged in substance from v1; the check-in journey is corrected so that the check-in action is unavailable — not merely discouraged — when payment isn't confirmed, per audit Section C.)*

### 4.1 Attendee: Discover → Register → Pay → Receive Ticket (Happy Path)
1. Attendee opens the event page and sees event details, programme, and ticket tiers with live availability.
2. Attendee selects a tier and submits registration details (name, email, phone — Section 11 validation).
3. Attendee is redirected to Flutterwave to complete payment.
4. Payment succeeds; Flutterwave redirects the attendee back.
5. The platform does **not** treat the redirect as proof. It independently verifies server-side (Section 8).
6. On verified success, the system confirms the registration and issues the ticket **atomically** — see Section 8.5 for the exact transaction boundary that prevents "paid but no ticket."
7. Attendee receives confirmation (email, minimum) with their registration reference and ticket tier.
8. Attendee can retrieve ticket evidence later via reference + email (Section 3).

### 4.2 Attendee: Payment Fails or Is Uncertain
1. Payment fails, is abandoned, or reports pending.
2. Attendee sees an explicit, honest state — never a false success or false failure.
3. On eventual webhook resolution, the registration updates automatically; no further attendee action required.

### 4.3 Staff: Event-Day Search & Check-in (Happy Path)
1. Staff member authenticates with their event-scoped access token.
2. Staff searches by attendee name (Section 11 — search contract).
3. Result shows attendee name, ticket tier, and status badge (Confirmed / Payment Not Confirmed / Pending / Checked In).
4. **The check-in action is only rendered/enabled when status = Confirmed.** For any other status, the action is absent, not merely labeled — this is now an explicit functional requirement (FR-21, revised) rather than a process instruction to staff.
5. Staff confirms attendee identity (name + partial email/phone shown for disambiguation — Section 4.4) before completing check-in.
6. System records the check-in event (Section 9.4 — Check-in is an append-only log, not a single mutable field).

### 4.4 Staff: Ambiguous or Problem Search Results
1. **Zero matches:** explicit "no registration found" state with an escalation path (manual lookup by email/phone).
2. **Multiple matches:** disambiguation list showing name + masked email/phone + ticket tier, so staff can confirm identity before acting — added in v2 to reduce wrong-person check-in risk (audit Section C).
3. **Payment not confirmed:** the check-in control is unavailable (Section 4.3.4); staff sees an explicit escalation path to the organiser.
4. **Already checked in:** shows original check-in timestamp; a **new**, explicitly-flagged override check-in can be recorded (a new append-only row, not an edit to the original — Section 9.4).

### 4.5 Organiser: Event Setup
Unchanged from v1 — create event, configure tiers, publish, monitor live operational status.

### 4.6 Organiser: Staff Access Management *(new in v2)*
1. Organiser generates a staff access token for an event, optionally labeled (e.g., "Door Team A").
2. Organiser can view active tokens and revoke any of them immediately.
3. Revoked/expired tokens are rejected at the API level on the next request, not just hidden in the UI.

### 4.7 Organiser: Attendee Issue Handling
Unchanged from v1 — issue tied to registration record, resolution retained for audit.

---

## 5. Functional Requirements

### 5.1 Event Creation & Information
- FR-1: Organiser can create an event with: name, description, start/end date-time, venue, status (`draft` / `published` / `closed`).
- FR-2: Organiser can define an ordered programme (explicit `sort_order` integer field — v1 gap closed).
- FR-3: Attendees can view a published event without authentication.
- FR-4: Organiser can edit event details pre- and post-publication; edits to date/venue are logged (Section 14) and attendee notification is a supporting, not must-have, capability (Section 20).

### 5.2 Ticket Types / Tier Configuration
- FR-5: Organiser defines one or more tiers per event: name, `price_minor_units` (integer), `currency` (ISO 4217 code), `quantity_total`, description.
- FR-6: Availability is tracked via two counters, not one (corrects v1 Contradiction #3 — see Section 7): `quantity_confirmed` and `quantity_held`. Displayed availability = `quantity_total - quantity_confirmed - quantity_held`, and this value must never go negative — enforced at the database level (Section 9.3).
- FR-7: Organiser can manually close a specific tier independent of the whole event.

### 5.3 Registration
- FR-8: Attendee provides required details before being routed to payment.
- FR-9: A registration is not `confirmed` until payment is verified server-side; a non-confirmed registration is never presented to staff tooling as valid (enforced per FR-21 revision above).
- FR-10 *(revised)*: Exactly one **Payment attempt** per registration may reach `success`. Multiple payment attempts against the same registration are supported (Registration is 1:N Payment — corrects v1 Contradiction #1); the system prevents more than one of them from resulting in a confirmed ticket (Section 9.1).
- FR-10a *(new)*: Duplicate submission of the registration form (e.g., double-submit) is prevented via a client-supplied idempotency key on the registration-creation request (Section 11 — Registration API).

### 5.4 Payment (Flutterwave)
- FR-11: Attendee is routed to Flutterwave-hosted payment for a server-computed amount — **the amount is always computed server-side from the stored `TicketType.price_minor_units`, never accepted from client input** (closes a price-tampering gap identified in the audit's Security section).
- FR-12: Server-side verification (redirect-check + webhook) is mandatory; client/redirect state is never authoritative.
- FR-13: Payment states: `initiated`, `processing`, `success`, `failed`, `pending`.
- FR-13a *(new)*: **Webhook is the eventual source of truth.** If a redirect-triggered verification call and a later webhook disagree about outcome for the same `provider_reference`, the webhook's result governs, and the registration is reconciled accordingly (closes the "redirect-check and webhook disagree" gap from the audit's Failure Matrix).

### 5.5 Confirmation & Ticket Evidence
- FR-14: On verified success, attendee receives a confirmation with registration reference and ticket tier.
- FR-15: Ticket evidence is retrievable via **reference + email** (two-factor, not reference alone — Section 3, Section 12).
- FR-16 *(corrected)*: Ticket evidence's unique reference is **for the attendee's own retrieval only**. Event-day search (FR-17) is name-based by design; v1 does not require staff to use the reference for search. (Resolves v1 Contradiction #2 — a reference-based fast-lookup at check-in is listed as a Future Possibility in Section 20, not a v1 requirement.)

### 5.6 Event-Day Search & Verification
- FR-17: Staff can search registrations, scoped to one event, by attendee name (primary) and email/phone (secondary/fallback).
- FR-18: Results show match(es), ticket tier, and status (Confirmed / Not Confirmed / Pending / Checked In) — response time target: **p95 under 500ms** for a single-event search (numeric threshold added, closes v1 vagueness).
- FR-19: The system never displays a non-confirmed payment as a valid ticket; the check-in action is programmatically unavailable in that case (FR-21).

### 5.7 Check-in
- FR-20: Staff can check in a confirmed registration, capturing timestamp and staff-token identity.
- FR-21 *(revised, was advisory in v1)*: The check-in action is **not rendered/enabled** by the API for any registration whose current status is not `confirmed`. This is a server-side authorization rule, not a UI convention — the check-in endpoint itself returns `409` if called against a non-confirmed registration.
- FR-22 *(revised)*: Check-in status is reflected in the organiser dashboard within **5 seconds** (numeric threshold added; transport decision in Section 13).

### 5.8 Attendee Requests / Issues
- FR-23: Attendee can submit a request tied to their registration.
- FR-23a *(new)*: Duplicate rapid-fire submissions are debounced via the same idempotency-key mechanism as FR-10a.
- FR-24: Organiser can view, respond to, and resolve requests; resolution is retained (Section 14).

### 5.9 Organiser Operational Records & Reporting
- FR-25: Organiser can view per-event aggregate counts (registrations, payment-status breakdown, tier sales/availability, check-ins).
- FR-26: Organiser can view an individual registration's full record, including its payment-attempt history (not just the latest) and its full check-in log (not just current status).

---

## 6. Business Rules (revised)

- BR-1: A registration is `confirmed` only via independently-verified successful payment. No other signal confers confirmed status.
- BR-2 *(revised)*: A `provider_reference` may only ever be associated with one Payment row, enforced by a **unique database constraint**, not application logic alone (closes v1's "idempotency described only in prose" gap).
- BR-3 *(revised, replaces v1 BR-3/BR-3a — resolves Contradiction #3)*: Tier availability is governed by two counters:
  - `quantity_confirmed` — incremented only on a payment reaching `success`.
  - `quantity_held` — incremented when an attendee is routed to payment, decremented automatically when the hold expires (**hold window: 15 minutes**, numeric threshold added) or when the associated payment resolves (success or failure).
  - Displayed "available" = `quantity_total - quantity_confirmed - quantity_held`, and the database enforces `quantity_confirmed + quantity_held <= quantity_total` as a check constraint.
- BR-4 *(revised)*: Check-in is an **append-only log** (Section 9.4). "Currently checked in" is derived from the latest Check-in row for a registration, not a single overwritable field. A second check-in requires an explicit `override=true` flag on the request and is recorded as its own row, distinctly auditable from the first (closes v1 Contradiction #6).
- BR-5: Staff cannot check in a registration whose payment is not confirmed — now enforced at the API level (FR-21), not staff judgment alone.
- BR-6 *(clarified — resolves Contradiction #4)*: Ticket evidence displays **live** event details (name, date, venue) rather than a frozen snapshot; only the registration reference and ticket tier are fixed at issuance. Organiser edits to event facts are therefore reflected in evidence views automatically; edits are logged (Section 14) so a "why did this change" question is answerable, but no snapshot-divergence problem exists to resolve.
- BR-7: Refund/cancellation, if it occurs, transitions a registration to `cancelled`/`refunded`, a state from which check-in is a forbidden transition (Section 10). Refund *processing* remains out of v1 scope (Section 20); only the resulting state must exist.

---

## 7. Data Entities & Relationships (revised — types, constraints, identifiers added)

### 7.1 Deliberate scope decision: no separate Attendee entity in v1

v1 modeled a separate `Attendee` entity with an unresolved identity question (is email a natural key across events, or a fresh row per registration?). **v2 resolves this by removing the ambiguity**: attendee name/email/phone are captured as fields directly on the `Registration` row. This is a deliberate simplification, justified because:
- Nothing in the stated problem requires cross-event attendee history or a persistent attendee profile.
- It removes a modeling ambiguity without losing any required capability (search, evidence retrieval, and issue-tracking all work fine scoped to a single registration).
- If cross-event attendee accounts become a real requirement later, this is a additive schema change (extract a new `Attendee` table and backfill), not a breaking one.

### 7.2 Entities

**Event**
| Field | Type | Required | Notes |
|---|---|---|---|
| id | UUID (generated) | yes | Primary key |
| organiser_id | UUID (FK → Organiser) | yes | `RESTRICT` on delete |
| name | string | yes | |
| slug | string | yes | Unique, used for public URL lookup |
| description | text | yes | |
| starts_at | timestamp (tz-aware) | yes | |
| ends_at | timestamp (tz-aware) | yes | |
| venue | string | yes | |
| status | enum(`draft`,`published`,`closed`) | yes | Default `draft` |
| created_at | timestamp | yes | |
| updated_at | timestamp | yes | |
| deleted_at | timestamp, nullable | — | Soft delete (Events with Payments must never be hard-deleted — audit requirement, Section 14) |

Constraints: `UNIQUE(slug)`. Index: `(organiser_id, status)` for organiser's event list.

**Programme Item**
| Field | Type | Required | Notes |
|---|---|---|---|
| id | UUID | yes | |
| event_id | UUID (FK → Event) | yes | `CASCADE` on delete |
| sort_order | integer | yes | Explicit ordering (v1 gap closed) |
| time | timestamp or string | yes | |
| title | string | yes | |
| description | text | no | |
| created_at / updated_at | timestamp | yes | |

Index: `(event_id, sort_order)`.

**Ticket Type**
| Field | Type | Required | Notes |
|---|---|---|---|
| id | UUID | yes | |
| event_id | UUID (FK → Event) | yes | `RESTRICT` on delete if Registrations exist |
| name | string | yes | e.g. "VIP" |
| description | text | no | |
| price_minor_units | integer | yes | e.g. kobo for NGN |
| currency | string(3) | yes | ISO 4217, e.g. `NGN` |
| quantity_total | integer | yes | |
| quantity_confirmed | integer | yes | Default 0 |
| quantity_held | integer | yes | Default 0 |
| created_at / updated_at | timestamp | yes | |

Constraints: `UNIQUE(event_id, name)`; `CHECK(quantity_confirmed + quantity_held <= quantity_total)`; `CHECK(quantity_confirmed >= 0 AND quantity_held >= 0)`.
Index: `event_id`.

**Registration**
| Field | Type | Required | Notes |
|---|---|---|---|
| id | UUID | yes | |
| event_id | UUID (FK → Event) | yes | `RESTRICT` |
| ticket_type_id | UUID (FK → TicketType) | yes | `RESTRICT` |
| unique_reference | string | yes | Non-guessable (min. 128 bits entropy); `UNIQUE` |
| attendee_name | string | yes | |
| attendee_email | string | yes | |
| attendee_phone | string | yes | Required (resolves v1 open question — recommended and adopted) |
| status | enum(`pending_payment`,`confirmed`,`checked_in`,`cancelled`,`refunded`) | yes | `checked_in` added to close v1 Contradiction #5; cached for fast filtering — see Section 7.3 denormalisation note |
| idempotency_key | string | yes | `UNIQUE`; client-supplied on creation to prevent duplicate-submit (FR-10a) |
| created_at / updated_at | timestamp | yes | |

Constraints: `UNIQUE(unique_reference)`, `UNIQUE(idempotency_key)`.
Indexes: `(event_id, attendee_name)` for search; `(event_id, status)` for dashboard aggregation.

**Payment (attempt)**
| Field | Type | Required | Notes |
|---|---|---|---|
| id | UUID | yes | |
| registration_id | UUID (FK → Registration) | yes | `RESTRICT` — **1:N**, corrects v1 |
| provider_reference | string | yes | `UNIQUE` — the idempotency key |
| expected_amount_minor_units | integer | yes | Server-computed from TicketType at initiation |
| verified_amount_minor_units | integer | no | Populated on verification; mismatch blocks confirmation (Section 11 validation) |
| currency | string(3) | yes | |
| status | enum(`initiated`,`processing`,`success`,`failed`,`pending`) | yes | |
| verified_at | timestamp, nullable | no | |
| raw_provider_payload | JSON | no | Retained for audit/dispute (Section 14) |
| created_at / updated_at | timestamp | yes | |

Constraints: `UNIQUE(provider_reference)` — **the single most important constraint in the schema**; enforces idempotency at the database level (closes v1's biggest gap).
Index: `registration_id`.

**Check-in (event log, not a status field)**
| Field | Type | Required | Notes |
|---|---|---|---|
| id | UUID | yes | |
| registration_id | UUID (FK → Registration) | yes | **1:N** — corrects v1's stated 0..1 |
| checked_in_at | timestamp | yes | |
| checked_in_by | UUID (FK → StaffToken or Organiser) | yes | Identifies who performed it |
| is_override | boolean | yes | Default false; true for any check-in after the first |
| created_at | timestamp | yes | |

Index: `(registration_id, checked_in_at DESC)` — for finding the latest check-in fast.

**Attendee Request / Issue**
| Field | Type | Required | Notes |
|---|---|---|---|
| id | UUID | yes | |
| registration_id | UUID (FK → Registration) | yes | `RESTRICT` |
| message | text | yes | |
| status | enum(`open`,`resolved`) | yes | |
| resolution_notes | text | no | |
| idempotency_key | string | yes | `UNIQUE` — prevents duplicate submission |
| created_at / resolved_at | timestamp | yes/no | |

**Organiser** and **StaffToken** (new in v2)
| Entity | Key fields |
|---|---|
| Organiser | id, email (unique), password_hash or auth_provider_id, created_at |
| StaffToken | id, event_id (FK → Event, `CASCADE`), token_hash, label, expires_at, revoked_at (nullable), created_at |

### 7.3 Corrected cardinality summary

- Organiser 1:N Event
- Event 1:N ProgrammeItem, TicketType, Registration, StaffToken
- TicketType 1:N Registration
- **Registration 1:N Payment** *(corrected from v1's 1:1)*
- **Registration 1:N Check-in** *(corrected from v1's 0..1)*
- Registration 1:N AttendeeRequest

No N:N relationships exist in this model — stated deliberately, not by omission.

### 7.4 Deliberate denormalisation (new section)

- `Registration.status` includes a cached `confirmed`/`checked_in` value, even though `checked_in` state is technically derivable from "does a non-superseded Check-in row exist." This is a deliberate denormalisation: it lets the search/dashboard queries (FR-18, FR-25) filter and aggregate on a single indexed column instead of joining against Check-in for every list view. The Check-in table remains the source of truth for *when* and *by whom*; `Registration.status` is a maintained projection of it, updated in the same transaction as any Check-in insert.
- Ticket evidence intentionally does **not** snapshot event details (Section 6, BR-6) — the opposite of denormalisation, chosen deliberately so a single edit to venue/date doesn't require reconciling historical snapshots.

---

## 8. Payment Verification Requirements (revised)

- The platform never treats a client-side/browser redirect as proof of payment success.
- On redirect, the platform calls Flutterwave's server-side transaction verification using the transaction reference before any confirmation. **[VERIFY exact endpoint/response schema against current Flutterwave docs.]**
- The platform also handles Flutterwave's webhook notification, since it may arrive before, after, or instead of the redirect. **[VERIFY webhook event types/payload/signature mechanism against current Flutterwave docs.]**
- Webhook authenticity is verified before any state change. **[VERIFY exact mechanism.]**
- **8.5 Atomic confirmation transaction (new — closes the "payment verified but ticket creation fails" gap):** the sequence — mark Payment `success` + verify amount matches expected + increment `TicketType.quantity_confirmed` + decrement `quantity_held` + set `Registration.status = confirmed` — occurs inside a **single database transaction**. If any step fails, the entire transaction rolls back, the Payment row remains at its pre-transaction status, and a retry (safe, because of the `provider_reference` uniqueness constraint) will attempt the same sequence again rather than silently leaving a "money captured, no ticket" state. If retries are exhausted, the transaction is flagged for manual reconciliation (a queryable "requires_reconciliation" state) rather than surfaced to the attendee as failure — since the payment *did* succeed.
- **8.6 Redirect/webhook disagreement (new — closes an audit-identified gap):** the webhook is the eventual source of truth. A redirect-triggered verification result is treated as provisional; if a later webhook for the same `provider_reference` reports a different outcome, the webhook's result overwrites the provisional one, and the registration is reconciled (including reversing a provisional confirmation if the webhook reports failure/chargeback — `[VERIFY whether Flutterwave can report a post-success reversal via webhook]`).

---

## 9. Lifecycles (revised — forbidden transitions added)

### 9.1 Payment Lifecycle
```
INITIATED → PROCESSING → SUCCESS (verified) → CONFIRMED [terminal]
                       → FAILED               [terminal]
                       → PENDING → (resolves to SUCCESS or FAILED)
```
**Forbidden:** INITIATED → CONFIRMED directly (must pass through verification); FAILED → SUCCESS (a failed attempt cannot later succeed — a *new* Payment attempt row is created instead, per corrected 1:N cardinality).

### 9.2 Registration Lifecycle
```
PENDING_PAYMENT → CONFIRMED (on a Payment attempt reaching verified success)
                → CANCELLED (all payment attempts failed / hold expired with no successful attempt)
CONFIRMED → CHECKED_IN (derived/cached — see Section 7.4)
CONFIRMED → REFUNDED/CANCELLED (if refund occurs)
```
**Forbidden:** CANCELLED → CONFIRMED; CANCELLED/REFUNDED → CHECKED_IN; CHECKED_IN → PENDING_PAYMENT (no backward transitions).

### 9.3 Ticket Availability "Lifecycle" (per unit, conceptual — not a stored per-unit row)
```
AVAILABLE → HELD (payment initiated) → CONFIRMED (payment succeeds)
                                     → AVAILABLE (hold expires or payment fails — released)
```
Enforced via the two-counter model (Section 6, BR-3) plus the check constraint `quantity_confirmed + quantity_held <= quantity_total`, making a negative-availability state a rejected database write, not merely an application-level bug.

### 9.4 Check-in Lifecycle (append-only log)
```
(no row) → CHECK-IN #1 (is_override = false)
CHECK-IN #1 exists → CHECK-IN #2 (is_override = true, requires explicit staff confirmation)
```
**Forbidden:** a Check-in row being created for a Registration whose current status is not `confirmed` or `checked_in` — enforced at the API layer (FR-21) and ideally as a database trigger/application-transaction guard, not just a UI omission.

---

## 10. Failure & Edge-Case Scenarios (updated — two new rows added, source-of-truth column added)

| Scenario | System Behaviour | Source of Truth | 
|---|---|---|
| Payment succeeds, browser closes before redirect | Webhook confirms independently | Webhook-driven Payment row |
| Webhook arrives before redirect | Redirect handler sees already-confirmed state, no-ops | First-resolved Payment row |
| Duplicate webhook delivery | No-op beyond the first, guarded by `UNIQUE(provider_reference)` | Existing Payment row |
| Attendee double-clicks pay | Two Payment attempts recorded against one Registration (1:N); at most one may confirm | Registration aggregates its Payment attempts |
| Hold expires before payment completes | `quantity_held` decremented automatically; inventory returned | TicketType counters |
| Search: no match | Explicit "no registration found," 200 response with empty result | — |
| Search: multiple matches | Disambiguation list with masked email/phone | — |
| Registration exists, payment not confirmed | "Not valid for entry" state; check-in action absent (FR-21) | Registration.status |
| Last-unit race | Atomic conditional decrement lets exactly one attempt confirm; the other fails against `quantity_confirmed + quantity_held = quantity_total` | Database check constraint |
| **Payment succeeds, ticket confirmation fails mid-transaction** *(new)* | Entire confirmation transaction rolls back; retried using the already-verified Payment row (safe via idempotency); if retries exhaust, flagged `requires_reconciliation` rather than shown as attendee-facing failure | Payment row (already `success`) — Section 8.5 |
| **Redirect-check and webhook disagree** *(new)* | Webhook result governs; provisional confirmation is reconciled/reversed if contradicted | Webhook (Section 8.6) |
| Attendee tries to check in twice | Blocked by default; explicit `override=true` creates a new, separately auditable Check-in row | Check-in log (Section 9.4) |

---

## 11. Validation Rules (revised — numeric thresholds added)

- **Attendee name:** required, 1–120 characters.
- **Email:** required, valid format, used for confirmation delivery and evidence-retrieval two-factor check.
- **Phone:** **required** (v1 open question resolved — provides a usable secondary search/disambiguation identifier).
- **Ticket tier selection:** must reference an existing, published tier with `available > 0` at submission time; re-validated at confirmation time.
- **Search query:** minimum 2 characters; results capped at 20 per request (Section 13 — pagination).
- **Payment amount:** `verified_amount_minor_units` must equal `expected_amount_minor_units`; a mismatch blocks confirmation and flags the Payment row for manual review rather than auto-accepting.
- **Idempotency keys** (registration creation, attendee requests): required, client-generated UUID, unique per submission attempt.

---

## 12. API Requirements (revised — versioned, literal, with auth context)

All paths are versioned under `/api/v1`.

| Endpoint | Method | Auth context | Key request fields | Key response | Notable status/error semantics |
|---|---|---|---|---|---|
| `/api/v1/events` | POST | Organiser | name, description, starts_at, ends_at, venue | Event | 400 on invalid fields |
| `/api/v1/events/{slug}` | GET | Public | — | Event + tiers + programme (public-safe DTO — excludes internal counters, see Section 13) | 404 if not published |
| `/api/v1/events/{id}/ticket-types` | POST | Organiser (owns event) | name, price_minor_units, currency, quantity_total | TicketType | 400 on invalid pricing/quantity |
| `/api/v1/events/{id}/registrations` | POST | Public | attendee_name, email, phone, ticket_type_id, `idempotency_key` | Draft registration + payment redirect URL | 409 if tier unavailable; replaying the same `idempotency_key` returns the original result, not a new row |
| `/api/v1/payments/initiate` | POST | Public (tied to a registration) | registration_id | Redirect URL | Amount always server-computed (FR-11) |
| `/api/v1/payments/verify` | POST/GET | System (redirect callback) | provider_reference | Confirmed/failed/pending | Idempotent — safe to call repeatedly (Section 8.5) |
| `/api/v1/payments/webhook` | POST | Flutterwave (signature-verified) | Provider payload | 200 ack | Signature verification mandatory before any write; idempotent (Section 8) |
| `/api/v1/registrations/evidence` | GET | Attendee (reference + email, Section 3) | unique_reference, email | Ticket evidence | 403 if email doesn't match reference — never 404 (avoids confirming which references exist) |
| `/api/v1/events/{id}/registrations/search` | GET | Staff (event-scoped token) | query (name/email/phone), `page`, `page_size` | Paginated list of matches with status | Empty result set is 200, not 404; hard cap `page_size <= 50` |
| `/api/v1/registrations/{id}/check-in` | POST | Staff (event-scoped token) | override (boolean, default false) | New Check-in row | **409** if `Registration.status != confirmed`/`checked_in`, or if already checked in and `override=false` |
| `/api/v1/registrations/{id}/requests` | POST | Attendee (reference + email) | message, `idempotency_key` | Request record | 400 if registration not found for that reference/email pair |
| `/api/v1/events/{id}/requests` | GET | Organiser | `status` filter, `page`, `page_size` | Paginated list | — |
| `/api/v1/events/{id}/dashboard` | GET | Organiser | — | Aggregate counts (registrations, payment breakdown, tier sales, check-ins) | Decomposed from v1's single undifferentiated "dashboard data" capability |
| `/api/v1/events/{id}/staff-tokens` | POST/GET/DELETE | Organiser | label, expires_at | StaffToken(s) | DELETE = immediate revocation |

**Pagination/filtering contract (new, applies to all list endpoints above):** `page` (default 1), `page_size` (default 20, max 50), consistent envelope `{ data: [...], page, page_size, total }`. Search additionally supports `query`; requests additionally support `status`.

---

## 13. Over-fetching & Real-Time Decisions (new section — was entirely absent in v1)

**Over-fetching case:** `/api/v1/events/{slug}` (public event page) is the clearest candidate. A naive REST response exposing the raw `TicketType` row would leak internal fields (`quantity_confirmed`, `quantity_held`) that the public page has no use for — it only needs name, price, and an available/sold-out label. **Resolution:** define a public-safe `TicketTypeSummaryDTO` (`{ name, price_minor_units, currency, available: boolean }`) rather than serializing the internal row. A GraphQL equivalent would let the client request exactly this shape natively (`{ ticketTypes { name price available } }`), but for v1 — a single public client surface, modest scale — REST with a hand-defined DTO is sufficient and avoids introducing a second query paradigm. GraphQL would be worth reconsidering only if a future partner-integration surface needed a materially different shape over the same event graph.

**Real-time case:** the two candidates are (a) tier availability on the public page during active sales, and (b) check-in counts on the organiser dashboard during the event. Given this product's scale (single-event, moderate concurrency, no client-to-server real-time input needed), the decision is:
- **Public availability:** short-interval polling (every 5–10 seconds) — simplest, sufficient, and avoids persistent-connection overhead for a purely server-to-client, low-frequency-change value.
- **Organiser dashboard check-in counter:** Server-Sent Events (SSE) — one-directional push suits this exactly, and meets the 5-second propagation target in FR-22 without the operational complexity of bidirectional WebSockets, which nothing in this product currently requires (no live multi-staff coordination feature is in scope).

---

## 14. Auditability & Record Integrity

- Every Payment state transition is recorded with a timestamp on the Payment row itself plus retained `raw_provider_payload`.
- Every Check-in (including overrides) is its own row (Section 9.4) — no in-place edits.
- Every Attendee Request and its resolution is retained, never deleted.
- Organiser edits to published event/tier details are logged (what changed, when) — supporting capability (Section 20).
- Events are soft-deleted (`deleted_at`), never hard-deleted, once any Payment exists against them, to preserve the audit trail required above.

---

## 15. Status Codes & Error Response Pattern

Unchanged in principle from v1, with one addition: the ticket-evidence endpoint (Section 12) returns `403` rather than `404` on an email/reference mismatch, specifically to avoid confirming to an attacker which references are valid (closes an enumeration risk identified in the audit).

- **2xx:** success; empty search/list results are still 200.
- **400:** validation failure, field-level detail in response.
- **403:** access-control failure (including the evidence-lookup case above).
- **404:** resource genuinely does not exist (e.g., unpublished/unknown event slug).
- **409:** state conflicts (sold-out tier, non-confirmed check-in attempt, double check-in without override).
- **5xx:** unexpected/provider failures; payment-adjacent endpoints surface `pending`/`requires_reconciliation` rather than guessing success or failure.

---

## 16. Testing Expectations (updated)

- Payment success path, end-to-end, including the atomic confirmation transaction (Section 8.5).
- Payment failure and pending/uncertain simulations.
- Duplicate webhook delivery — confirm exactly one Payment row transitions and no duplicate Registration confirmation occurs, proven via the `UNIQUE(provider_reference)` constraint rejecting the duplicate insert path.
- **New:** simulated mid-transaction failure between payment verification and ticket confirmation — confirm rollback + safe retry, and confirm no attendee is ever shown a false failure for a payment that actually succeeded.
- **New:** simulated redirect/webhook disagreement — confirm the webhook result wins and the registration reconciles correctly.
- Race condition on last remaining tier unit — confirm exactly one of two concurrent attempts confirms, via the check constraint.
- Duplicate registration/request submission — confirm idempotency-key replay returns the original result, not a new row.
- Search accuracy across zero/one/many-match cases.
- Duplicate check-in without override is blocked (409); override produces a second, distinct Check-in row.
- Access control: an attendee cannot retrieve another attendee's evidence (403 on mismatch); staff tokens cannot access other events; organisers cannot access other organisers' events (IDOR check).
- Webhook signature rejection: an unsigned/incorrectly-signed payload is rejected and produces zero state changes.

---

## 17. Acceptance Criteria (updated with numeric thresholds)

- **Registration & Payment:** attendee completes registration and payment for an available tier; on independently verified success, receives a confirmed ticket with a unique reference within the same request/callback cycle (no manual reconciliation needed in the normal path).
- **Payment Integrity:** no registration reaches `confirmed` without a server-verified successful payment; `UNIQUE(provider_reference)` provably prevents duplicate confirmation under repeated webhook delivery.
- **Event-Day Search:** p95 search response time under 500ms for a single event's registration set at expected event scale; zero/one/many-match cases each produce a correct, distinct result.
- **Ticket-Tier Identification:** any confirmed registration surfaced to staff correctly displays its tier.
- **Check-in Integrity:** a confirmed registration can be checked in exactly once without an explicit override flag; overrides are separately logged.
- **Organiser Visibility:** dashboard counts match underlying data with zero discrepancy, and check-in counts propagate within 5 seconds (FR-22, SSE — Section 13).
- **Attendee Trust:** an attendee is never shown a false "confirmed" state pre-verification, and never left in an unexplained indefinite loading state — the "confirming your payment" state is explicit and time-bounded (paired with the 15-minute hold window in BR-3).
- **Access Control:** an attendee cannot retrieve another attendee's evidence; staff tokens are strictly event-scoped; organisers cannot access each other's events — all provable via the test cases in Section 16.

---

## 18. Security & Privacy Considerations (expanded from v1)

- Organiser/staff authentication and per-event authorization is mandatory for all non-public endpoints (Section 3) — this was entirely absent in v1 and is now a must-have, not an implementation detail.
- Ticket-evidence lookup requires reference **and** email (two-factor), and returns 403 rather than 404 on mismatch, to resist enumeration.
- `unique_reference` and `idempotency_key` values must have sufficient entropy (minimum 128 bits) to resist guessing.
- Payment amounts are always server-computed from stored tier price; client-supplied amounts are never trusted (FR-11).
- Webhook payloads must pass signature verification before any state change (`[VERIFY exact mechanism]`).
- Staff tokens are strictly event-scoped and revocable; a revoked token is rejected server-side on its next use, not merely hidden client-side.
- Search results are always scoped server-side to the authenticated staff token's event — never trusted from a client-supplied `event_id` alone.
- Raw payment provider payloads are retained for audit but are never returned in full via any attendee- or staff-facing API response — only derived status fields are exposed to those roles; full payloads are organiser/audit-only.

---

## 19. Deferred / Not Yet Fully Specified

- Exact organiser authentication mechanism (password vs. magic link vs. SSO) — `[VERIFY / decide at implementation time]`, does not affect the authorization model in Section 3.
- Exact staff-token transport (bearer token, short-lived JWT, or session tied to a device) — `[VERIFY / decide at implementation time]`.
- All Flutterwave-specific mechanics — verification endpoint, webhook payload/signature scheme, response-time contract, whether a post-success reversal can be reported via webhook — remain `[VERIFY]` against current official documentation before implementation, per the original PRD's instruction and unchanged by this revision.

---

## 20. Scope Boundaries (updated — authentication moved into Must-Have)

### Must-Have (v1)
- Event creation with ordered programme
- Ticket tier configuration with two-counter availability tracking (confirmed + held)
- Attendee registration + Flutterwave payment, with idempotency-key duplicate-submit protection
- Server-side payment verification (redirect-check + webhook), idempotent via `UNIQUE(provider_reference)`, with an atomic confirmation transaction (Section 8.5)
- **Organiser authentication and event-scoped staff access tokens** *(moved here from an unstated assumption — audit correction)*
- Ticket/registration confirmation and two-factor ticket evidence retrieval
- Event-day attendee search (name + email/phone), scoped per event, with disambiguation for multiple matches
- Check-in as an append-only, override-capable log, gated server-side on confirmed status
- Attendee request/issue submission tied to registration, with duplicate-submit protection
- Organiser operational dashboard (registrations, payments, tiers, check-ins), decomposed into proper paginated resource endpoints
- Auditability of payment state transitions, check-in events, and organiser edits to published events

### Supporting (build if time allows, not launch-blocking)
- Attendee notification on core event-detail changes post-publication
- Logging of organiser edits (the log itself is must-have per Section 14; a notification *on top of* the log is supporting)
- Reference-based fast-lookup at check-in, in addition to name search (Section 5.5, FR-16)

### Future Possibilities (explicitly not v1)
- Multiple tickets per purchase in a single checkout (would require revisiting the Registration:Payment/TicketType relationship again)
- Refund processing workflow (the state exists per BR-7; processing does not)
- Ticket transfer between attendees
- Multi-organiser/team accounts with role-based permissions beyond the single organiser-owner model
- Platform-wide admin layer across organisers
- QR/scanner-based check-in
- SMS notifications alongside email
- Persistent, cross-event Attendee identity/profile (Section 7.1) — deliberately deferred, not modeled in v1

### Explicitly Out-of-Scope
- Cash/offline payment handling
- General event marketplace/discovery across organisers
- Seat-mapping/assigned seating
- Loyalty/rewards/social features

---

## 21. Open Items Requiring Product-Owner Confirmation

1. Exact organiser authentication mechanism (Section 19).
2. Exact staff-token transport mechanism (Section 19).
3. Whether the 15-minute inventory-hold window (BR-3) is the right duration for expected purchase-flow length.
4. Whether the future cross-event Attendee identity model (Section 7.1, Future Possibilities) is likely to be needed soon enough to influence the v1 schema now.
5. All Flutterwave-specific `[VERIFY]` items — must be resolved against current official documentation before implementation begins.

---

*This revision (v2) addresses every blocking and important correction raised in the prior audit. Optional clarifications (numeric thresholds) have been incorporated throughout rather than left as a separate to-do list. Remaining `[VERIFY]` items are provider-specific or implementation-technology choices that are appropriately deferred to the engineering phase, not requirements gaps.*

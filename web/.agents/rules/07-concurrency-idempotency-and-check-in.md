# Rule 07 — Concurrency, Idempotency & Check-in

**Axis: what happens when the same thing happens twice, or twice at once.**
Every guarantee below is required and **testable** (PRD §16, AGENTS.md §10) — a
passing build is not evidence any of them holds.

For each scenario you must be able to explain *why the race cannot produce an
invalid state*, citing the specific constraint or transaction boundary. "The code
checks for it" is not an explanation.

## The general rule

**Check-then-act is a bug.** A `SELECT` followed by a conditional `INSERT`/`UPDATE`
has a race window no application check can close. Where the PRD names a
constraint, the constraint is the mechanism:

- `UNIQUE(Payment.provider_reference)` — duplicate webhook/attempt
- `UNIQUE(Registration.idempotency_key)` — duplicate registration submit
- `UNIQUE(AttendeeRequest.idempotency_key)` — duplicate request submit
- `CHECK(quantity_confirmed + quantity_held <= quantity_total)` — last-unit race
- append-only Check-in log + the `409`-without-override rule — double check-in

Idempotency is a **database constraint plus a transaction**, never an
application-level existence probe (AGENTS.md §5).

## Scenario matrix (PRD §10, §16)

| Scenario | Required outcome | Mechanism |
|---|---|---|
| Duplicate registration submission (double-submit / retry) | Replay returns the **original** result; **no** second row | `UNIQUE(Registration.idempotency_key)` + transaction |
| Duplicate attendee request | Same | `UNIQUE(AttendeeRequest.idempotency_key)` + transaction |
| Duplicate webhook delivery | **No-op** beyond the first; exactly one Payment row transitions; **no** duplicate Registration confirmation, no second counter movement | `UNIQUE(Payment.provider_reference)` |
| Attendee double-clicks pay | **Two** Payment rows against one Registration (1:N) recorded; **at most one** may confirm | cardinality + single-success guard |
| Last remaining tier unit, two concurrent attempts | **Exactly one** succeeds; the other fails against `quantity_confirmed + quantity_held = quantity_total` | `CHECK` constraint + **atomic conditional update** |
| Hold expires before payment completes | `quantity_held` decremented automatically; inventory returned | hold-expiry job/transition inside the payment-resolution transaction |
| Payment confirmation retried | Safe; the same sequence re-runs against the same `provider_reference`; never double-confirms | `provider_reference` uniqueness (PRD §8.5) |
| Webhook arrives before redirect | Redirect handler observes resolved state and **no-ops** | state check inside transaction |
| Redirect/webhook disagree | **Webhook governs**; registration reconciles, including reversing a provisional confirmation | PRD §8.6 (rule 04) |
| Mid-transaction failure between verification and confirmation | **Full rollback**; safe retry; attendee **never** shown a false failure | PRD §8.5 single transaction + reconciliation flag |
| Attendee checks in twice | Blocked by default (`409`); explicit `override=true` creates a **second, distinct** row | append-only log + FR-21 guard |

## Last-unit / tier race — the pattern

The last available unit is the canonical race. It must be resolved by an
**atomic conditional write**, not by reading availability and then writing:

- The counter update must fail (constraint violation / zero-rows-affected
  condition) when `quantity_confirmed + quantity_held` would exceed
  `quantity_total`.
- The caller must translate that failure into the PRD's `409` for an unavailable
  tier (PRD §12) — not a `500`, and not a silent success.
- Both the hold increment and the confirm-side decrement happen **inside** the
  transaction that changes `Registration.status`, so availability and
  registration state cannot diverge (BR-3).
- The same conditional-write discipline applies to `quantity_held` increments
  when an attendee is routed to payment.

## Payment-confirmation retry

- Retries re-run the **same sequence** on the **same** `provider_reference`
  (PRD §8.5).
- A retry must be safe against: the payment already being `success`, the
  registration already being `confirmed`, and a partial prior attempt having
  rolled back. In all three cases the outcome is one correct final state, not a
  double confirmation.
- Retries exhausted → **reconciliation flag**, never an attendee-facing failure
  (money did move). See the stop condition in rule 03 about where that flag
  lives — it is not currently modelled in the PRD §7.2 enums.

## Check-in concurrency & duplicate behaviour

- **Append-only.** Check-in rows are inserted, never updated or deleted
  (PRD §9.4, §14). "Currently checked in" derives from the latest row.
- `Registration.status = checked_in` is a projection written **in the same
  transaction** as the insert (PRD §7.4). A projection written outside that
  transaction is a defect, not an optimisation.
- **Eligibility guard:** a Check-in row may only be created for a registration
  whose status is `confirmed` or `checked_in`; anything else is `409` (FR-21).
  Guarded in the transaction, and ideally as a DB trigger (PRD §9.4).
- **First check-in:** `is_override = false`. **Repeat check-in:** requires an
  explicit `override=true` from the caller, is recorded as a **new row** with
  `is_override = true`, and is separately auditable (BR-4). Without the flag →
  `409`.
- Two concurrent check-ins for the same registration must not produce two
  `is_override = false` rows. The read of "has a non-override check-in already
  exist?" must be part of the guarded write, not a prior read.
- An override is a **deliberate, distinguishable action** — never a silent
  re-click and never an edit to the original row.

## Required test evidence (AGENTS.md §17)

Each of these needs a test that exercises the **actual** race/duplicate
scenario, not a sequential approximation:

- last-unit race → exactly one of two concurrent attempts confirms, proven via
  the check constraint rejecting the other;
- duplicate webhook delivery → exactly one Payment transition, proven via
  `UNIQUE(provider_reference)` rejecting the duplicate insert path;
- duplicate registration/request submit → replay returns the original result, no
  new row;
- duplicate check-in without override → `409`; with override → a second,
  distinct Check-in row;
- mid-transaction failure + safe retry → rollback proven, and no attendee ever
  shown a false failure;
- redirect/webhook disagreement → webhook result wins, registration reconciles.

A test that asserts "the handler returns 409 when called twice in a row" does
not prove concurrency safety. Drive real concurrent requests/connections, or
prove the constraint rejects the invalid write.

## Related

- `02-domain-model-and-data-integrity.md` — the constraints being relied on
- `03-lifecycle-and-state-machines.md` — legal transitions
- `04-payment-and-flutterwave-integrity.md` — the confirmation transaction

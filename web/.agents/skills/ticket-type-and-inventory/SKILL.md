# Skill — Ticket Type & Inventory

## Purpose

Create and manage **TicketTypes** (tiers) and maintain **two-counter
availability** (`quantity_confirmed` / `quantity_held`) so that availability is
always correct, never negative, and race-safe — with the 15-minute hold
lifecycle implemented against the database, not in application logic.

## When to use

- `POST /api/v1/events/{id}/ticket-types` (organiser creates a tier)
- Editing tier name/description/price/quantity
- Closing a single tier independently of the event (FR-7)
- Computing or exposing availability, or changing hold/confirm counters
- Any change touching `quantity_confirmed` or `quantity_held`

## Preconditions

- PRD §7.2 TicketType exists with `UNIQUE(event_id, name)`,
  `CHECK(quantity_confirmed + quantity_held <= quantity_total)`,
  `CHECK(quantity_confirmed >= 0 AND quantity_held >= 0)`, index `event_id`.
- The **atomic conditional update** pattern for counters is established (rule
  07) — a read-then-write is not acceptable here.
- Currency handling confirmed: integer minor units + ISO 4217 `string(3)`
  (rule 02). Never a float.
- The organiser auth mechanism exists and ownership checks are wired (rule 05).

## Source requirements

PRD §5.2 (FR-5, FR-6, FR-7), §6 (BR-3 two-counter + 15-min hold), §7.2
(TicketType), §9.3 (availability lifecycle), §10 (last-unit race, hold expiry),
§11 (tier selection validation), §12 (ticket-types row), §13 (public-safe
`TicketTypeSummaryDTO`), §15 (`409` on unavailable tier). AGENTS.md §5, §10, §13.

## Procedure

1. **Resolve caller + ownership.** Organiser only; verify
   `event.organiser_id == current_user.id` server-side before touching the tier
   (IDOR).
2. **Create a tier.** Validate `name`, `price_minor_units` (integer ≥ 0),
   `currency` (ISO 4217), `quantity_total` (integer > 0), optional `description`.
   Initialise `quantity_confirmed = 0`, `quantity_held = 0`. Enforce
   `UNIQUE(event_id, name)` at the DB level. `400` on invalid pricing/quantity
   (PRD §12).
3. **Compute availability.** `available = quantity_total − quantity_confirmed −
   quantity_held`. This is **derived**, never stored, never client-supplied.
   `available > 0` is the sellability predicate. It must never be negative — the
   `CHECK` constraint makes a negative state a rejected write, not a bug.
4. **Public projection.** On the public event page expose only
   `TicketTypeSummaryDTO` = `{ name, price_minor_units, currency, available }` —
   **never** the internal counters (PRD §13, rule 06). Sold-out is the
   `available: false` flag plus an explicit UI state (AGENTS.md §11.2).
5. **Hold on routing to payment (BR-3).** When an attendee is routed to payment,
   increment `quantity_held` **atomically and conditionally**: the write must
   fail if it would breach `quantity_confirmed + quantity_held <=
   quantity_total`. On failure return `409` (unavailable tier). The hold is
   bounded by the **15-minute window**.
6. **Release the hold.** Decrement `quantity_held` when the hold expires
   (automatically, at 15 minutes) or when the associated payment resolves
   (success **or** failure). This must run inside the same transaction as the
   payment resolution / expiry transition (BR-3, rule 03) so availability and
   registration state cannot diverge.
7. **Confirm on verified success.** Increment `quantity_confirmed` — **only** on a
   payment reaching verified success, and **only** inside the PRD §8.5 atomic
   confirmation transaction together with the `quantity_held` decrement and
   `Registration.status = confirmed` (rule 04).
8. **Close a tier (FR-7).** A tier can be closed **independently of the event**.
   Model closure so a closed tier is not selectable/submittable, but do not
   invent a new counter or silently zero availability — respect the two-counter
   model.
9. **Quantity edits.** Treat `quantity_total` edits under the `CHECK` constraint:
   reducing below `confirmed + held` must be rejected by the DB, not clamped in
   code. Decide and state the error surface (`400`/`409`) consistently.

## Integrity checks

- `quantity_confirmed + quantity_held <= quantity_total` enforced by the **CHECK
  constraint**; availability can never go negative (PRD §9.3).
- `quantity_confirmed >= 0 AND quantity_held >= 0` enforced.
- Counter changes use **atomic conditional updates**, so exactly one of two
  concurrent attempts on the last unit succeeds (rule 07).
- Every counter change is in the **same transaction** as the
  `Registration.status` / `Payment.status` change it corresponds to.
- `quantity_confirmed` increments only on verified success — never on
  initiation, redirect, or an unverified client signal.
- Price/currency stored as integer minor units + ISO code; never float, never
  client-supplied at purchase time.
- Public DTO exposes no internal counters.
- `UNIQUE(event_id, name)` rejects duplicate tier names at the DB level.

## Verification

- Create a tier → appears in the organiser view; not purchasable if
  `available = 0`.
- Public event response shows the summary DTO and **no** counters.
- **Last-unit race:** two concurrent holds on the final unit — exactly one
  succeeds, the other gets `409`; proven by the `CHECK` constraint rejecting the
  losing write (rule 07).
- **Hold expiry:** a hold older than 15 minutes with no resolution has
  `quantity_held` decremented and availability restored.
- **Payment resolves:** success → `confirmed++`, `held--`; failure → `held--`
  only; both atomic with the registration/payment status change.
- Constraint test: an update that would make counters exceed the total is
  **rejected by the database** (not by an application pre-check alone).
- Duplicate tier name → `UNIQUE` violation surfaced as a contract error.

## Stop conditions

- Availability must be exposed as a new field/endpoint not in the PRD §12/§13
  contract → flag, do not add.
- A requirement appears to need per-unit inventory rows or seat assignment →
  out of scope (PRD §9.3, §20); stop.
- The 15-minute hold duration is in question for real usage → PRD §21 open item;
  do not silently change it.
- You are about to relax the `CHECK` constraint or clamp a counter in code to
  make a test pass → stop; fix the test/data.

## Required output

Report: what changed; the PRD requirements satisfied (FR-5/6/7, BR-3, §8.5,
§9.3); files changed; how availability/hold/confirm were verified (including the
race test and the constraint-rejection test); confirmation the public DTO hides
counters; and any `[VERIFY]`/open item (e.g. hold-window confirmation, currency
handling) relied on.

## Implementation status (2026-09-26)

**Implemented** — steps 1–7 and 9, except where noted below. `POST` is PRD §12's own
row; the list, patch, and delete routes are approved additions recorded as R-4 in
rule 03.

| Piece | Where |
| --- | --- |
| Domain types, availability arithmetic, hold window | `src/domain/tickets/ticket-type.ts` |
| Business rules | `src/domain/tickets/ticket-type.service.ts` |
| Persistence port, with atomicity specified per method | `src/domain/tickets/ticket-type.repository.ts` |
| Organiser DTO (allow-list, numeric `available`) | `src/domain/tickets/ticket-type.dto.ts` |
| Prisma adapter, raw conditional counter statements | `src/server/db/ticket-type.repository.ts` |
| Field limits as database CHECKs | migration `20260926000400_ticket_type_limits` |
| Request validation | `src/server/validation/validation.ts` |
| Routes | `src/app/api/v1/events/[identifier]/ticket-types/…` |

**Not implemented, and why** — both are stop conditions above, reported rather than
absorbed:

- **Step 8, FR-7 per-tier closure.** §7.2 gives `TicketType` no `status` column, no
  enum, and no soft-delete stamp, so a closed tier is not representable without
  inventing a column. The event's own `closed` state is what stops sales. Flagged for
  §7.2 to be corrected.
- **Step 6's automatic 15-minute expiry.** The window is a domain constant
  (`HOLD_WINDOW_MINUTES`, with `holdExpiresAt()`), and `releaseInventory` is the
  operation a sweep would call. Deciding *which* hold is stale is a question about a
  specific in-flight `Registration`, and the two-counter model stores no per-hold row
  or timestamp, so the sweep belongs to the registration slice. PRD §21 open item 7
  also lists the 15-minute value as a working default awaiting confirmation.

**Known limitations:**

- `currency` is checked for *shape* (three ASCII letters, upper-cased), not validated
  against the ISO 4217 registry. See rule 02 decision 5.

**Verification as built:**

- `npm run db:verify-constraints` — 97/97, including a reject/accept pair for each of
  the five new CHECKs and the guarded-versus-unguarded counter cases.
- `tests/ticket-types.db.test.ts` — real PostgreSQL, including two concurrent holds on
  the last unit, 25 concurrent holds for 5 units, and a concurrent release/confirm of
  the same hold.
- `tests/ticket-types.service.test.ts`, `tests/ticket-types.validation.test.ts`,
  `tests/api.v1.events.ticket-types.test.ts` — rules, limits, and transport contract.
- One bug this slice's own tests caught, kept here because it will recur: a CHECK
  violation is **not** `P2004` under Prisma 7's driver adapter. It arrives as `P2039`
  with PostgreSQL's `23514` and the constraint name nested in `meta`. The adapter now
  maps by constraint name and reports the offending request field.

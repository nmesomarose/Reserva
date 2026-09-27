# Skill — Registration & Idempotent Purchase

## Purpose

Create a **Registration** from attendee-submitted details exactly once (even on
double-submit, retry, or refresh), place the tier hold, and return the payment
redirect — leaving the registration honestly in `pending_payment` and never
claiming confirmation before server-side verification.

## When to use

- `POST /api/v1/events/{id}/registrations` (public)
- `POST /api/v1/payments/initiate` (public, tied to a registration)
- Any change to registration creation, the idempotency-key replay path, tier
  selection validation, or the pending → confirmed lifecycle entry point

Not for verifying a payment (→ `../flutterwave-payment-verification/SKILL.md`),
search, or check-in.

## Preconditions

- PRD §7.2 Registration exists with `UNIQUE(unique_reference)`,
  `UNIQUE(idempotency_key)`, indexes `(event_id, attendee_name)` and
  `(event_id, status)`.
- `unique_reference` generated with **≥ 128 bits** of entropy
  (cryptographically secure; non-sequential, non-guessable).
- Centralised validation layer in place (AGENTS.md §4, §13).
- TicketType availability counters and the atomic conditional-update pattern are
  available (→ `../ticket-type-and-inventory/SKILL.md`).
- `[VERIFY]` Flutterwave initiation parameters (what the hosted-payment redirect
  URL requires) — see rule 04. Do not invent them.

## Source requirements

PRD §5.3 (FR-8, FR-9, FR-10, FR-10a), §6 (BR-1, BR-3), §7.2 (Registration),
§9.2 (registration lifecycle), §10 (double-click pay, duplicate submit),
§11 (validation: name 1–120, email, phone required, tier availability),
§12 (registrations + initiate rows; `409` if tier unavailable; replay returns
the original result), §15 (`409` on state conflict). AGENTS.md §5, §7, §10, §13.

## Procedure

1. **Validate the request** through the centralised layer: `attendee_name`
   (1–120 chars), `attendee_email` (valid format), `attendee_phone`
   (**required**), `ticket_type_id`, `idempotency_key` (required,
   client-generated UUID).
2. **Resolve the idempotency key first.** Look up `idempotency_key`:
   - existing row → **return the original result** (the same registration +
     redirect/response payload). Do **not** create a second row, and do not
     `409` a legitimate replay (PRD §12).
   - the guarantee is `UNIQUE(idempotency_key)` + transaction, not a
     read-then-write probe (rule 07).
3. **Resolve and validate the tier server-side.** The `ticket_type_id` must
   reference an **existing, published tier with `available > 0`** at submission
   time (PRD §11). Compute `available` from the DB; never trust a client-supplied
   availability or price. Unavailable/closed tier → `409`.
4. **Create the Registration** with `status = pending_payment`, `event_id`,
   `ticket_type_id`, and a freshly generated high-entropy `unique_reference`.
   This is **not** a ticket yet, and must never be presented as one (BR-1).
5. **Place the tier hold (BR-3).** Increment `quantity_held` via the **atomic
   conditional update**; if it would breach the `CHECK` constraint, the tier is
   gone → `409`, and no registration row is left half-created (same
   transaction).
6. **Prepare payment initiation.** The amount is **server-computed** from the
   stored `TicketType.price_minor_units` and persisted on the `Payment` row as
   `expected_amount_minor_units` (FR-11). Never read an amount from the request.
7. **Route to Flutterwave** and return the redirect URL. The `Payment` row starts
   at `initiated` (or `processing`) — never `success`.
8. **`POST /api/v1/payments/initiate`** re-reads the registration, re-computes
   the amount server-side, and prepares/refreshes the redirect. A registration
   already resolved is a `409` state conflict, not a second payment.
9. **Re-validate availability at confirmation time** — availability can change
   between submission and confirmation (PRD §11). This is a second check, not a
   repeat of step 3.
10. **Leave confirmation to the verification path.** The registration becomes
    `confirmed` only through the atomic confirmation transaction
    (→ `../flutterwave-payment-verification/SKILL.md`).

## Integrity checks

- `idempotency_key` is **required**; replay returns the original result, never a
  new row (FR-10a, PRD §12).
- Replay of a key with a materially **different** body is a conflict, not a
  silent return of the old result — handle explicitly.
- `unique_reference`: ≥ 128 bits entropy, `UNIQUE`, non-sequential,
  cryptographically generated.
- `Registration → Payment` is **1:N** — multiple attempts are expected and
  supported; do not make it 1:1.
- The hold increment and the registration insert are **one transaction**.
- The registration is created as `pending_payment` and is **never** created or
  left as `confirmed` by this path.
- The amount is server-computed from the stored tier price; no client amount is
  read at any point.
- `event_id` comes from the route, and the tier is verified to belong to that
  event (no cross-event tier submission).
- Phone is required (not optional) — a resolved v2 decision.

## Verification

- Valid submission → one `pending_payment` registration, one `Payment` row at
  `initiated`, a redirect URL, `quantity_held` incremented by 1.
- **Double-submit with the same `idempotency_key`** → the original response is
  returned; row count unchanged; no second `Payment`, no second hold.
- Sold-out / closed tier → `409`, and **no** registration or hold left behind.
- Amount tampering attempt (client sends a price) → ignored; the amount used is
  the stored `price_minor_units`.
- Concurrent submissions on the last unit → exactly one succeeds (constraint
  rejects the other).
- Registration at this point is **not** confirmed and does not appear to staff
  as a valid ticket (FR-9).
- Two payment attempts against one registration both persist (1:N), neither is
  `success` yet.

## Stop conditions

- A new field/endpoint is needed for registration (e.g. multi-ticket checkout) →
  out of scope (PRD §20); stop and flag.
- Flutterwave initiation parameters are still `[VERIFY]` and you are about to
  guess them → stop; isolate the call and flag.
- Preventing duplicate submission appears to require a server-generated key or a
  new mechanism → the PRD specifies a **client-supplied** key; flag rather than
  redesigning.

## Required output

Report: what changed; the PRD requirements satisfied (FR-8/9/10/10a, BR-1,
BR-3); files changed; how duplicate-submit, sold-out, and the last-unit race
were verified; confirmation the amount is server-computed and the registration
is not pre-confirmed; and any `[VERIFY]`/open item (Flutterwave initiation
parameters) relied on.

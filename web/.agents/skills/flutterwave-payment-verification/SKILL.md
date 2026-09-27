# Skill — Flutterwave Payment Verification & Confirmation

## Purpose

Turn a Flutterwave redirect **and/or** webhook into a truthful, atomic,
idempotent `Payment → success → Registration confirmed` outcome — with the amount
computed server-side, authenticity verified before any write, one transaction for
the whole confirmation, duplicate delivery a database-level no-op, and the
webhook governing when the two channels disagree.

## When to use

- `POST /api/v1/payments/verify` (redirect callback)
- `POST /api/v1/payments/webhook` (Flutterwave, signature-verified)
- Any change to the confirmation transaction, `verified_amount_minor_units`
  handling, `requires_reconciliation`, or provider-adapter code

This is the highest-risk path in the product. Read rule 04 alongside this skill.

## Preconditions

- `[VERIFY]` **completed** against current official Flutterwave documentation,
  and recorded: verification endpoint + response schema; webhook event types +
  payload shape; **signature/authenticity mechanism**; response-time contract;
  whether post-success reversal is reportable via webhook (PRD §8, §19;
  AGENTS.md §21.6). If any of these is still open, **stop** — see Stop
  conditions.
- `Payment` table exists with `UNIQUE(provider_reference)` (BR-2),
  `registration_id` index, and the full PRD §7.2 field set.
- `Registration` and `TicketType` counters exist with the PRD §7.2 CHECK
  constraints.
- Provider secrets available **server-side only** via environment configuration
  (rule 08).
- A reconciliation mechanism decision has been made (see Stop conditions — the
  PRD requires the state but does not model it in the `Payment.status` enum).
  → **Satisfied 2026-09-26:** the flag is the `Payment.requires_reconciliation`
  column, `NOT NULL DEFAULT false` (rule 03 R-1).

## Source requirements

PRD §5.4 (FR-11, FR-12, FR-13, FR-13a), §6 (BR-1, BR-2), §8 (all, incl. 8.5
atomic transaction and 8.6 webhook authority), §9.1 (payment lifecycle + forbidden
transitions), §10 (webhook-before-redirect, duplicate delivery, disagreement,
mid-transaction failure), §11 (amount equality rule), §12 (verify/webhook rows),
§15 (`pending`/reconciliation rather than guessing). AGENTS.md §5, §6, §9, §10,
§14.

## Procedure

1. **Identify the entry channel.** Redirect-verify and webhook are separate
   entry points into the same idempotent resolution logic. Neither is trusted on
   its own; the webhook is the eventual source of truth (FR-13a, §8.6).
2. **Webhook only — authenticate first.** Verify the payload's authenticity
   **before** treating any field as trusted input and **before any write**
   (PRD §8, §16). An unsigned/incorrectly-signed payload → reject, **zero** state
   changes, no acknowledgement of success.
3. **Locate the Payment row by `provider_reference`.**
   - No row → unknown reference; do not invent one. Acknowledge/handle per the
     verified provider contract, and log for audit.
   - Row already resolved (`success`/`failed`) → **no-op** (idempotent). Return
     `200`/ack without re-applying anything (PRD §10).
   - Inserting a **new** `Payment` for an existing `provider_reference` must be
     stopped by `UNIQUE` — that rejection *is* the duplicate-delivery path
     (BR-2), not an error to suppress.
4. **Redirect only — verify server-side first.** Call Flutterwave's server-side
   transaction verification with the reference. Treat the outcome as
   **provisional**; it never confirms on its own (FR-12, §8). If the payment is
   already resolved (e.g. the webhook arrived first), **no-op** (§10).
5. **Map the verified result to a payment status** per §9.1:
   `initiated → processing → success` (only when verified) / `failed`
   (terminal) / `pending → (success | failed)`. Record `verified_at` and
   `verified_amount_minor_units`; retain `raw_provider_payload` for audit (§14).
   - `INITIATED → CONFIRMED` directly is forbidden — verification must occur.
   - `FAILED → SUCCESS` on the same row is forbidden; a new `Payment` row is
     created instead (1:N).
6. **Enforce amount equality.** `verified_amount_minor_units` must equal
   `expected_amount_minor_units`. On mismatch: **block confirmation** and flag
   the Payment for manual review — never auto-accept, never silently correct
   (PRD §11).
7. **On verified success — one atomic transaction (PRD §8.5):**
   1. mark `Payment` `success` (+ `verified_at`, `verified_amount_minor_units`);
   2. assert amount equality;
   3. increment `TicketType.quantity_confirmed`;
   4. decrement `TicketType.quantity_held`;
   5. set `Registration.status = confirmed`.

   All five, or none.
8. **Rollback & retry semantics.** Any step failing rolls back the whole
   transaction; the Payment row stays at its pre-transaction status. A retry
   re-runs the same sequence against the same `provider_reference` and is safe by
   virtue of that uniqueness. Retries exhausted → **reconciliation flag**
   (`Payment.requires_reconciliation = true`), never an attendee-facing failure
   (the money did move).
9. **Disagreement (redirect vs webhook, §8.6).** If a webhook later contradicts a
   provisional redirect result, the **webhook governs**. Reconcile the
   registration, including **reversing** a provisional confirmation (reverse the
   `quantity_confirmed` increment, restore availability, move the registration
   out of `confirmed`) if the webhook reports failure/chargeback.
   **Exception:** if the registration is already `CANCELLED` from a hold expiry,
   the webhook still sets the `Payment` row to `success` and sets
   `requires_reconciliation = true`, but the registration **stays `CANCELLED`** —
   no re-confirm, no counter changes (rule 03 R-2). Never relax
   `CANCELLED → CONFIRMED`.
10. **Respond.** Webhook → `200` ack only after authenticity + idempotent
    handling. Redirect verify → the confirmed/failed/pending state, safe to call
    repeatedly. Never guess success or failure on an unexpected path (PRD §15).

## Integrity checks

- Amount is **always** server-computed from `TicketType.price_minor_units` at
  initiation; no client amount is read (FR-11).
- Webhook authenticity verified **before any write**; rejected payloads cause
  **zero** state changes.
- Redirect state is **never** authoritative; confirmation only after server-side
  verification (FR-12, BR-1).
- `UNIQUE(provider_reference)` makes duplicate delivery a **DB-level no-op**;
  no `SELECT`-then-`INSERT` idempotency.
- The five confirmation steps are **one transaction**; no partial "money moved,
  no ticket" state (PRD §8.5).
- Forbidden transitions (`INITIATED → CONFIRMED`, `FAILED → SUCCESS` on the same
  row) are unreachable through the write path.
- The webhook overrides a contradicting redirect result and triggers
  reconciliation/reversal (§8.6) — **except** that a `CANCELLED` registration is
  never re-confirmed (rule 03 R-2).
- Amount mismatch **blocks** confirmation and flags for review; it is never
  auto-accepted.
- `requires_reconciliation` is a `Payment` column, never a `status` value, and a
  `success` payment with the flag set is surfaced as reconciliation — never as a
  failure (rule 03 R-1, §15).
- Provider secrets and `raw_provider_payload` never reach a client or a log line
  (rule 08).

## Verification

- **Success path end-to-end**, including that the confirmation is atomic.
- **Failure and pending** simulations → correct terminal/pending states, honest
  attendee-facing outcome.
- **Duplicate webhook delivery** → exactly one Payment transition, no duplicate
  registration confirmation, no double counter movement — proven via
  `UNIQUE(provider_reference)` rejecting the duplicate insert path.
- **Mid-transaction failure** between verification and confirmation → full
  rollback, safe retry, and **no attendee ever shown a false failure** for a
  payment that actually succeeded.
- **Redirect/webhook disagreement** → the webhook result wins; the registration
  reconciles (including reversal of a provisional confirmation).
- **Amount mismatch** → confirmation blocked, Payment flagged, nothing
  auto-accepted.
- **Unsigned/incorrectly-signed webhook** → rejected, zero state changes.
- **Webhook-before-redirect** → redirect handler no-ops.
- Repeated `/payments/verify` calls are safe (idempotent).

## Stop conditions

- **Any `[VERIFY]` item in the Preconditions is still open** → do not write the
  provider integration. Isolate the call and ask; never invent an endpoint,
  payload shape, or signature scheme.
- The reconciliation state has no agreed home. PRD §8.5/§15 require a queryable
  `requires_reconciliation` state, but `Payment.status` is enumerated
  `initiated|processing|success|failed|pending` with `success` terminal — a new
  column vs. enum value vs. separate record is a **product decision**. Stop.
  → **Resolved 2026-09-26:** a `Payment.requires_reconciliation` column (rule 03
  R-1). No longer a stop condition; do not reopen without a PRD change.
- Flutterwave would need to report a post-success reversal and cannot → flag; do
  not fake the reversal path.
- Verification is about to be skipped or degraded "just for local dev" → never
  (AGENTS.md §1, §6).

## Required output

Report: what changed; the PRD requirements satisfied (FR-11/12/13/13a, BR-1/2,
§8.5, §8.6, §9.1, §11); files changed; **which `[VERIFY]` items were resolved
and against what source/date**; how duplicate delivery, mid-transaction failure,
and redirect/webhook disagreement were tested; where the reconciliation flag
lives; and confirmation that no amount was client-supplied and no secret/payload
is exposed.

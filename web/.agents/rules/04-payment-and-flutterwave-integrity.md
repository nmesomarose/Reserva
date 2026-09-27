# Rule 04 — Payment & Flutterwave Integrity

**Axis: the payment path specifically** — amount authority, provider
verification, and the atomicity of confirmation. Rule 03 owns the state machine;
rule 07 owns duplicate/concurrent delivery.

**Flutterwave is the fixed provider** (PRD §8). Not up for reconsideration
without an explicit product decision, and no alternative provider may be
introduced.

## `[VERIFY]` first — do not invent provider mechanics

Every Flutterwave-specific mechanic is unconfirmed (PRD §8, §19; AGENTS.md §6,
§21.6). Before writing any integration code, verify against **current official
Flutterwave documentation**:

- `[VERIFY]` the exact server-side transaction-verification endpoint, its request
  shape, and its response schema (called on redirect, PRD §8).
- `[VERIFY]` webhook event types, payload shape, and delivery guarantees (may
  arrive before, after, or instead of the redirect).
- `[VERIFY]` the webhook authenticity/signature mechanism (PRD §8).
- `[VERIFY]` the response-time/latency contract.
- `[VERIFY]` whether a post-success reversal/chargeback can be reported via
  webhook (PRD §8.6).
- `[VERIFY]` client-side vs server-side initiation parameters needed to build the
  redirect URL.

Rules for `[VERIFY]` items:

- Never invent a plausible endpoint, header, field name, or signature algorithm
  and build on it. Absent the real schema, isolate the provider call behind a
  small adapter and keep the rest of the domain provider-agnostic in shape (not
  in provider choice).
- **A `[VERIFY]` gap never authorises skipping a requirement.** Signature
  verification stays mandatory before any write even before the exact scheme is
  known; a `[VERIFY]`d reversal path still needs the reconciliation behaviour
  defined.
- When resolved, record what was confirmed, the source, and the date. If the
  PRD's assumption is wrong, flag it — do not quietly code around it (rule 01).

## The amount is server-computed, always

- Compute the amount **server-side from the stored `TicketType.price_minor_units`**
  at the moment of initiation, and persist it as
  `Payment.expected_amount_minor_units` (FR-11).
- **Never accept a client-supplied amount, price, total, or quantity on any
  request field, ever** — not on registration creation, not on initiate, not as a
  "display" value that gets used. A client amount is not merely untrusted; it
  must not be present in the contract at all.
- The price snapshot lives on the `Payment` row, not read live from the tier at
  confirmation time (an organiser price edit must not retroactively change what
  an in-flight attempt owed).

## The redirect is never authoritative

- The platform **never** treats a client-side/browser redirect as proof of
  payment success (PRD §8, FR-12).
- On redirect, the server calls Flutterwave's transaction verification using the
  transaction reference **before any confirmation write**.
- A redirect-triggered verification result is **provisional**. The attendee's
  browser, its query parameters, its timing, and its absence are all
  non-authoritative. `?status=success` in a URL is not a signal.
- The redirect handler must be safe to call repeatedly and safe to arrive after
  the webhook already resolved the payment: it observes state and no-ops if the
  payment is already resolved (PRD §10).

## Webhook authenticity precedes any state change

- Verify the webhook's authenticity **before parsing it into trusted input and
  before any write**. An unsigned or incorrectly-signed payload is rejected and
  produces **zero** state changes (PRD §16).
- Rejection returns an error/non-ack; it never partially applies a payload.
- Do not log the raw payload at a level that could leak secrets — see rule 08.

## `provider_reference` uniqueness is the idempotency mechanism

- `UNIQUE(Payment.provider_reference)` (BR-2) is what makes duplicate webhook
  delivery a database-level no-op rather than an application convention.
- A duplicate insert **fails on the constraint**; that failure is the expected
  path for a redelivery, not an exception to work around by relaxing the
  constraint.
- Never implement webhook idempotency as `SELECT`-then-`INSERT` — that is the
  race window BR-2 was written to close.
- Duplicate delivery must never produce a second `Registration` confirmation, a
  second `quantity_confirmed` increment, or a second `quantity_held` decrement
  (PRD §16).

## The atomic confirmation transaction (PRD §8.5)

These steps happen in **one** database transaction, in this order:

1. Mark the `Payment` row `success` (and set `verified_at`,
   `verified_amount_minor_units`).
2. Verify `verified_amount_minor_units == expected_amount_minor_units`.
   **A mismatch blocks confirmation and flags the Payment for manual review —
   never auto-accept it** (PRD §11).
3. Increment `TicketType.quantity_confirmed`.
4. Decrement `TicketType.quantity_held` for the associated hold.
5. Set `Registration.status = confirmed`.

Failure semantics:

- Any step failing rolls back the **whole** transaction. The Payment row remains
  at its pre-transaction status.
- Retry is safe precisely because of `UNIQUE(provider_reference)` — a retry runs
  the same sequence against the same provider reference; it can never
  double-confirm.
- If retries are exhausted, the payment is **flagged for reconciliation**, not
  shown to the attendee as a failure. The money did move; the attendee must not
  be told it failed (PRD §8.5, §17). The flag is
  `Payment.requires_reconciliation` — a column, never a `status` value (rule 03
  R-1).
- Never leave a state where money was captured and no ticket exists, and never
  leave a state where a retry double-confirms.

## The webhook is the eventual source of truth (PRD §8.6)

- If a redirect-triggered verification and a later webhook **disagree** for the
  same `provider_reference`, **the webhook governs** and the registration is
  reconciled to match.
- Reconciliation includes **reversing a provisional confirmation** if the webhook
  reports failure or a chargeback — reversing the `quantity_confirmed` increment,
  restoring availability, and moving the registration out of `confirmed`.
  Reversal is a transition within the same lifecycle rules (rule 03), not a
  free-form patch.
- Webhook-before-redirect is normal, not an error: the redirect handler observes
  the already-resolved payment and no-ops (PRD §10).
- **Exception — the registration is already `CANCELLED`.** Webhook authority
  governs the *payment*, not the registration lifecycle. A verified success
  arriving after a hold-expiry cancellation sets `Payment.status = success` and
  `Payment.requires_reconciliation = true`, and leaves `Registration.status` at
  `CANCELLED`. Do **not** re-confirm, and do **not** touch
  `quantity_confirmed`/`quantity_held` — the hold already released those units.
  This is rule 03 R-2; it is the one case where the registration is *not*
  reconciled to match the webhook.
- Whether Flutterwave can report a post-success reversal at all is `[VERIFY]`.
  Build the reconciliation path so it is driven by what the webhook actually
  reports; do not assume a reversal event exists.

## Attendee-visible honesty

- A `pending` payment must never be presented as confirmed, and a failure must
  never be invented for a payment that actually succeeded (PRD §4.2, §17).
- Payment-adjacent endpoints surface `pending` / reconciliation states rather
  than guessing success or failure (PRD §15).
- The "confirming your payment" state is explicit and time-bounded by the
  15-minute hold window (PRD §17).

## Related

- `03-lifecycle-and-state-machines.md` — payment + registration transitions
- `06-api-contract-and-validation.md` — initiate/verify/webhook contracts, DTOs
- `07-concurrency-idempotency-and-check-in.md` — duplicate delivery, retries
- `08-security-privacy-and-evidence.md` — raw provider payload handling

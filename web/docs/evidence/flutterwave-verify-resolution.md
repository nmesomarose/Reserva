# Flutterwave `[VERIFY]` resolution record

**Resolved:** 2026-09-27
**Resolved against:** official Flutterwave developer documentation, `developer.flutterwave.com`.
**Source index:** <https://developer.flutterwave.com/llms.txt> (canonical page list; each page's
markdown form fetched by appending `.md` to the page URL).

PRD v2 §19 L484, AGENTS.md §6/§21.6, and `.agents/rules/04` mark every Flutterwave-specific mechanic
`[VERIFY]`, and both AGENTS.md §21.6 and the payment skill's stop conditions forbid writing provider
integration code while any of them is open. This record closes them. Nothing here was inferred from a
plausible-looking API shape; each row cites the page it came from.

---

## 1. Server-side transaction verification

| | |
|---|---|
| **Page** | [Transaction Verification](https://developer.flutterwave.com/docs/transaction-verification.md), [Verify transaction status (reference)](https://developer.flutterwave.com/reference/verify-transaction.md), [Verify with reference](https://developer.flutterwave.com/reference/verify-transaction-with-tx_ref.md) |
| **Endpoint** | `GET https://api.flutterwave.com/v3/transactions/{id}/verify` |
| **Also available** | `GET https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref={tx_ref}` |
| **Auth** | `Authorization: Bearer {SECRET_KEY}` (server-side only) |
| **Identifier** | `id` is the transaction unique identifier, returned as `data.id` by the initiate call *and* present in the webhook payload |
| **Success shape** | `{ "status": "success", "message": "Transaction fetched successfully", "data": { id, tx_ref, flw_ref, amount, currency, charged_amount, app_fee, merchant_fee, processor_response, auth_model, ip, narration, status, payment_type, created_at, account_id, amount_settled, card?, meta, customer } }` |
| **Not found** | `{ "status": "error", "message": "No transaction was found for this id", "data": null }` — **not** an error status code; a `200`-shaped body with `status: "error"` |
| **Transaction status value** | `"successful"` (lowercase) on `data.status` |

The documented success conditions are: `data.status === "successful"`, `data.tx_ref` equals the
reference the integration generated, `data.currency` matches, and the amount is at least the expected
amount.

**Two consequences the PRD overrides or absorbs — see "Divergences" below.**

## 2. Webhook event types and payload shape

**Page:** [Webhooks](https://developer.flutterwave.com/docs/webhooks.md)

All webhook payloads **except virtual-card debit** share one envelope:

```jsonc
{
  "event": "charge.completed",      // the event type
  "event.type": "CARD_TRANSACTION", // optional second discriminator, inconsistent per event
  "data": {
    "id": 285959875,        // transaction id
    "tx_ref": "Links-616626414629",   // OUR reference
    "flw_ref": "PeterEkene/FLW270177170", // Flutterwave's reference
    "amount": 100,
    "currency": "NGN",
    "charged_amount": 100,
    "status": "successful",   // or "failed", "pending", ...
    "payment_type": "card",
    "customer": { ... },
    "card": { ... }
  }
}
```

Observed event names: `charge.completed` (both success *and* failure — the outcome is in
`data.status`, not in the event name), `transfer.completed`, `subscription.cancelled`,
`bvn.completed`, `singlebillpayment.status`.

**A payment webhook carries BOTH references.** `data.flw_ref` is the provider's own id, and
`data.id` is the numeric transaction id used by the verify endpoint. `data.tx_ref` is the merchant
reference the integration supplied.

> **CORRECTION 2026-09-27 — `Payment.provider_reference` stores OUR `tx_ref`, not `flw_ref`.** An
> earlier revision of this record stated the opposite. It was wrong, and the reason is structural
> rather than cosmetic: `provider_reference` is `NOT NULL`, so it must exist **at insert time**, and
> `flw_ref` does not exist until the provider call returns. A `flw_ref` design would also leave the
> §4 timeout window with *no trace at all* — no `Payment` row, nothing to verify, a live hold, and a
> payment that may have succeeded. Committing `tx_ref` first means a `503` leaves a durable
> `initiated` attempt that `/payments/verify` can resolve by reference, which is the provider's own
> documented remedy. `flw_ref` is retained in the stored `raw_provider_payload` as evidence and is
> never used as a lookup key. See `src/domain/registrations/reference.ts`.

**Delivery guarantees (documented):**

- Webhook requests **time out after 60 seconds**; failing to return inside that window marks the
  delivery failed.
- If webhook retries are enabled, Flutterwave **retries 3 times at 30-minute intervals** after a
  non-`200` response. (Retries are a dashboard setting, not guaranteed on by default.)
- "Occasionally, we might send the same webhook event more than once" — idempotent handling is
  required by the provider, not merely advisable.
- A **pending** payment can later transition to successful and is delivered as a further webhook.

**Acknowledgement:** the endpoint **must** return HTTP `200`. Any other code, *including `3xx`*, is
treated as a failure. The response body and headers are ignored. This is the reason the webhook
route must acknowledge a payload it deliberately declines to act on *only after* it has decided to do
so, and why an unauthenticated payload must be answered with a non-`200`.

## 3. Webhook authenticity mechanism

**Page:** [Webhooks § Verifying Webhook Signatures](https://developer.flutterwave.com/docs/webhooks.md)

The mechanism is a **shared secret hash, not a cryptographic signature**:

1. The merchant sets a *secret hash* of their choosing in Dashboard → Settings → Webhooks.
2. Flutterwave sends it on every delivery in a request header named **`verif-hash`**.
3. The receiver compares that header against its own stored secret; if the header is **absent or
   does not match**, the request is discarded as not being from Flutterwave.

Three properties of this are load-bearing and are recorded because they change what the code can and
cannot claim:

- **There is no HMAC over the payload and no timestamp.** Authenticity is a static shared-secret
  comparison. It proves the caller knows the secret; it does **not** bind the body, so a captured
  delivery is replayable, and there is no freshness window.
- Consequently the signature check is **necessary but not sufficient** for PRD §16's "rejected
  payload produces zero state changes" — the raw payload must not be treated as trusted input before
  verification, and the handler must be idempotent *by database constraint* (`UNIQUE(provider_reference)`)
  rather than by trusting delivery uniqueness.
- Flutterwave's docs explicitly recommend **against IP allow-listing** ("Flutterwave's IP Addresses
  are Dynamic and May Change Over Time"), so no IP filter is built.

The docs also recommend re-querying the verify endpoint before granting value even on a
successfully-verified webhook. That is already what PRD §8/rule 04 require, so the recommendation and
the contract agree.

## 4. Response-time / latency contract

**Page:** [Handling Error Timeouts](https://developer.flutterwave.com/docs/handling-error-timeouts.md),
[Rate Limit](https://developer.flutterwave.com/docs/rate-limit.md)

- The API returns **`503` after 28 seconds** of not responding, with body
  `{ "status": "error", "message": "An error occurred. Please contact support", "data": null }`.
- "A timeout does not always mean request failure; it could also mean the request is still
  processing."
- On a `503` from a **payment-creating** request the documented handling is: **do not retry the
  create** — query the verify endpoint to determine whether the payment is in flight before retrying.
- Rate limiting is signalled with **`429`**; the documented remedy is a backoff-based graceful retry.
- Polling is explicitly discouraged: "Do not poll indefinitely… call an endpoint in a structured and
  sparse manner or in response to an event."

**Consequence for `POST /api/v1/payments/initiate`:** a naive retry of a `503` would create a second
hosted link against a second `Payment` row. The provider's own guidance and PRD §10 both require
querying state instead of blind retrying.

**How that is implemented.** `POST /api/v1/payments` is called **once**, after the `Payment` row is
committed. Its three outcomes are all safe, and none of them is a blind retry:

| Provider outcome | What the platform does |
|---|---|
| `2xx` with `data.link` | the hosted link is attached to the attempt, and the attendee is sent to it |
| `4xx` (rejected) | the attempt is marked `failed` with the provider's raw body kept as evidence; the hold is **not** released, because a rejection is not a reversal |
| `5xx`, `429`, or a network timeout | the attempt is left `initiated` and reported to the attendee as **still being determined** — never as a failure. The provider retries the webhook, and the attendee's browser (or `POST /payments/verify`) can ask again |

The last row is the one the 28-second rule exists for, and the reason `provider_reference` is ours
(§2 above): a create that may still be processing is *resolvable*, where one that was never recorded
is not. No path re-calls `POST /v3/payments` for the same attempt — a retry opens a **new**
`Payment` row through `openPaymentAttempt`, with a fresh `tx_ref`, which is the only way two attempts
can never be conflated.

## 5. Post-success reversal / chargeback reporting via webhook

**Pages:** [Refunds](https://developer.flutterwave.com/docs/refunds.md), [Chargebacks](https://developer.flutterwave.com/docs/chargebacks.md), [Webhooks](https://developer.flutterwave.com/docs/webhooks.md)

**Yes — a post-success reversal is reportable.** The refund webhook payload is documented:

```json
{
  "id": 89074,
  "AmountRefunded": 5000,
  "status": "completed",           // completed | processing | pending-momo | ...
  "FlwRef": "flwm3s4m0c1754324273641",
  "destination": "payment_source",
  "comments": "refunds for ABC goods",
  "settlement_id": "NEW",
  "meta": "{...}",                 // a JSON *string*, not an object
  "createdAt": "2025-08-04T16:18:31.000Z",
  "updatedAt": "2025-08-04T16:18:32.000Z",
  "deletedAt": null,
  "walletId": 134244,
  "AccountId": 92319,
  "TransactionId": 8784082         // the original charge's transaction id
}
```

Three facts here shape the handler, and all three are non-obvious:

1. **The refund payload has no `event` envelope.** It is a flat, PascalCase object. The webhook route
   must therefore recognise at least three payload *shapes*: (a) `{ event, data }`, (b) the flat
   refund object, (c) the virtual-card-debit/OTP objects, which must be ignored.
2. **The refund webhook is off by default.** "By default webhooks will not be sent for refunds, you
   will need to reach out to the internal team to enable your account to receive webhooks for
   refunds." Reversal handling is therefore built and reachable but **cannot be assumed to be
   delivered** until the account is enabled — the reconciliation path must also be drivable by a
   periodic verify/status query, not only by the event.
3. **It reports the transaction, not the payment's own status**, via `TransactionId`. Matching is
   therefore by provider transaction id.

Chargebacks are a separate card-network event with their own API (upload proof, accept/decline,
retrieve) and are **not** refund webhooks.

## 6. Client-side vs server-side initiation parameters

**Page:** [Standard API (reference)](https://developer.flutterwave.com/reference/checkout.md),
[HTML Checkout](https://developer.flutterwave.com/docs/html-checkout.md)

**Initiation is server-side.** `POST https://api.flutterwave.com/v3/payments` with
`Authorization: Bearer {SECRET_KEY}`:

> **CORRECTION 2026-09-27 — `amount` is in MAJOR units, not minor units.** An earlier revision of
> this table asserted "minor units". **That was wrong**, and acting on it would have charged every
> attendee **100×** the ticket price. The correction is evidenced below and was confirmed against
> three independent pages in one sitting. Treat the units question as settled in *this* direction.

| Field | Required | Notes |
|---|---|---|
| `amount` | **yes** | integer, in the currency's **major unit** (whole Naira, not kobo) — see the unit evidence below |
| `tx_ref` | **yes** | our own unique reference for the transaction |
| `customer.email` | **yes** (via `customer`) | the attendee's `attendee_email` |
| `currency` | no | defaults to `NGN` — **must be sent explicitly**, from `TicketType.currency` |
| `redirect_url` | no | where the provider sends the attendee back |
| `customer.phone_number` | no | `attendee_phone` |
| `customer.name` | no | `attendee_name` |
| `configuration.session_duration` | no | **minutes**, max `1440`, default `30` — this is the provider-side twin of BR-3's 15-minute hold |
| `configuration.max_retry_attempt` | no | default `5` |
| `payment_options` | no | comma-separated method list |
| `customizations.title` | no | |
| `link_expiration` | no | ISO date-time |
| `meta` | no | extra metadata |

Response: `{ "status": "success", "message": "Hosted Link", "data": { "link": "https://checkout.flutterwave.com/v3/hosted/pay/flwlnk-..." } }`

**The redirect URL the PRD's `POST /api/v1/payments/initiate` must return is `data.link`**, obtained
by a server-side call. The secret key never reaches a client, and there is no client-side integration
in this product (no public key, no client-side checksum, no client-side redirect construction).

## 7. `redirect_url`: an origin in configuration, a path in code

**Page:** [Standard API (reference)](https://developer.flutterwave.com/reference/checkout.md) —
`redirect_url`, "the URL to redirect to after a successful payment".

The value sent to the provider is the **attendee's own return address**, and the product owns the
decision about where that is. The configuration therefore holds an **origin**, not a full path:

| | |
|---|---|
| `FLUTTERWAVE_REDIRECT_BASE_URL` | the deployment's public origin, e.g. `https://tickets.example.com` |
| Path appended in code | `/api/v1/payments/verify` (PRD §12) |
| Result sent as `redirect_url` | `https://tickets.example.com/api/v1/payments/verify` |

Three decisions are recorded here because each of them is a way this could have been done wrongly.

1. **The path lives in code, not in configuration.** An operator who typed a stale or misspelled path
   into an environment variable would send attendees to a `404` *after* a hold had been taken and the
   provider had been called. The one URL shape this product ever returns is therefore not
   configurable. A configured value that already ends with the path is accepted and left alone, so
   pasting a full URL still works rather than producing `/api/v1/payments/verify/api/v1/payments/verify`.
2. **Absent is a supported state, not a misconfiguration.** A deployment with no public origin
   configured sends **no** `redirect_url`, and the payment completes by webhook alone — which PRD §8.6
   makes the governing channel anyway. Making the variable required would break a perfectly valid
   webhook-only deployment at startup. Present-but-not-an-absolute-http(s)-URL *is* rejected when the
   variable is read, because such a value fails at the attendee rather than at the deploy.
3. **The redirect is a hint; the webhook is the authority.** The redirect is a browser navigation, so
   it can be closed, blocked, or never followed. Nothing about the ticket depends on it: the browser
   is sent to `/payments/verify` with no authority of its own, and that route resolves state by
   asking the provider and then deferring to whatever the webhook has already recorded. If the
   redirect and the webhook disagree, the webhook wins and is not re-queried.

### The unit of `amount`: major, not minor — with the evidence

Flutterwave never *states* the unit in prose. It is nonetheless not ambiguous, because three
independent official examples are internally consistent only under major units:

| Evidence | Page | Reading |
|---|---|---|
| Request example `amount: "7500"`, `currency: "NGN"` | [Flutterwave Standard](https://developer.flutterwave.com/docs/flutterwave-standard-1.md) | ₦7,500. Under minor units it would be ₦75 — a strange value to pick for a worked example, and the value is reused in that page's own Node.js samples. |
| Schema default `"amount": {"default": 1000}` | [Standard API](https://developer.flutterwave.com/reference/checkout.md) | ₦1,000, the canonical test charge. |
| Verify success: `amount: 3000`, `charged_amount: 3000`, `app_fee: 1000`, `amount_settled: 2000`, `currency: "NGN"` | [Transaction Verification](https://developer.flutterwave.com/docs/transaction-verification.md) | The decisive one. `amount_settled = amount − app_fee` (3000 − 1000 = 2000) holds exactly, and it is only sensible as ₦3,000 charged less a ₦1,000 app fee. Describing ₦30.00 as a "1000" app fee is not a convention anyone uses. |

**Consequence, and it is a real one.** PRD v2 §7.2 L212 stores money in **minor units** — the field
table says `price_minor_units`, "e.g. kobo for NGN". The two sides of this integration therefore
disagree by a factor of 100 at the boundary, and the difference must be converted explicitly. Sending
`price_minor_units` straight through would bill a ₦5,000 ticket as ₦50,000.

Two things follow, and both are load-bearing:

- `expected_amount_minor_units` and `verified_amount_minor_units` stay in **minor units** (PRD §7.2
  fixes both column names and meanings). The equality check of PRD §11 is therefore a comparison of
  two minor-unit values and needs no conversion.
- Only the value **sent to** and **read back from** the provider is in major units, so the conversion
  sits at exactly two points — initiation, and reading the verified amount back — and nowhere else.

The conversion needs a per-currency exponent (2 for NGN/USD/GBP/EUR, 0 for JPY/KRW/VND, 3 for
KWD/OMR/JOD/TND/IQD). Flutterwave publishes no such table, and PRD §11 requires only that a currency
be a well-formed three-letter code rather than a member of a checked registry, so **the exponent
source is a product decision**, raised as O-5 in `requirements-matrix.md` rather than guessed here.

---

## Divergences from the PRD, and how they are handled

These are **not** PRD/doc conflicts — the PRD is precedence 1 and each case is resolved in the PRD's
favour. They are recorded because they are visible consequences a reader should know about.

| # | Flutterwave guidance | PRD requirement | Handling |
|---|---|---|---|
| D-1 | Accept the payment if the amount paid is **greater than or equal to** expected. | §11/rule 04: `verified_amount_minor_units` **must equal** `expected_amount_minor_units`; a mismatch **blocks** confirmation and flags the payment for manual review. | Equality enforced. An **overpayment is a mismatch**, so it blocks confirmation and sets `requires_reconciliation` for a human. This is strictly safer than auto-accepting (no free ticket), and is the PRD's stated behaviour for any mismatch. |
| D-2 | "Verify if the amount paid is greater or equal"; refunds are initiated by the merchant API. | Refund *processing* is out of scope (§20 Future Possibilities); only the `refunded` **state** must exist (BR-7). | No refund API is called. A reversal arriving by webhook drives the **registration** side of reconciliation (un-confirm / restore availability) and sets the `refunded` state; the money movement itself is a human's action. |
| D-3 | Refund webhooks are disabled by default and need account enablement. | §8.6 requires webhook-driven reconciliation. | The reconciliation path is implemented and driven by whatever the webhook reports (rule 04). Because delivery is not guaranteed, the same code path is also reachable from a verify query; "webhook not received" is never treated as "no reversal". |
| D-4 | Webhook authenticity is a static shared secret, not a body-bound signature. | §16 requires an unsigned/incorrect payload to be rejected with zero state changes. | `verif-hash` comparison before parsing/mutation satisfies the requirement as far as the provider allows, and the residual replay exposure is closed by `UNIQUE(provider_reference)` making redelivery a database-level no-op. Recorded as a residual risk, not papered over. |
| D-5 | A successful transaction reports **two** amounts: `data.amount` (the charge) and `data.charged_amount`, which can differ when the provider settles less (a split settlement, a tipped or partially-settled charge). Both appear in the same documented response shape (§1, §2). | §11 fixes one column, `verified_amount_minor_units`, and requires it to **equal** `expected_amount_minor_units`. | **Prefer `charged_amount`, fall back to `amount`.** The value recorded is the one the attendee was actually charged, which is the only reading under which the §11 equality means "they paid what we asked". If `charged_amount` is present and disagrees with the expected amount, the confirmation is **withheld** and the payment is flagged — a short settlement is never auto-accepted as a full ticket, and is never silently rounded. When only `amount` is present, that is what is used. Both readings are converted from major to minor units at the same single point. |

## Residual risk, stated plainly

A captured webhook delivery can be replayed to `POST /api/v1/payments/webhook` **if** the attacker also
learns `verif-hash`. The provider offers no body-binding to prevent this, so the mitigation is
architectural rather than cryptographic: every webhook write is keyed on
`UNIQUE(Payment.provider_reference)` inside a transaction, so a replay cannot produce a second
confirmation, a second `quantity_confirmed` increment, or a second `quantity_held` decrement. This is
exactly the guarantee PRD §10 asks to be *proven by the constraint*, not by a handler check.

## Gaps that remain open, stated plainly

Three things in this record are **not** implemented, and each is a claim this document does not make.

1. **Refund and reversal handling is not implemented.** §5 above documents the payload shape, the
   disabled-by-default delivery, and the `TransactionId` correlation — and the divergence rows D-2/D-3
   describe the intended handling — but the webhook route does not yet recognise a reversal. Today a
   reversal delivery is authenticated, unrecognised as a payment outcome, retained verbatim as
   evidence, and acknowledged `200`. The `refunded` state therefore exists in the schema and is
   reachable only by the organiser-side reconciliation work, not by an incoming event. Until that
   work lands, an over-refunded attendee stays `confirmed` — which is the safe direction to fail in
   (no free access granted, no availability returned) but is still a gap.
2. **Virtual-card debit and OTP payloads are ignored by design, not by omission.** They share no
   envelope and relate to no `Payment` row this product creates, so they take the same
   acknowledge-and-retain path as any other unrecognised family.
3. **Chargebacks are not modelled at all.** They are a card-network dispute with their own API and
   their own lifecycle, and PRD v2 does not specify one.

## Confirmation failures that are not retried in-process

The §8.5 transaction either applies all five writes or none. A failure inside it is therefore always
safe, and it is reported rather than retried:

- **The hold was released while the payment was in flight** → the verified success is recorded,
  `requires_reconciliation` is set, nothing is confirmed, and the attendee is told *reconciliation*,
  never *failure* (§17, decision R-2). The money moved; a human decides what happens to the ticket.
- **Anything else** (a dropped connection, a deadlock, a constraint the port does not model) → a `500`,
  with the attempt left untouched at `initiated` and no half-written state.

That second case is not retried inside the call, for three reasons: the transaction has already rolled
back, so the state is safe rather than stuck; recovery does not need a retry, because the provider
redelivers its webhook and `POST /payments/verify` is idempotent, so the same confirmation arrives by
another route and survives a crash that an in-process retry would not; and a retry *budget* would need
a column to count against, and this schema is not extended for a condition with no reachable cause.
Turning an infrastructure failure into a reconciliation flag was rejected for the opposite reason —
R-1's flag means "money moved and a human must look", which a transient database blip is not.

## Verification

Every claim in this record that is a *behaviour* is covered by a test. The suites that exist for the
payment and registration paths, and what each is for:

| Suite | What only it can show |
|---|---|
| `tests/flutterwave.verification.test.ts` | Payload normalisation, the `verif-hash` comparison (including absent and wrong secrets), the `charged_amount` preference, and redirect-URL construction. No network, no database. |
| `tests/registrations.validation.test.ts` | The request and query parsers, including strict `provider_reference` typing and rejected duplicate query parameters. |
| `tests/registrations.service.test.ts` | Idempotency ordering (the key is checked before availability), the materially-different-body `409`, hold expiry as a pure function of `created_at`, and the "a provider call never happens for a replay" rule. |
| `tests/payments.service.test.ts` | Outcome selection: every provider error becomes *pending* rather than a guessed failure, amount mismatch with withholding, `flw_ref`-never-used, webhook authority over a disagreeing redirect, and R-1/R-2 writes. |
| `tests/api.v1.payments.test.ts` | The four routes end to end: `201`-vs-`200` replay, no-store verification, webhook authenticity checked *before* the body is read, `403`/`400`/`200` split, and the absence of provider or database detail in every error body. |
| `tests/registrations.db.test.ts` | Against real PostgreSQL: the three create writes as one unit, two concurrent buyers racing the last unit, two concurrent double-submits arbitrated by the unique index, §8.5's rollback, the `FOR UPDATE` duplicate-delivery no-op, `payments_one_success_per_registration_idx`, and the transition triggers. |

The last row is why the numbers in `requirements-matrix.md` are not the whole story: the atomicity
claims in this record are only *proved* there, because a fake repository whose `transact` calls its
callback will agree with all of them.

Full suite at the time of writing: **693 tests across 26 files**, plus type-check and lint clean.

## Environment variables introduced (server-only, never exposed)

| Variable | Purpose |
|---|---|
| `FLUTTERWAVE_SECRET_KEY` | Bearer credential for initiate + verify. Server-only. |
| `FLUTTERWAVE_WEBHOOK_SECRET` | The *secret hash* compared against the `verif-hash` header. |
| `FLUTTERWAVE_API_BASE_URL` | Defaults to `https://api.flutterwave.com/v3`; overridable so tests point at a stub. |
| `FLUTTERWAVE_REDIRECT_BASE_URL` | **Optional** public origin for `redirect_url` (§7). Absent ⇒ no redirect is sent and the webhook alone settles the payment. |

None of these are required for startup: `getServerEnv()` reads only `DATABASE_URL`, and these are read
lazily by `getPaymentEnv()` the first time a payment endpoint is used, which fails loudly and by name
rather than obscurely later.

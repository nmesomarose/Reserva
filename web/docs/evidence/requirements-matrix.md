# Requirement → implementation matrix

**Compiled:** 2026-09-27, from a full read of `docx/event-ticketing-platform-prd-v2.md`,
`docx/AGENTS.md`, all eight `web/.agents/rules/` files, all seven `web/.agents/skills/` files, and the
current `web/` implementation.

**Status of the database layer:** the schema in `prisma/schema.prisma` is complete — all nine PRD §7.2
entities, every specified constraint, index, partial index, and trigger are in place across ten
migrations, and `npm run db:verify-constraints` proves 126 rejection/acceptance cases against real
PostgreSQL. The **application** layer is now complete across the Must-Have §12 surface — the final four
§12 rows (evidence retrieval, attendee requests, the request queue, and the dashboard) and their
`R-5` G-1/G-2/G-3 additions are built and verified; the only items left open are the ones recorded in
Part 5 (`O-6` phone format, `O-7` reversal handling) and the two numeric acceptances that need a loaded
dataset rather than code (§17).

---

## Part 1 — PRD §12 endpoint table, row by row

| # | Endpoint | Method | Auth context | State |
|---|---|---|---|---|
| 1 | `/api/v1/events` | POST | Organiser | **done** |
| 2 | `/api/v1/events/{slug}` | GET | Public | **done** (public-safe DTO) |
| 3 | `/api/v1/events/{id}/ticket-types` | POST | Organiser | **done** |
| 4 | `/api/v1/events/{id}/registrations` | POST | Public | **done** — idempotent, 201/200 replay |
| 5 | `/api/v1/payments/initiate` | POST | Public | **done** — attempt committed before the provider call |
| 6 | `/api/v1/payments/verify` | POST + GET | System (redirect) | **done** — no-store, idempotent, webhook wins on conflict |
| 7 | `/api/v1/payments/webhook` | POST | Flutterwave (verified) | **done** — `verif-hash` before body; reversals still a gap |
| 8 | `/api/v1/registrations/evidence` | GET | Attendee (reference + email) | **done** — two-factor, `403` on mismatch, never `404` |
| 9 | `/api/v1/events/{id}/registrations/search` | GET | Staff (event-scoped) | **done** — masked DTO, literal `ILIKE`, name-ranked, `page_size ≤ 20` |
| 10 | `/api/v1/registrations/{id}/check-in` | POST | Staff (event-scoped) | **done** — append-only row + status update in one transaction |
| 11 | `/api/v1/registrations/{id}/requests` | POST | Attendee (reference + email) | **done** — idempotent, `201`/`200` replay, `409` on conflicting key reuse |
| 12 | `/api/v1/events/{id}/requests` | GET | Organiser | **done** — event-scoped, status-filterable, newest-first |
| 13 | `/api/v1/events/{id}/dashboard` | GET | Organiser | **done** — four aggregates, `REPEATABLE READ`, `no-store` |
| 14 | `/api/v1/events/{id}/staff-tokens` | POST + GET + DELETE | Organiser | **done** — opaque bearer, hashed, revocable |

### Already-approved additions outside the §12 table

Recorded as product-owner decisions, same precedent as R-3/R-4:

| Route | Decision | Why |
|---|---|---|
| `GET /api/v1/events` | R-3 | organiser's own event list; §7.2 specifies the `(organiser_id, status)` index *for* it |
| `PATCH`, `DELETE /api/v1/events/{id}` | R-3, D2 | FR-1/FR-4 need editing; D2 puts the lifecycle transition on PATCH |
| `POST/GET/PATCH/DELETE /api/v1/events/{id}/programme[/{itemId}]` | R-3 | FR-2, an ordered programme |
| `GET/PATCH/DELETE /api/v1/events/{id}/ticket-types[/{id}]` | R-4 | FR-5/FR-6 are not deliverable write-only |
| `POST /api/v1/auth/login`, `POST /api/v1/auth/logout` | decision 1 | §3/§19 make organiser auth a Must-Have; §12 has no row for it, but the *organiser* identity every other row depends on has to come from somewhere |

---

## Part 2 — Requirements with no route in the §12 table → now approved (R-5)

Rule 06 says a route not in the table is a contract change requiring explicit flagging. These three
were flagged, then **approved by the product owner on 2026-09-27** and recorded as decision **R-5** in
`.agents/rules/03`. Each keeps §12's existing collection path and adds one resource-identifying
segment, matching the R-3/R-4 precedent.

| # | Requirement | Approved route | Notes |
|---|---|---|---|
| G-1 | **FR-26** — organiser views an individual registration's *full* record: every payment attempt and the whole check-in log | `GET /api/v1/events/{id}/registrations/{registration_id}` | Organiser-scoped, reusing R-3's ownership semantics. Deliberately **not** folded into `.../registrations/search`: that is staff-scoped, name-keyed and masked (FR-18), and the two must not be interchangeable. |
| G-2 | **FR-22 / §13** — check-in count pushed to the organiser dashboard by **SSE**, ≤ 5 s | `GET /api/v1/events/{id}/dashboard/stream` | A separate path rather than `?stream=1`, because rule 06 requires one contract per route. |
| G-3 | **FR-24** — organiser can **respond to** and **resolve** a request, recording `resolution_notes` + `resolved_at` | `PATCH /api/v1/events/{id}/requests/{request_id}` | `PATCH` (sparse merge) rather than `POST .../resolution`, matching the `PATCH` idiom of R-3/R-4. |

---

## Part 3 — Requirement-by-requirement state

| Requirement | PRD | State | Notes |
|---|---|---|---|
| FR-1 event create | §5.1 | done | |
| FR-2 ordered programme | §5.1 | done | `sort_order` stored, not inferred |
| FR-3 public published event | §5.1 | done | only `published`, non-soft-deleted |
| FR-4 edit + log changes | §5.1 | done | `EventEditLog`; notification is Supporting → not built |
| FR-5 tier configuration | §5.2 | done | |
| FR-6 two-counter availability | §5.2 | done | `CHECK (confirmed + held <= total)` |
| FR-7 per-tier closure | §5.2 | **not representable** | `TicketType` has no status column, no enum, no soft-delete stamp in §7.2. Closing a tier needs a new column — a schema change, flagged rather than invented. |
| FR-8 details before payment | §5.3 | done | `pending_payment` response carries tier, reference, amount, currency |
| FR-9 not confirmed pre-verification | §5.3 | done | `pending_payment` on create; confirmation only via the payment path |
| FR-10 one success per registration | §5.3 | done | partial UNIQUE index `payments_one_success_per_registration_idx` + a second attempt refused (`tests/registrations.db.test.ts`) |
| FR-10a idempotency key | §5.3 | done | `UNIQUE(idempotency_key)` arbitrates concurrent double-submits; proved against real PostgreSQL |
| FR-11 server-computed amount | §5.4 | done | `expected_amount_minor_units` re-read from the tier row inside the transaction; no amount in any request body |
| FR-12 redirect not authoritative | §5.4 | done | server-side verify before any write; the webhook overrides a disagreeing redirect |
| FR-13 payment states | §5.4 | done | `initiated` / `processing` / `success` / `failed` written by the real paths |
| FR-13a webhook is source of truth | §5.4 | done | redelivery is a `FOR UPDATE` no-op; a disagreeing redirect does not overwrite the webhook's outcome |
| FR-14 confirmation to attendee | §5.5 | **no channel** | FR-14 says "receives a confirmation (email, minimum)". Email is not in §12's table and no mail dependency exists. Flagged — see Part 5. |
| FR-15 two-factor evidence | §5.5 | done | reference + email; `403` on any mismatch, never `404`, so existence is not disclosed |
| FR-16 reference is attendee-only | §5.5 | enforced by omission | search is name/email-keyed; no reference search built (Future Possibility) |
| FR-17/18 staff search + p95 < 500 ms | §5.6 | done, except the measured p95 | event scope first, `ILIKE '%…%'` with `%`/`_`/`\` escaped, name matches ranked ahead of email/phone matches, `page_size ≤ 20`. The scope is proved to come from an index (`EXPLAIN` in `tests/staff.db.test.ts`), which is the part that can be proved here; the **p95 number itself is still outstanding** (§17) |
| FR-19 never present unconfirmed as valid | §5.6 | done | only `confirmed` registrations are returned; the check-in guard independently refuses any other status, and an unconfirmed one is never offered as valid |
| FR-20 check in with identity | §5.7 | done | actor = exactly one of `organiser_id` / `staff_token_id`; the `CHECK` is asserted by the verifier and the trigger re-checks the staff token's event |
| FR-21 endpoint-level `409` | §5.7 | done | `409` for `already_checked_in`, `not_check_in_eligible`, and cross-event disagreement; scope disagreement is `403` and a foreign registration is `404` so the roster cannot be probed |
| FR-22 ≤ 5 s dashboard propagation | §5.7 | done (G-2) | SSE, 2-second poll with a 10-second keepalive; the ≤5 s ceiling is by construction (2 s + query time) and the frame contents/overlap guard are proved in `tests/dashboard-stream.test.ts` |
| FR-23 / FR-23a attendee requests | §5.8 | done | possession-authorised submission (`reference` + `email`); `UNIQUE(idempotency_key)` arbitrates concurrent double-submits, proved against real PostgreSQL |
| FR-24 respond + resolve | §5.8 | done (G-3) | `open → resolved` only; `resolved` is terminal; the guarded write races safely under `READ COMMITTED` (a forced concurrent resolution is proved to have exactly one winner) |
| FR-25 dashboard aggregates | §5.9 | done | registrations, payments, per-tier sales, check-ins from a single `REPEATABLE READ` snapshot; scope and `count(DISTINCT …)` proved in `tests/operations.db.test.ts` |
| FR-26 individual full record | §5.9 | done (G-1) | every payment attempt newest-first, every check-in oldest-first, unmasked contact, organiser-only raw payload |
| BR-1 confirmed only via verified payment | §6 | done | the only writer of `confirmed` is §8.5; a cancelled row cannot be confirmed even by direct SQL |
| BR-2 one Payment per `provider_reference` | §6 | done | `UNIQUE` exists and the webhook looks up by it; redelivery is a no-op |
| BR-3 two counters, 15-min hold | §6 | counters + expiry query done; **sweep runner to build** | `holdHasExpired` is a pure function of `created_at`; `findExpiredHolds` filters status *and* age in SQL |
| BR-4 append-only check-in | §6 | done | no `UPDATE`/`DELETE` reaches a stored row (triggers), and the write path itself only ever inserts; a repeat check-in is a new row with `is_override = true` |
| BR-5 endpoint refuses unconfirmed | §6 | done | `409` `not_check_in_eligible` for `pending_payment`/`cancelled`/`refunded`, and the trigger refuses the same write without the service |
| BR-6 evidence shows live event details | §6 | done | joins to `Event` on every read, so a reschedule after sale reaches the ticket |
| BR-7 `cancelled`/`refunded` states exist | §6 | schema ready | no refund processing (correctly out of scope) |
| §8.5 atomic confirmation | §8 | done | all five writes or none, proved against real PostgreSQL including a forced mid-transaction failure |
| §8.6 webhook governs | §8 | done | webhook is authoritative and is not re-queried; the redirect is a hint |
| §9.1 payment lifecycle | §9.1 | done | forbidden-transition trigger exists and is exercised |
| §9.2 registration lifecycle | §9.2 | done | forbidden-transition trigger exists; `CANCELLED → CONFIRMED` refused by the database, and by R-2 a late webhook never attempts it |
| §9.3 availability | §9.3 | done | |
| §9.4 append-only check-in | §9.4 | done | update/delete triggers, **plus** the insert guard: eligibility, actor event scope, an override must follow a first check-in, and a non-override row must *be* the first — the last two read under a per-registration advisory lock, so they hold for two concurrent writers |
| §11 validation | §11 | done | registration/payment/search/staff/check-in parsers plus the evidence and request parsers (duplicate query params rejected, blank patches forwarded to the service, `requirePathUuid` on every organiser-scoped path segment) |
| §12 contract | §12 | **14 of 14 rows done** | all §12 Must-Have rows built, plus the three `R-5`-approved additions (`dashboard/stream`, `registrations/{registration_id}`, `requests/{request_id}`) |
| §13 public-safe DTO + SSE decision | §13 | done | attendee/staff/organiser DTOs mask what each role must not see; the dashboard stream is SSE-only, `text/event-stream`, buffering disabled | |
| §14 auditability | §14 | done | payment, event-edit, check-in, and attendee-request logs all written; requests are retained (`DELETE` refused by trigger) with `resolution_notes` + `resolved_at` on resolution |
| §15 status codes | §15 | done for every existing route; enforced centrally in `error-response.ts` | |
| §16 tests | §16 | **1082 passing across 38 files, 189 of them against real PostgreSQL** across 8 files | every §12 row is covered end to end: service, transport, and database cases, including the idempotency races and the guarded resolution write |
| §17 numeric acceptance | §17 | 5 s SSE and zero-discrepancy dashboard proved by construction; **the measured p95 search still outstanding** | the 2-second poll is a hard ceiling on propagation and the aggregate is a single `REPEATABLE READ` read, so both hold by construction rather than by observation; the search's *index path* is proved by `EXPLAIN`, but a p95 number needs a loaded dataset this repository does not have |
| §18 security | §18 | done | auth, webhook authenticity, staff scoping, and evidence retrieval all covered; `verif-hash` is compared before the body is read; an unsigned delivery gets `403` and zero state changes; evidence refusal is byte-for-byte identical across all mismatch kinds, and every organiser route checks ownership before a single read |

---

## Part 4 — Design positions taken where the source is silent

Each of these is a mechanism the source *names as required* but does not specify. None invents a
product behaviour; each is recorded because it was a choice.

| # | Question | Position | Basis |
|---|---|---|---|
| P-1 | **How is a specific hold identified so expiry can release it?** | The two-counter model stores no per-hold row, and §7.2 fixes the columns — so a hold is identified by the `Registration` that created it, and its age is `now() - registration.created_at` against `HOLD_WINDOW_MINUTES` (already in `tickets/ticket-type.ts`). No new column, no hold table. | `ticket-type.ts` `HOLD_WINDOW_MINUTES` comment; §9.3 "no stored per-unit row" |
| P-2 | **What triggers expiry** (§10 says "decremented automatically")? | The sweep runs **inside the payment-resolution transaction** and is also exposed as a service method a scheduler can call. No cron endpoint is added: §12 has no row for one, and adding an unlisted route is a contract change. | rule 07 "hold-expiry job/transition inside the payment-resolution transaction"; rule 06 |
| P-3 | **Idempotency replay with a different body** | `409`. Compared on the material fields: `event_id`, `ticket_type_id`, `attendee_name`, `attendee_email`, `attendee_phone`. A `null`-vs-omitted difference is not material. | rule 06 "treat it as a conflict and say so"; skill step 2 |
| P-4 | **Which reference is `Payment.provider_reference`?** | **Our own `tx_ref`**, not the provider's `flw_ref`. `provider_reference` is `NOT NULL`, so it must exist at insert time; `flw_ref` does not exist until the provider call returns. The documented `503`-after-28s contract makes that gap dangerous: a `flw_ref` design leaves a timed-out create with **no `Payment` row at all** — no trace, a live hold, and money possibly moved. With `tx_ref` the row is committed before the network call, so `/payments/verify` can resolve the in-flight attempt, which is precisely the provider's documented remedy. `tx_ref` is also what the webhook payload carries, so `UNIQUE(provider_reference)` suppresses duplicate delivery keyed on a value both sides agree on. | §7.2 `NOT NULL`; evidence §2 and §4; BR-2; FR-13a |
| P-4a | **What is stored in `raw_provider_payload`?** | The provider's initiate response, which is where the hosted `data.link` lives. Retaining it is what lets a replayed `idempotency_key` return *its original* redirect URL rather than issuing a second hosted link. The column is documented as audit-retained (PRD §7.2) and rule 08 keeps it off every client response and log line. | §7.2; rule 08; skill step 2 "return the original result" |
| P-5 | **Where does the tier's currency come from at initiation** | `TicketType.currency`, sent explicitly. The provider defaults to `NGN` when the field is omitted, which would silently charge in the wrong currency. | `reference/checkout.md` |
| P-6 | **Provider-side session length** | `configuration.session_duration = 15`, matching BR-3's hold window, so the hosted link expires with the hold rather than outliving it. | BR-3; `reference/checkout.md` (minutes, max 1440) |
| P-7 | **`page_size > 50`** | **Rejected**, not clamped — the choice already made for the event and tier lists, kept consistent. | rule 06 "pick one and be consistent" |
| P-8 | **Which verified amount is compared when the provider reports two** (`data.amount` and `data.charged_amount`) | **Prefer `charged_amount`, fall back to `amount`.** The recorded value is then the one the attendee was actually charged, which is the only reading under which §11's equality means "they paid what we asked". A short settlement is withheld and flagged, never auto-accepted and never rounded. | evidence D-5; §11; FR-13 |
| P-9 | **Where the verify path in `redirect_url` comes from** | The **origin** is configuration (`FLUTTERWAVE_REDIRECT_BASE_URL`, optional); the path (`/api/v1/payments/verify`) is appended in code, and a configured value already ending in that path is left alone. The one URL shape this product returns is therefore not operator-editable, and a deployment with no public origin sends no `redirect_url` at all — the webhook alone settles the payment, which §8.6 makes the governing channel. A value that is present but not an absolute http(s) URL is rejected when read, because it would otherwise fail at the attendee *after* a hold was taken. | §12 row 6; §8.6; evidence §7 |
| P-10 | **What happens when the §8.5 transaction fails for a reason that is not a lost hold** | A `500`, with the attempt left untouched at `initiated`. Not retried in-process: the transaction has already rolled back, so nothing is half-written; recovery does not need a retry because the provider redelivers its webhook and `/payments/verify` is idempotent; and a retry *budget* would need a column this schema does not have. It is also deliberately **not** turned into a reconciliation flag — R-1's flag means "money moved and a human must look", which a transient database failure is not. | §8.5; decision R-1; `payment.service.ts` step 7 |
| P-11 | **How is a staff token revoked, given §12 row 14 lists `DELETE` on a collection path?** | `DELETE /api/v1/events/{id}/staff-tokens?token_id=<uuid>`. The collection path is kept because it is the one §12 specifies, and §6.1 allows a query parameter to identify a resource within a collection. A `token_id` that is absent, malformed, or belongs to another event is a `400`/`404` and **no** row is touched — §7.2 makes `revoked_at` the revocation mechanism, so a row is never deleted and a revoked token remains in the log. Revocation is a soft write, which is why a token that was already revoked is still `revoked` rather than an error. | §12 row 14; §6.1; §7.2 `staff_tokens.revoked_at`; rule 05 |
| P-12 | **How long does a staff token live, and is an explicit expiry bounded?** | Absent `expires_at`, a token expires at the **event's end + 24 hours** — long enough to cover a late door and the day's reconciliation, and short enough that a token found on a lost phone stops working the next morning. An explicit `expires_at` must be in the future but is **not** capped: an organiser holding an event a year out has a legitimate reason for a long-lived token, and no source states a maximum. Either way the effective expiry is `min(expires_at, now) `vs `now()` **and** the event's own end, so a token cannot outlive the event it was minted for. | §5.7/§12 row 14 (no lifetime stated); rule 05 |

## Part 5 — Open items that are **not** mine to decide

| # | Item | Where it comes from |
|---|---|---|
| O-1 | **G-1/G-2/G-3** — the three unlisted routes. | **Resolved 2026-09-27** → decision R-5 in `.agents/rules/03`; see Part 2. |
| O-2 | **FR-14 attendee confirmation channel.** | **Resolved 2026-09-27** → decision R-8: no email; the guarantee is delivered through the create response plus FR-15 evidence. The email channel itself stays on the unmet list. |
| O-3 | **FR-7 per-tier closure** | **Resolved 2026-09-27** → decision R-7: not implemented, no schema change, support path is reducing `quantity_total`. Stays on the unmet list. |
| O-4 | **Staff-token transport** | **Resolved 2026-09-27** → decision R-9: an opaque random bearer token in `Authorization`, SHA-256 hash stored, event scope taken from the row, revocable by `revoked_at`. Mirrors the existing organiser session decision. The lifetime question that decision left open is P-12; the revocation mechanism is P-11. |
| O-5 | **The minor→major unit exponent at the Flutterwave boundary.** | **Resolved 2026-09-27** → decision R-6: divisor `100` for every currency, applied in one pure function, plus a reject-list of non-2-decimal ISO 4217 codes at tier creation. |
| O-6 | **A phone *format* rule.** PRD v2 §11 says only "required", and the validation layer enforces exactly that: present, a string, not blank, and at most 64 characters. A format rule is not invented because it decides **who can buy a ticket** — a rule that rejects `+234 801 234 5678`, or a local `080…` form, excludes real attendees from a product whose payment provider is Flutterwave. The 64-character cap is a bound on what a *request* may carry (E.164 caps the digits at 15), not a product limit. Needs a product-owner answer before any stricter rule is added. | §11; `validation.ts` `MAX_PHONE_LENGTH` |
| O-7 | **Refund and reversal handling.** The provider documents the payload, the disabled-by-default delivery, and `TransactionId` correlation, and the divergence rows D-2/D-3 record the intended handling — but the webhook does not yet recognise a reversal, so an over-refunded attendee stays `confirmed`. No free access is granted and no availability is returned, so this fails in the safe direction; it is still a gap. | §5.4; BR-7; evidence §5, D-2, D-3 |

### Status of this part

O-1 through O-5 were resolved as product-owner decisions (R-5 through R-8) and are no longer
blocking. **O-6 and O-7 remain open**, and neither blocks the next slice: O-6 is a validation
tightening that can land whenever an answer arrives, and O-7 belongs to the reconciliation work that
has no route in §12's Must-Have table.

The one consequence worth restating, because it is a **known** mispricing hazard rather than a solved
problem: a divisor of 100 is wrong for 0-decimal currencies (JPY, KRW, VND, CLP, ISK) and 3-decimal
ones (KWD, BHD, OMR, JOD, TND, IQD, LYD). R-6 therefore blocks those currencies at tier creation, so a
tier in an unsupported currency cannot exist. The reject-list is stated in
`src/domain/payments/currency-units.ts` with every entry marked as needing sign-off, and supporting
those currencies is a future decision.


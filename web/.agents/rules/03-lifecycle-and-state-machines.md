# Rule 03 — Lifecycle & State Machines

**Axis: which state transitions are legal, and what guards them.** Rule 02 owns
the column types; rule 07 owns what happens when two callers race the same
transition.

PRD §9 defines four lifecycles as contracts. **Forbidden transitions are enforced,
not merely documented** (AGENTS.md §5): they must be unreachable through the write
path, via application-transaction guards at minimum and a database
trigger/constraint where practical.

## Never resolve an unexpected state by overwriting

Do not patch an invalid state by writing whatever value seems convenient onto
`status`. A Check-in exists for a registration whose payment was later reversed
is a **`requires_reconciliation`** case (PRD §8.5/§8.6, AGENTS.md §9) — a
queryable flag for a human, not a silent `UPDATE`.

For every transition you implement, answer all five:

1. What is the current state (read server-side, inside the transaction)?
2. Is the requested transition in the allowed list for that lifecycle?
3. Is the caller authorized to trigger it? (→ rule 05)
4. What happens if two callers trigger it concurrently? (→ rule 07)
5. What is the transaction boundary, and what rolls back if a later step fails?

## Payment lifecycle (PRD §9.1)

```
INITIATED → PROCESSING → SUCCESS (verified) → CONFIRMED [terminal]
                       → FAILED               [terminal]
                       → PENDING → (resolves to SUCCESS or FAILED)
```

- **Forbidden:** `INITIATED → CONFIRMED` directly. Confirmation requires
  verification; there is no shortcut path, including an internal/admin one.
- **Forbidden:** `FAILED → SUCCESS` on the same row. A failed attempt can never
  later succeed — a **new** `Payment` row is created (1:N cardinality).
- Only a *server-verified* success may reach `SUCCESS` (BR-1). No other signal —
  redirect query params, client assertion, webhook without signature
  verification — confers it.

## Registration lifecycle (PRD §9.2)

```
PENDING_PAYMENT → CONFIRMED        (a Payment attempt reaches verified success)
                → CANCELLED         (all attempts failed / hold expired, none succeeded)
CONFIRMED       → CHECKED_IN        (cached projection; source of truth is Check-in)
CONFIRMED       → REFUNDED / CANCELLED
```

- **Forbidden:** `CANCELLED → CONFIRMED`.
- **Forbidden:** `CANCELLED`/`REFUNDED` → `CHECKED_IN`.
- **Forbidden:** `CHECKED_IN → PENDING_PAYMENT` — no backward transitions.
- `CANCELLED` and `REFUNDED` must exist as reachable states (BR-7) but **no
  refund processing workflow is built** (PRD §20).
- `CONFIRMED` is reachable **only** via independently-verified successful
  payment (BR-1). A registration is never presented to staff tooling as valid
  while non-confirmed (FR-9).

## Ticket availability lifecycle (PRD §9.3)

```
AVAILABLE → HELD (routed to payment) → CONFIRMED (payment succeeds)
                                   → AVAILABLE (hold expires or payment fails)
```

Conceptual per unit — there is **no stored per-unit row**. Enforced by the
two-counter model (BR-3) plus `CHECK(quantity_confirmed + quantity_held <=
quantity_total)`, so negative availability is a **rejected database write**, not
an application bug.

- `quantity_held` increments when the attendee is routed to payment.
- `quantity_held` decrements when the hold expires (**15-minute window**, BR-3) or
  when the associated payment resolves either way.
- `quantity_confirmed` increments **only** on a payment reaching verified success.
- Counter changes and the `Registration.status` change belong to the **same
  transaction** as the payment resolution. A counter updated outside it is a bug.

## Check-in lifecycle (PRD §9.4) — append-only

```
(no row)              → CHECK-IN #1  (is_override = false)
CHECK-IN #1 exists    → CHECK-IN #2  (is_override = true, explicit staff confirmation)
```

- **"Currently checked in" is derived from the latest Check-in row**, never from
  an overwritable field (BR-4). The `Registration.status = checked_in` value is a
  maintained projection of that, per rule 02.
- **Forbidden:** creating a Check-in row for a Registration whose status is
  neither `confirmed` nor `checked_in` — enforced at the **API layer** (FR-21,
  returns `409`) and as a transaction/DB guard, not by omitting a UI control
  (PRD §9.4, AGENTS.md §7).
- A second check-in requires an explicit `override=true` from the caller and is
  recorded as its own, separately auditable row. It is never an edit.
- The converse is forbidden too, and is the direction that protects the log: a row
  **without** `is_override` must be the first one. Enforcing only "an override needs a
  prior" would let two rows each claim to be the arrival, and "when did they arrive"
  stops being answerable. The database enforces both halves (`check_ins_insert_guard`)
  and reads the history under a per-registration advisory lock, so the pair holds for
  two concurrent writers and not only for a sequential one.
- Existing Check-in rows are never updated or deleted (PRD §14).

## Attendee request lifecycle (PRD §9 does not define one) — two states

FR-24 says an organiser may "view, **respond to**, and **resolve**" a request, which
names two distinct writes that §7.2's `open`/`resolved` enum only partially
specifies. The lifecycle below separates them, and the "response vs resolution" split is a
**product decision** rather than a reading of §9:

```
OPEN ── resolution_notes only ────────────→ OPEN    (a response, still open)
OPEN ── status: resolved + nonblank notes ─→ RESOLVED [terminal]
```

- **Forbidden:** `RESOLVED → OPEN` (no reopening). A resolved request is retained
  for audit (PRD §14) but never transitions again.
- A **response** (notes without `status: resolved`) leaves the request `open`: the
  organiser has acknowledged it without closing it. A **resolution** is the
  explicit `status: resolved` write, which requires nonblank `resolution_notes`.
- `status` and `resolved_at` must agree (`resolved` implies a timestamp, `open`
  implies none) — enforced by the `attendee_requests_status_resolved_at_check`
  CHECK and by the `attendee_requests_guard_update` trigger, not by the service
  alone.
- The resolution write is guarded and runs under **`READ COMMITTED`**, not the
  default `REPEATABLE READ`: the conditional `WHERE status = 'open'` UPDATE must
  see rows a concurrent resolver just committed, or two racing resolutions would
  both "win". Proved by `tests/requests.db.test.ts`'s forced-lock interleaving.

## Event lifecycle (PRD §9 does not define one) — forward-only

PRD §9 enumerates four lifecycles and **Event is not among them**, yet §7.2 gives
`Event.status` a four-value enum and §12 lists no publish/close endpoint. The
lifecycle below is a **product-owner decision (R-3)**, not a reading of §9:

```
DRAFT → PUBLISHED → CLOSED [terminal]
  └──────────────────→ CLOSED        (an unpublished event may be abandoned)
```

- **Forbidden:** `PUBLISHED → DRAFT` (no unpublishing).
- **Forbidden:** `CLOSED → PUBLISHED` and `CLOSED → DRAFT` (no reopening).
- A request that sets the status the event already holds is a **no-op**: it is
  accepted, writes nothing, and appends no audit row (rule 02's append-only log
  would otherwise record a change that did not happen).
- There is no separate publish/close route. `status` is a field on
  `PATCH /api/v1/events/{id}`, so a transition and an edit are one atomic write
  and cannot disagree.
- An illegal transition is a **`409`** (rule 06), raised in the domain layer, not
  a `400`: the request is well-formed, the state is not.

## Transition guards

Guards live in the domain layer, not inline in route handlers (AGENTS.md §4).

- Read current state and validate the transition **inside the same transaction**
  that performs the write. A guard that reads state in a separate earlier request
  is a TOCTOU gap.
- A guard that rejects must map to the status code the PRD assigns (rule 06):
  `409` for state conflicts.
- Guards are not UI concerns. Hiding or disabling a control is never the
  enforcement; the endpoint must reject.

## Transaction boundaries

- The Payment confirmation sequence is **one transaction** (PRD §8.5) — see rule
  04 for the exact steps and ordering.
- The Check-in insert + `Registration.status` projection update are **one
  transaction** (PRD §7.4).
- An Event update and its `EventEditLog` append are **one transaction**. A logged
  change that was not written, or a written change with no log row, is a bug in
  both directions (R-3). Implemented 2026-09-26 (decision 7):
  `EventRepository.transact` opens an interactive Prisma transaction, and
  `EventService.updateEvent` / `softDeleteEvent` take the ownership read, the
  write, and the append off the transaction handle rather than the repository.
  Evidenced by `tests/events.transactions.db.test.ts`, which fails the audit
  insert inside a real transaction and asserts the event row is unchanged — the
  fake in `events.service.test.ts` proves the ordering, that file proves the
  rollback.
- Inventory counter changes + payment resolution + registration status are **one
  transaction** (BR-3).
- If a step fails, the whole transaction rolls back and the row stays at its
  pre-transaction state. Retries are safe and are the *same* sequence, not a
  partial re-application.
- Never surface a rolled-back-but-actually-paid payment to the attendee as a
  failure (PRD §8.5, §17 Attendee Trust).

## Stop conditions

- The required behaviour needs a state the PRD §7.2 enums do not contain. The
  clearest live example: PRD §8.5/§15 require a queryable
  `requires_reconciliation` state, but `Payment.status` is enumerated as
  `initiated|processing|success|failed|pending` and `success` is terminal in
  §9.1. **Where that flag lives — a new column, a new enum value, or a separate
  record — is a product-owner decision. Do not invent it.**
  → *Resolved 2026-09-26: `Payment.requires_reconciliation` boolean column. See
  "Resolved product-owner decisions" below.*
- PRD §9.2 makes `CANCELLED → CONFIRMED` forbidden and allows
  hold-expiry-driven `CANCELLED`, while §8.6/§10 make the webhook the eventual
  source of truth that must reconcile the registration. A webhook reporting
  success *after* a hold expiry cancelled the registration hits both rules.
  **Stop and ask which governs** rather than picking one.
  → *Resolved 2026-09-26: the §9.2 lifecycle governs. See "Resolved product-owner
  decisions" below.*
- Any transition the PRD does not enumerate and that would change observable
  behaviour.
  → *Resolved 2026-09-26 for Event: the forward-only lifecycle in R-3. The
  ownership semantics of the new organiser routes (404 vs 403) were resolved in
  the same decision.*

## Resolved product-owner decisions

These are **not** derivable from the PRD — each resolved a genuine conflict
between two PRD v2 statements, or a PRD requirement the §7.2 schema did not
model. They are recorded here so they are not re-litigated, and they are
**narrower** than the rules above: anything beyond what is written here is still
a stop condition.

### R-1 — `requires_reconciliation` is a `Payment` column, not a status

**Decision (product owner, 2026-09-26).** `Payment.requires_reconciliation`,
`NOT NULL DEFAULT false`. It is a flag, **not** a `Payment.status` value and not
a separate record.

Rationale: PRD §10's source-of-truth column fixes the row as "Payment row
(already `success`)", and §8.5/§11 both describe *flagging the Payment row*.
Marking the row `success` and flagging it satisfies both without inventing an
enum value (rule 02) or an entity (rule 02:30).

Consequences:

- `Payment.status` stays exactly `initiated|processing|success|failed|pending`.
  A reconciliation flag never changes the status.
- The attendee-facing state in PRD §15 is a **projection**: a `success` payment
  with `requires_reconciliation = true` must surface as reconciliation, never as
  a failure and never as a plain confirmation.
- The flag is set when the confirmation transaction cannot complete — retries
  exhausted (§8.5) or a `verified_amount_minor_units` mismatch (§11) — and in the
  late-webhook case below.
- It is queryable, so an organiser-facing reconciliation queue may filter on it.
  Any index for it must name the query it serves (rule 02).

### R-2 — Late webhook after a hold-expiry cancellation: the lifecycle governs

**Decision (product owner, 2026-09-26).** When a signature-verified webhook
reports success for a `provider_reference` whose registration is **already
`CANCELLED`** because the 15-minute hold expired:

1. The `Payment` row is updated to `success` with `verified_at` and
   `verified_amount_minor_units` — the money did move, so the webhook governs
   the *payment* truth (PRD §8.6, FR-13a). This is a field update, **not** a
   lifecycle transition.
2. `Payment.requires_reconciliation` is set to `true` (R-1).
3. `Registration.status` **stays `CANCELLED`**. The `CANCELLED → CONFIRMED`
   prohibition in §9.2 is **not** relaxed, and no `quantity_confirmed` increment
   or `quantity_held` decrement occurs — the hold already released those units
   (PRD §10, BR-3).
4. The attendee is never shown a failure for money that succeeded (§17); the
   state is surfaced as reconciliation (§15).
5. Resolution is a **human** action — grant a ticket or refund out-of-band. No
   refund *processing* workflow is built (PRD §20), and no automated re-confirm
   path exists.

This resolves the conflict without weakening §9.2: the webhook remains
authoritative about the payment, while the registration lifecycle stays closed.
Note the residual PRD divergence is reported, not silently absorbed — see the
note in the task report.

### R-3 — Event lifecycle, mutation routes, and the edit log

**Decision (product owner, 2026-09-26).** The Event slice is implemented as
follows. None of it is derivable from PRD §9/§12, which is why it is written down
here rather than inferred per-request.

**Routes** (§12's two-row table is silent on these; each is an approved addition):

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/events` | The caller's own events, paginated (rule 06 envelope) |
| `PATCH` | `/api/v1/events/{id}` | Partial update **and** status transition |
| `DELETE` | `/api/v1/events/{id}` | Soft delete, `204` |
| `POST` | `/api/v1/events/{id}/programme` | Add a programme line, `201` |
| `PATCH` | `/api/v1/events/{id}/programme/{item_id}` | Merge a programme line |
| `DELETE` | `/api/v1/events/{id}/programme/{item_id}` | Remove a programme line, `204` |

There is deliberately **no** programme read route and **no** audit-log read route:
neither was approved, so neither is implied. A service method that can list a
programme is not a public surface, and an audit log that can only be written is
still an audit log.

**Lifecycle:** the forward-only graph in "Event lifecycle" above. `closed` is
terminal.

**Ownership semantics** (rule 05, and the reason these are recorded):

- Unknown id → `404`. It may not exist, or it may not be yours; the two are
  indistinguishable to a stranger and that is deliberate.
- Existing id owned by another organiser → `403`. The caller is authenticated and
  the resource exists; hiding that behind a `404` would be a false statement.
- A programme item that does not belong to the event in the path → `404`, for the
  same anti-enumeration reason, even when the item itself exists.

**Edit log (PRD §14 L420, §20 L501, BR-6 L158).** A `published` event's edits are
appended to `EventEditLog`; this is Must-Have per §20 and outranks the §14/§20
ordering ambiguity.

- The row records **who** edited (`organiser_id` is carried per row, not derived
  through the event) **what** changed, and **when**.
- `changes` is a non-empty JSON object keyed by API field name, each value
  `{"from": …, "to": …}`. A before-and-after pair is what lets BR-6 answer *why*;
  storing only the new value could not.
- Audited fields: `name`, `description`, `starts_at`, `ends_at`, `venue`,
  `status`, `deleted_at`.
- The gate is the event's status **before** the request. A `draft → published`
  request logs only what the same request changed, not the publish itself.
- A write that changes nothing logs nothing — a `changes` object must be non-empty,
  enforced by a `CHECK` so "log only real changes" is a database invariant and not
  an application convention.
- The log is **append-only**, enforced by triggers exactly as Check-in is (§9.4),
  and both FKs are `ON DELETE RESTRICT`: audit evidence must not be deleted along
  with the event or its author. Events are soft-deleted precisely so this holds.

**Consequences and residual limits, stated rather than absorbed:**

- `EventEditLog` is a **new entity**; PRD §7.2 tabulates no log table. There is no
  `TicketTypeEditLog` — the same requirement is not read into PRD §14's other
  entities.
- Soft-deleting a `published` event is logged as a `deleted_at` change, treated as
  an ordinary field edit. Flagged for owner review.
- Creation-time `status` remains **ambiguous**: FR-1 L101 lists `status` among
  create fields while §7.2's default is `draft`. The implementation hard-codes
  `draft`; making it settable is still a stop condition.
- `deleted_at` is never exposed as a public response field, even though it is
  audited.

### R-4 — Ticket tier mutation routes

**Decision (product owner, 2026-09-26).** PRD §12's table has exactly one ticket-type
row: `POST /api/v1/events/{id}/ticket-types`. The other three routes below are
**approved additions**, recorded here for the same reason R-3 records the Event
slice's: without them FR-5/FR-6 are only half deliverable, because a tier's `name`,
`description`, `price_minor_units`, `currency`, and `quantity_total` are all editable
and there is otherwise no documented way to edit them or to see what an organiser has
already created.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/events/{id}/ticket-types` | The event's tiers, paginated (rule 06 envelope) |
| `PATCH` | `/api/v1/events/{id}/ticket-types/{ticket_type_id}` | Sparse merge of the editable fields |
| `DELETE` | `/api/v1/events/{id}/ticket-types/{ticket_type_id}` | Hard delete, `204`, unless registrations reference the tier |

**No ticket-type lifecycle is introduced.** A tier has no `status` column, no state
graph, and no closure: FR-7's "per-tier closure" is **not implemented**, because
§7.2 gives `TicketType` no column to represent it and inventing one would be a new
entity, not a reading of the PRD. This is reported as a stop condition (see
"Stop conditions" above), not absorbed. The *event* being `closed` is what stops
sales, and it does so for its tiers.

**Ownership semantics** are R-3's, applied to the child:

- Unknown event → `404`; another organiser's event → `403`.
- A tier that does not belong to the event in the path → `404`, even when the tier id
  is real. The route resolves the tier *through the owned event*, never by id alone.
- The counters are **not** editable and not readable through a PATCH body: they move
  only through the §9.3 conditional transitions above.

**Residual limits, stated rather than absorbed:**

- The list has **no filter parameter**. §12 scopes the extra list parameters to two
  endpoints — "Search additionally supports `query`; requests additionally supports
  `status`" — and this is neither. Scoping is by ownership of the event in the path,
  enforced server-side, so a caller cannot widen it.
- Ordering is `name ASC, id ASC`. The PRD specifies no display order, but a list
  whose order varies between two identical requests is not a contract, and paging
  over an unstable order silently drops and repeats rows.
- `PATCH` with a `quantity_total` below `quantity_confirmed + quantity_held` is
  refused by the **database** (`400`, naming the field), not by a service pre-check.
  A pre-check is a read-then-write race and a second rule free to disagree with the
  first.
- Deleting a tier is a **hard** delete, unlike an event's soft delete: §14's retention
  rule governs audit and payment evidence and a tier is configuration. The database
  still holds the veto — `Registration.ticket_type_id` is `RESTRICT`, surfaced as
  `409` — so sales history cannot be orphaned through this route.
- The 15-minute hold **window** is a domain constant, but the expiry *sweep* is not
  here. Deciding which hold is stale is a question about a specific in-flight
  `Registration`, and the two-counter model stores no per-hold row or timestamp
  (§9.3, §7.2). The sweep belongs to the registration slice; inventing a
  `hold_expires_at` column would be exactly the per-unit inventory rows the skill
  rules out.

### R-5 — Three Must-Haves have no §12 row: the routes that carry them

**Decision (product owner, 2026-09-27).** PRD §12's table has no route for three Must-Have
requirements. Each is now served by an **approved addition**, recorded for the same reason R-3 and R-4
record theirs. Each keeps §12's existing collection path and adds exactly one resource-identifying
segment, so the shape matches the precedents already accepted, and each keeps one path serving one
response type.

| Gap | Requirement | Approved route |
| --- | --- | --- |
| G-1 | FR-26 — an individual registration's *full* record: every payment attempt and the whole check-in log | `GET /api/v1/events/{id}/registrations/{registration_id}` |
| G-2 | FR-22 / §13 — the dashboard's check-in count pushed by **SSE**, ≤ 5 s | `GET /api/v1/events/{id}/dashboard/stream` |
| G-3 | FR-24 — respond to and resolve an attendee request, recording `resolution_notes` + `resolved_at` | `PATCH /api/v1/events/{id}/requests/{request_id}` |

Rationale for the shape, and it is the reason a query-parameter variant was rejected: rule 06 requires
one contract per route, and `GET .../dashboard?stream=1` would serve two different response types on
one path. G-3 is a `PATCH` rather than a `POST .../resolution` sub-action because the write is a
sparse merge of resolution columns, matching the `PATCH` idiom R-3/R-4 already established.

G-1 is **organiser**-scoped and reuses R-3's ownership semantics exactly: unknown event `404`,
another organiser's event `403`, a registration that does not belong to the event in the path `404`.
It is a **separate route from** `GET /api/v1/events/{id}/registrations/search` on purpose — that one
is staff-scoped, name-keyed, and masked (FR-18), and an organiser's unmasked full record must not be
reachable through a staff endpoint or vice versa.

### R-6 — The minor→major unit conversion at the Flutterwave boundary

**Decision (product owner, 2026-09-27).** PRD §7.2 L212 stores money in **minor units** ("e.g. kobo
for NGN"). Flutterwave's `amount` is in **major units** — proved by their own examples, decisively the
verify response `amount: 3000 / app_fee: 1000 / amount_settled: 2000` for `NGN`, where
`amount − app_fee = amount_settled` holds only in whole Naira. A conversion is therefore **mandatory**;
sending `price_minor_units` through unchanged would bill a ₦5,000 ticket as ₦50,000.

**Decision: the divisor is `100` for every currency.** It is applied in exactly one pure function,
`minorUnitsToMajorUnits`, and nowhere else. Full evidence, including the correction of an earlier
wrong claim in `docs/evidence/flutterwave-verify-resolution.md`, is in that file.

Consequences, each of which is a constraint rather than a preference:

- `expected_amount_minor_units` and `verified_amount_minor_units` remain in **minor units** — §7.2
  fixes both column names and meanings. §11's equality check therefore compares two minor-unit values
  and needs **no** conversion. The conversion exists only at the provider boundary: on the way out
  (initiation) and on the way back in (reading a verified amount).
- The conversion is **not** `Math.round(minor / 100)`. A price that is not a whole major unit is a
  mispricing the platform must not silently absorb, so the function requires an exact result and
  refuses a non-multiple.
- **Known limitation, accepted rather than hidden:** a divisor of 100 is wrong for the 0-decimal
  currencies (JPY, KRW, VND, CLP, ISK) and the 3-decimal ones (KWD, BHD, OMR, JOD, TND, IQD, LYD). A
  tier in such a currency is mispriced by 100× or 1000×. §11 requires only that a currency be a
  well-formed three-letter code and deliberately does **not** check a registry, so there is no
  in-repo source of the true exponent and an ISO 4217 table written from memory would be invented
  data (rule 04, AGENTS.md §6). A **reject-list of non-2-decimal ISO 4217 codes is applied at tier
  creation** so such a tier cannot be created and silently mispriced; the list is stated in
  `src/domain/payments/currency-units.ts` and every entry in it is flagged as requiring sign-off.
  Support for those currencies is a future decision, not an oversight.

### R-7 — FR-7 per-tier closure stays unimplemented; the guide is a redirect, not a send

**Decision (product owner, 2026-09-27).** FR-7 is **not implemented**. PRD §7.2 gives `TicketType` no
`status` column, no enum, and no soft-delete stamp, so a closed tier is not representable without a
schema change to a PRD-defined table. No column is added. `TicketType` remains unversioned and
R-4's statement that no tier lifecycle exists is unchanged and still correct.

What this costs is stated rather than absorbed: an organiser cannot close one tier while leaving
others selling, and the support path is to reduce `quantity_total` to `quantity_confirmed +
quantity_held`, which the database CHECK already permits and which stops sales for that tier
effectively. It is **not** the same as closure — an existing tier can be reopened by raising
`quantity_total` again — and that difference is the requirement being left unmet. FR-7 remains on the
reported list.

### R-8 — FR-14's email confirmation is deferred, not faked

**Decision (product owner, 2026-09-27).** No outbound email is sent. FR-14's *"receives a
confirmation (email, minimum)"* is satisfied through the surfaces that already exist instead:

- the `POST /api/v1/events/{id}/registrations` response carries the reference, the tier, and the
  state, so the attendee has a confirmation at the moment of the transaction that produces it;
- `GET /api/v1/registrations/evidence` (FR-15) returns the live confirmation on demand, two-factor.

Rationale: there is no mail dependency, §12 has no route for one, and adding a provider would mean
new credentials plus delivery-failure and retry semantics the PRD specifies nowhere — all of it
unrequested scope. A `notification_sent`-style flag was also rejected: a flag that claims a
conformance it does not have is worse than an honest gap.

**FR-14's email channel is therefore recorded as unmet**, and a client-rendered confirmation page is
the intended substitute. If a transactional email provider is adopted later, the confirmation
transaction is the correct place to enqueue from, and no schema change would be needed.

### R-9 — Staff tokens are opaque bearer tokens whose lifetime is bounded by the event

**Decision (product owner, 2026-09-27).** PRD §19 and AGENTS.md §21.4–5 name staff-token transport as a
decision the implementer must make and record; rule 05 leaves it to that record. The decision mirrors
the organiser-session decision already taken, because the two identities have the same shape — a
holder of an opaque credential acting on one event's behalf:

- **Transport.** `Authorization: Bearer <token>`, the standard header, so the token travels in the
  slot HTTP already reserves for credentials and no custom header has to be configured at the door.
- **Storage.** 32 random bytes, base64url-encoded; only the **SHA-256 hash** is stored. The plaintext
  exists in the creation response and nowhere else — it is never logged, never listed, and never
  returned again. `UNIQUE(token_hash)` makes the lookup unambiguous (rule 02).
- **Lifetime.** Absent `expires_at`, a token expires at **the event's end + 24 hours**: enough for a
  late door and the day's reconciliation, short enough that a token on a lost phone stops working the
  next morning. An explicit `expires_at` must be in the future but is **not** capped — an organiser
  staging an event a year out has a legitimate reason for a long-lived token, and no source states a
  maximum. In both cases a token is unusable once the event has ended, so it cannot outlive the event
  it was minted for.
- **Revocation** is `revoked_at`, never a delete: `DELETE /api/v1/events/{id}/staff-tokens?token_id=…`
  keeps §12 row 14's collection path, and §6.1 permits the query parameter to pick the row. A token
  from another event is a `404` and touches nothing, so the path cannot be used to probe or revoke
  another event's tokens.

**Scope is unchanged and is the load-bearing part** (rule 05): the event comes from the token row, never
from the request. `GET /api/v1/events/{id}/registrations/search` and
`POST /api/v1/registrations/{id}/check-in` are staff routes whose *scope* is the token's event; the
registration is what the caller names, not which event it belongs to. A registration outside the
token's event is answered **`404`, not `403`** — a `403` would confirm the registration exists, which is
the roster-probing leak §18 exists to prevent. A *path* that disagrees with the token's event is a
different case and is a `403`, because the caller named their own scope incorrectly rather than
reaching for someone else's.

## Related

- `02-domain-model-and-data-integrity.md` — enums, constraints, the Check-in log
- `04-payment-and-flutterwave-integrity.md` — the confirmation transaction
- `06-api-contract-and-validation.md` — status codes and the pagination envelope
- `07-concurrency-idempotency-and-check-in.md` — concurrent and duplicate cases

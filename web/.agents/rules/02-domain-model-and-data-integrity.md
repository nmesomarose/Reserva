# Rule 02 — Domain Model & Data Integrity

**Axis: guarantees the database itself must provide.** Application-layer checks
are a second line of defence, never the first (AGENTS.md §5).

The schema in PRD §7 is contractual. Where the PRD names a constraint, a check
that lives only in application code is a **gap**, not an implementation.

## Entities and cardinality

Nine entities, no N:N relationships (stated deliberately, PRD §7.3):

```
Organiser 1:N Event
Event     1:N ProgrammeItem, TicketType, Registration, StaffToken
TicketType 1:N Registration
Registration 1:N Payment          <- 1:N, not 1:1 (v1's core bug)
Registration 1:N Check-in         <- append-only log, not a status field
Registration 1:N AttendeeRequest
```

- **No `Attendee` entity.** Name/email/phone live on `Registration` (PRD §7.1,
  a deliberate scope decision). Do not introduce a cross-event attendee table,
  profile, or account.
- **`Payment` is 1:N with `Registration`.** One registration may have several
  attempts; at most one may reach `success`. Modelling this 1:1 reintroduces
  v1's blocking bug.
- **`Check-in` is 1:N with `Registration`.** An override is a **new row** with
  `is_override = true`. Never update or delete an existing Check-in row.
- No speculative extra entities, join tables, or columns beyond PRD §7.2.

## Identifiers

- UUID primary key on **every** entity.
- `Registration.unique_reference` and every `idempotency_key`: **≥ 128 bits of
  entropy**, non-guessable, `UNIQUE`. Never sequential, never a short numeric
  or human-readable code, never derived from a counter or timestamp.
- `StaffToken` stores a **hash**, not the token value.
- No client-supplied value may ever become a primary key or override a
  server-generated one.

## Money

- Integer **minor units** (`price_minor_units`, `expected_amount_minor_units`,
  `verified_amount_minor_units`) plus an ISO 4217 `string(3)` `currency`.
- Never a float. Never a bare decimal without a currency code beside it. Never a
  formatted string like `"NGN 5,000"` in a money column.
- Never a client-supplied amount on any path (FR-11) — see rule 04.

## Foreign keys and delete behaviour

Exact referential actions from PRD §7.2, no substitutions:

| Relationship | Action |
|---|---|
| `Event.organiser_id` → Organiser | `RESTRICT` |
| `ProgrammeItem.event_id` → Event | `CASCADE` |
| `TicketType.event_id` → Event | `RESTRICT` if registrations exist |
| `Registration.event_id` / `.ticket_type_id` | `RESTRICT` |
| `Payment.registration_id`, `Check-in.registration_id`, `AttendeeRequest.registration_id` | `RESTRICT` |
| `StaffToken.event_id` → Event | `CASCADE` |

## Uniqueness and check constraints

- `UNIQUE`: `Event.slug`; `(TicketType.event_id, name)`;
  `Registration.unique_reference`; `Registration.idempotency_key`;
  `Payment.provider_reference`; `AttendeeRequest.idempotency_key`.
- `CHECK`: `quantity_confirmed + quantity_held <= quantity_total`;
  `quantity_confirmed >= 0 AND quantity_held >= 0`.
- **`UNIQUE(Payment.provider_reference)` is the single most important constraint
  in the schema** (PRD §7.2). Idempotency is *not* a `SELECT`-then-`INSERT`
  check; that has a race window under concurrent webhook delivery (AGENTS.md §5).
  The constraint plus a transaction is what closes it.
- Every lifecycle enum matches PRD §7.2/§9 exactly, including `checked_in` on
  `Registration.status`. No invented enum values.
  *If a behaviour needs a state the enums do not contain, that is a stop
  condition — see rule 03 and the `requires_reconciliation` note there.*
- **One authorised non-§7.2 column:** `Payment.requires_reconciliation`
  (`NOT NULL DEFAULT false`). Added by product-owner decision 2026-09-26 to give
  the state PRD §8.5/§11/§15 require a home, without inventing an enum value or
  an entity. See rule 03 R-1. It is a flag on `Payment`; it never appears in
  `Payment.status`.

## Timestamps

- `created_at` / `updated_at` on every entity that has them in PRD §7.2 — do not
  omit them because an entity "feels" append-only.
- `Check-in.checked_in_at` (the business event time) and `created_at` (row
  insertion) are distinct; do not conflate them.
- Timezone-aware timestamps for `Event.starts_at` / `ends_at`.
- **All timestamp columns are `timestamptz(3)`** (product-owner decision
  2026-09-26). PRD §7.2 only marks `Event.starts_at`/`ends_at` as tz-aware;
  applying it uniformly avoids a mix of naive and aware values that silently
  disagree when compared. Store UTC; convert at the edge.
- Primary keys are **database-generated** (`gen_random_uuid()`), never
  client-supplied, so a raw SQL writer cannot choose an id.
- `updated_at` is application-maintained, not trigger-maintained. It defaults to
  `now()` so it can never be null.
- DB defaults appear **only** where PRD §7.2 states one (`Event.status` `draft`,
  the two `TicketType` counters `0`, `CheckIn.is_override` `false`,
  `Payment.requires_reconciliation` `false`). Lifecycle statuses deliberately
  have **no** default: the PRD annotates defaults where it wants them, so the
  application must supply them explicitly.
- **The connection string MUST pin the session time zone to UTC**
  (`?options=-c%20timezone%3DUTC`, see `.env.example`). "Store UTC; convert at
  the edge" above is not achievable by convention alone — it has to be enforced
  on the connection.
  - Prisma's write path sends the UTC wall clock as a *naive* timestamp, and
    PostgreSQL then reinterprets it in the **session** zone. On a host whose
    PostgreSQL zone was `Africa/Lagos` (UTC+1) every `timestamptz` the
    application wrote was stored **one hour early**. Found 2026-09-26.
  - The failure is invisible from the ORM because Prisma's *read* path
    reinterprets the server's text the same way, so write→read is symmetric: a
    stored 17:00Z came back as 18:00Z and every Prisma-level round-trip test
    passed. Only an independent client can see the truth.
  - Therefore any test that asserts a stored instant MUST read it back with a
    driver that is not Prisma, and MUST pin `current_setting('TimeZone')` to
    `UTC`. `tests/events.db.test.ts` is the reference implementation; it is
    verified to fail when the option is removed.
  - The same applies to raw SQL (migrations, `scripts/verify-db-constraints.mjs`)
    and to anything reading `now()` or comparing columns: a session in local time
    can shift `timestamptz` comparisons at the boundaries.

## Soft delete

- `Event.deleted_at` is the only soft-delete field in the schema.
- **Never hard-delete an Event once any `Payment` exists against it** (PRD §14).
  The audit trail outranks the deletion request.
- Public lookups by slug must exclude soft-deleted events.
- Do not add soft-delete columns to other entities, and do not hard-delete
  AttendeeRequests or their resolutions (PRD §14: retained, never deleted).

## Deliberate denormalisation

PRD §7.4 authorises exactly two things. Both are deliberate; neither may be
"cleaned up":

1. **`Registration.status` caches `confirmed`/`checked_in`.** The Check-in table
   stays the source of truth for *when* and *by whom*. The cached value must be
   written **in the same transaction** as any Check-in insert, or the projection
   drifts. Do not add further cached columns (e.g. a `check_in_count` on
   Registration) to "help" the dashboard — compute those in the query.
2. **Ticket evidence does not snapshot event details** (BR-6). Evidence reads
   **live** event name/date/venue; only `unique_reference` and ticket tier are
   fixed at issuance. Do not add snapshot columns "for historical accuracy" —
   that reintroduces the divergence problem BR-6 exists to avoid.

## Indexes

Exactly as PRD §7.2, each tied to a query that needs it:

| Index | Serves |
|---|---|
| `Event (organiser_id, status)` | organiser event list, dashboard scoping |
| `ProgrammeItem (event_id, sort_order)` | ordered programme |
| `TicketType (event_id)` | tier lookup + availability |
| `Registration (event_id, attendee_name)` | event-scoped staff search (FR-18 p95 < 500ms) |
| `Registration (event_id, status)` | dashboard aggregation, check-in eligibility |
| `Payment (registration_id)` | payment-attempt history (FR-26) |
| `Check-in (registration_id, checked_in_at DESC)` | latest check-in |
| `Payment (registration_id) WHERE status = 'success'` | **integrity, not speed** — enforces "at most one successful attempt" (AGENTS.md §5) |

Two indexes exist that PRD §7.2 does not list. Both were added by product-owner
decision 2026-09-26 and both are justified:

- **`payments_one_success_per_registration_idx`** — a partial UNIQUE index that
  makes "only one attempt may reach `success`" a *rejected database write*
  rather than an application convention. It is filtered on `status`, so failed
  and pending attempts stay unconstrained. This is an integrity constraint that
  happens to be implemented as an index, not a performance index.
- **`staff_tokens_token_hash_key`** — `UNIQUE(token_hash)`. The column stores
  only a hash, so without uniqueness the staff-auth lookup key is ambiguous and
  a hash collision could authenticate the wrong token.

Adding an index requires naming the query it serves. Verify with a real query
plan against realistic volume before assuming an index is sufficient (AGENTS.md
§15) — and do not add indexes speculatively. Constraint-enforcing indexes are the
one exception: they are justified by the invariant they enforce, which must be
named instead.

`Payment.requires_reconciliation` (rule 03 R-1) is deliberately **absent** from
this table: PRD §7.2 does not list an index for it. It stays unindexed until an
organiser reconciliation-queue query is specified, at which point the index
must be added here with that query named.

**`event_edit_logs_event_id_changed_at_idx`** is the one index added without a
PRD line, and it is named for the query it serves: reading one event's audit
history in reverse chronological order. It is `(event_id, changed_at DESC)`
because that ordering is the reason to read the table at all. Note the honest
limit — **no route currently reads the log** (rule 03 R-3), so this index has no
live caller yet; it is justified by the retrieval shape the entity exists to
serve, and it should be revisited if a read route is never approved.

## Schema representation decisions (product-owner, 2026-09-26)

Four places where PRD §7.2 cannot be implemented literally. Each is recorded
here so the divergence is never mistaken for drift.

1. **`Check-in.checked_in_by` is split into two nullable FKs** —
   `organiser_id` and `staff_token_id` — with a CHECK constraint requiring
   **exactly one** to be non-null. §7.2 specifies a single field described as
   "FK → StaffToken or Organiser", and Postgres has no polymorphic foreign key.
   A bare UUID column with no FK would have discarded the referential integrity
   AGENTS.md §5 requires, so the two-column form is the narrowest faithful
   representation. **The business meaning is unchanged**: a check-in is
   performed by either an organiser or an event-scoped staff token. Both FKs
   `RESTRICT` on delete, so a token or organiser that appears in the audit log
   can never be removed out from under it.
2. **`ProgrammeItem.time` is a nullable `timestamptz(3)`** — the resolution of
   §7.2's ambiguous "timestamp or string" *type*. **Nullability is a recorded
   divergence**: §7.2 L198 marks `time` Required = yes, and the product owner
   decided on 2026-09-26 (decision 6) that a programme line may be ordered by
   `sort_order` alone, with no clock time — "doors open" and "interval" entries
   genuinely have none. So the column is nullable, the `POST`/`PATCH` validators
   accept an explicit `null`, and the omission-vs-`null` distinction is
   preserved. Reported for §7.2 to be corrected; not silently absorbed. This is a
   *nullability* decision only — no scheduling behaviour, duration, or ordering
   semantics beyond the existing `sort_order` are implied.
3. **`TicketType.event_id` is `CASCADE`, not `RESTRICT`.** §7.2 says "RESTRICT
   on delete if Registrations exist" — a *conditional* action. A plain
   `RESTRICT` would block deleting any event that still had a tier, including
   a registration-free one, which is not what §7.2 says. `CASCADE` plus
   `Registration.ticket_type_id → RESTRICT` reproduces the documented semantics
   exactly: deleting an event cascades to its tiers and is blocked precisely
   when a registration still references one.
4. **`EventEditLog` is a new entity.** PRD §7.2 tabulates no audit/edit-log table
   (product-owner decision R-3 in rule 03). It is a first-class table, not a JSON
   column bolted onto `Event` — a log must be appendable without rewriting the
   row it describes, and `Event.updated_at` records *when* only, never *what*, so
   it cannot answer BR-6's "why did this change".
   - `changes JSONB NOT NULL` with `CHECK (jsonb_typeof(changes) = 'object' AND
     changes <> '{}')`. A row recording zero changed fields answers no question,
     and "log only what actually changed" is therefore a **database invariant**,
     not an application convention.
   - `organiser_id` is carried **per row** rather than derived through the event,
     so the log records *who* edited. That is the entire purpose of the trail.
   - Both FKs are `ON DELETE RESTRICT`. Audit evidence is permanent, so neither
     the event nor its author can be deleted out from under it. This is also why
     §14 soft-deletes events rather than removing them.
   - **Append-only**, enforced by `BEFORE UPDATE`/`BEFORE DELETE` triggers exactly
     as Check-in is (§9.4). An audit trail that can be edited is not a trail.
5. **TicketType field limits (decision 5).** §7.2 specifies the *columns* of
   `TicketType` but no value ranges for them, and the skill's "basic operations"
   step is unimplementable without limits — an unbounded `name` is a client bug, an
   unbounded `price_minor_units` is a float, and a `quantity_total` of `0` is a tier
   that satisfies the inventory CHECK and can never sell a seat. The owner settled the
   values on 2026-09-26:

   | Field | Rule | Rationale |
   | --- | --- | --- |
   | `name` | `1..200`, trimmed, non-blank | Mirrors the event `name` limit so both are one rule in the codebase, not two |
   | `description` | `NULL` or `<= 5000` | Mirrors the event `description` limit; optional per the skill |
   | `price_minor_units` | integer `>= 0` | Integer minor units per the `Money` section above; `0` is a legal free tier, so the floor is 0 and not 1 |
   | `currency` | exactly three ASCII letters, stored upper-case | Shape only. **Not** validated against the ISO 4217 registry — a 180-code allow-list is a maintenance liability and the PRD does not require it, so this is recorded as a known limitation rather than silently assumed |
   | `quantity_total` | integer `>= 1` | `0` passes the inventory CHECK but is unsellable, so it is refused |

   Each is a **database CHECK**, not only an application check, for the reason in
   `AGENTS.md` §5: a rule that lives in one layer is a rule the other layer can
   bypass. `PrismaTicketTypeRepository` maps a CHECK rejection back to the
   request field it names, so a client is never told to fix the wrong field.

   `quantity_confirmed` and `quantity_held` have **no** limit of this kind: they are
   not request input at all, and §9.3's transitions guard them.

## Where the constraints actually live

Prisma's schema language cannot express CHECK constraints, filtered (partial)
indexes, or triggers. These guarantees are implemented as raw SQL in
`prisma/migrations/` and are **owned by the migration, not by
`schema.prisma`** — Prisma will not model, migrate, or introspect them, so they
must be carried forward **by hand** into any future migration that touches these
tables. Dropping them silently reintroduces a documented integrity gap.

- TicketType inventory CHECKs (PRD §7.2, BR-3)
- The five TicketType field-limit CHECKs from decision 5 above —
  `ticket_types_name_length_check`, `ticket_types_description_length_check`,
  `ticket_types_price_non_negative_check`, `ticket_types_currency_iso4217_check`,
  `ticket_types_quantity_total_positive_check` — in migration
  `20260926000400_ticket_type_limits`
- `check_ins_exactly_one_actor_check` (decision 1 above)
- `payments_one_success_per_registration_idx` (AGENTS.md §5)
- Forbidden-transition triggers for `Registration.status` (§9.2) and
  `Payment.status` (§9.1)
- Append-only triggers on `check_ins` (§9.4, §14)
- `event_edit_logs_changes_non_empty_check` and the append-only triggers on
  `event_edit_logs` (decision 4 above, PRD §14 L420 / §20 L501)
- `registration_ticket_type_event_guard` — a Registration's `event_id` must
  equal its `TicketType.event_id`. Not in §7.2, but PRD §3/§18 and rule 05 make
  every authorisation decision event-scoped, so a mismatch would let a
  registration be paid under one event and searched under another.

Run `npm run db:verify-constraints` after any migration that touches these
objects. It attempts the invalid writes against real PostgreSQL and records the
rejections — AGENTS.md §17: a passing build does not prove a constraint rejects
the invalid write.

## Migrations

- Be able to name the PRD line each migration satisfies.
- **Never relax a constraint to make seed data or a test easier — fix the data.**
- Constraint behaviour is test evidence, not an assumption: a passing build does
  not prove the constraint rejects the invalid write (AGENTS.md §17). See
  `02` verification in the skills that touch inventory and payments.

## Related

- `03-lifecycle-and-state-machines.md` — which transitions these rows may take
- `04-payment-and-flutterwave-integrity.md` — payment-specific integrity
- `07-concurrency-idempotency-and-check-in.md` — races these constraints close

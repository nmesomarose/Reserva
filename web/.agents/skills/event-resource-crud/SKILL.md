# Skill — Organiser Event Resource CRUD

## Purpose

Create, read, update, and lifecycle-manage **Events** (with their ordered
programme) on behalf of the owning organiser — with ownership enforced,
validation centralised, edits to published facts logged, and soft-delete
protecting the audit trail.

## When to use

- `POST /api/v1/events` (organiser creates an event)
- `GET /api/v1/events/{slug}` (public event page — read-only public projection)
- `GET /api/v1/events` (the caller's own events, paginated)
- `PATCH /api/v1/events/{id}` (partial update **and** status transition)
- `DELETE /api/v1/events/{id}` (soft delete)
- `POST|PATCH|DELETE /api/v1/events/{id}/programme[/{item_id}]` (author the
  ordered programme)
- Deciding whether a change is permitted, what must be logged, and what the
  public DTO exposes

Not for ticket tiers (→ `../ticket-type-and-inventory/SKILL.md`), registration,
or payment.

## Preconditions

- The schema of PRD §7.2 (Event, ProgrammeItem) exists with the specified
  constraints and indexes.
- An organiser authentication mechanism exists. **Satisfied since 2026-09-26** by
  product-owner decision 1: email + password with a server-side session, an
  `httpOnly` `SameSite=Lax` `organiser_session` cookie, and scrypt password
  hashing. The mechanism PRD §19 left open is no longer open. Organiser routes
  resolve the cookie through `src/server/auth/organiser-context.ts` and fail
  closed with `403 unauthenticated`. Accounts are provisioned out of band with
  `npm run db:create-organiser -- <email>`; there is deliberately no
  self-registration endpoint.
- The centralised validation layer exists (AGENTS.md §4).
- `Event.slug` generation/collision strategy decided. **Satisfied since
  2026-09-26** by decision 3: derive from the name, then `slug-2`, `slug-3`, … in
  order, then a short random token; 200-character maximum with suffix headroom
  reserved, so no truncation can make two candidates identical. A normal collision
  is a suffix, not a `409`.
- The organiser-edit log mechanism exists. **Satisfied since 2026-09-26** by the
  `EventEditLog` table and product-owner decision R-3 in
  `.agents/rules/03-lifecycle-and-state-machines.md`, which resolved both the
  §14/§20 priority conflict and the missing entity.

## Source requirements

PRD §5.1 (FR-1…FR-4), §7.2 (Event, ProgrammeItem), §7.3, §7.4, §12 (event
rows), §13 (public-safe DTO), §14 (auditability, soft delete), §15 (status
codes), §20 (Must-Have: event creation with ordered programme; edit logging).
AGENTS.md §2, §4, §5, §7, §8, §19.

## Procedure

1. **Resolve the caller server-side.** Load the authenticated organiser. Never
   accept an organiser id, role, or ownership claim from the request.
2. **Create (organiser).** Validate `name`, `description`, `starts_at`, `ends_at`
   (tz-aware), `venue` through the centralised validation layer. `description` is
   **optional** and may be `null` (decision 4, a recorded divergence from §7.2's
   Required = yes); `name` is 1–200, `description` ≤ 5000, `venue` 1–300, and
   `ends_at > starts_at`, each also a database CHECK. Derive `organiser_id` from
   the session, not the body. Generate `slug` per decision 3. `status` is always
   `draft` and is not a request field. Return the organiser-facing Event DTO.
3. **Programme items.** Create with an explicit `sort_order` integer (FR-2 —
   ordering is stored, never inferred). `event_id` FK is `CASCADE`; index
   `(event_id, sort_order)` serves the ordered read. Authored through
   `POST /api/v1/events/{id}/programme` (R-3, previously a gap), with
   `PATCH`/`DELETE` on `/programme/{item_id}`. A `ProgrammeItem` that does not
   belong to the event in the path is `404`.
4. **Read publicly.** `GET /api/v1/events/{slug}` is unauthenticated and returns
   **only** `published`, non-soft-deleted events — `404` otherwise. Assemble the
   public-safe projection: event + `TicketTypeSummaryDTO[]`
   (`{ name, price_minor_units, currency, available }`) + ordered programme.
   Never serialize the raw TicketType row here (rule 06).
5. **Update (organiser, owner only).** Confirm `event.organiser_id ==
   current_user.id` **server-side, every request** (IDOR): unknown id → `404`,
   someone else's id → `403`. Apply the field change; allow edits both pre- and
   post-publication (FR-4). A `PATCH` that changes nothing writes nothing.
6. **Log edits to published facts.** When a `published` event is edited, append an
   `EventEditLog` row in the **same transaction** as the update, recording who,
   what (`{"from": …, "to": …}` per field) and when. The gate is the status
   *before* the request. Notification *on top of* the log is Supporting — do not
   build it (PRD §20).
7. **Status transitions.** The three *values* are fixed by FR-1 (L100) and §7.2
   (L185, `default: draft`): `draft`, `published`, `closed`. **The legal
   transitions between them are defined nowhere** — §9 has no Event lifecycle. The
   table used here is a product-owner decision, not a reading of §9 (R-3):
   `draft→published`, `draft→closed`, `published→closed`, `closed` terminal, no
   unpublishing and no reopening. Publishing is what makes the event publicly
   visible; a closed/draft event is `404` on the public route.
8. **Delete.** Set `deleted_at` — **never hard-delete** (PRD §14, rule 02). Public
   lookup must exclude soft-deleted events. The delete is `204` with no body, and
   `deleted_at` is not echoed in any response.

## Integrity checks

- Ownership verified server-side on **every** organiser-scoped request — not
  once at login, not from a client-supplied `event_id` (rule 05).
- `slug` uniqueness enforced by the DB constraint, not an application probe.
- `sort_order` is an explicit stored integer; no implicit ordering by
  `created_at`.
- Edits to published date/venue are logged with what-changed + when.
- Soft delete only; hard delete blocked at the database level by `RESTRICT` FKs
  (including from the audit log, which must outlive its author).
- Public DTO leaks **no** internal counters, ids-as-internal, or provider data.
- No change here may add a field/endpoint/entity the PRD does not define
  (rule 01).

## Verification

Live and passing (318 unit/integration tests plus 69 database constraint checks,
2026-09-26): public `GET` coverage including the DTO field exclusions; the
`draft`/`closed` `404` case; ownership (`403`) vs unknown id (`404`); lifecycle
transitions and their `409`; the published-edit log and its append-only,
non-empty-`changes` database invariants; soft delete; the programme routes; and
the rule-06 pagination envelope. The DB-level `UNIQUE(slug)` rejection is still
verified directly.

Authentication is no longer a stub, so the end-to-end HTTP paths are proven
against a real session as well: `tests/api.v1.auth.test.ts` covers the login and
logout routes (including that the token appears only in `Set-Cookie`), and
`tests/auth.db.test.ts` proves against PostgreSQL that a session row stores a
SHA-256 hash rather than the token, that expiry and the unique token index hold,
and that deleting an organiser cascades its sessions away.

Transactional guarantees are proven against a real database rather than asserted:
`tests/events.transactions.db.test.ts` injects an audit-insert failure inside a
genuine Prisma transaction and asserts the event row is unchanged and no log row
survives.

- Create → organiser sees it in their event list; another organiser cannot
  (IDOR test).
- Public `GET` returns the public-safe DTO and **excludes** `quantity_confirmed`
  / `quantity_held` / `quantity_total`.
- `draft` and `closed` events return `404` publicly; `published` returns `200`.
- Editing a published event's venue/date produces a log entry with the diff and
  timestamp; editing a `draft` event produces none.
- Hard-deleting an event is rejected at the database level (`RESTRICT`); soft
  delete succeeds and hides it from the public route.
- `UNIQUE(slug)` rejects a duplicate slug at the DB level.

## Stop conditions

- A change would require a field, endpoint, or status the PRD §5.1/§7.2/§12 does
  not define → API/scope change; stop and flag. The Event routes in R-3, plus
  `POST /api/v1/auth/login` and `POST /api/v1/auth/logout`, were approved by the
  owner; any route *beyond* that set is still a stop condition.
- ~~Creation-time `status` is undecided (gap 8)~~ — **resolved 2026-09-26 by
  decision 2**: events are always created `draft`, server-side, and `status` is
  not a request field. Making it settable on `POST` is now the stop condition.

## Known PRD gaps (found 2026-09-26, Event CRUD slice)

Eight gaps were found. **All eight were resolved by the product owner on
2026-09-26** (decision R-3 in `.agents/rules/03-lifecycle-and-state-machines.md`,
plus decisions 1, 2, 3 and 4). They are recorded here rather than deleted, so the
reasoning is not re-litigated.

1. ~~**No update/publish/close endpoint exists.**~~ **RESOLVED (R-3).** `PATCH`,
   `DELETE`, and `GET /api/v1/events` were approved; `status` is carried on the
   `PATCH` rather than by separate publish/close routes. Status is no longer
   stuck at `draft`.
2. ~~**No edit-log entity exists, and its priority contradicts itself.**~~
   **RESOLVED (R-3).** The log is Must-Have per §20, and the missing entity is
   `EventEditLog` (id, event_id, organiser_id, changed_at, changes JSONB) with
   append-only triggers and `RESTRICT` FKs. There is deliberately no
   `TicketTypeEditLog`; §14's wording is not read into its other entities. The
   `Payment.raw_provider_payload` column remains the wrong tool, as analysed.
3. ~~**No organiser authentication mechanism.**~~ **RESOLVED (decision 1).**
   Email + password against `src/server/auth/`, opaque server-side sessions,
   scrypt hashes, SHA-256 session-token storage, and an `httpOnly`
   `SameSite=Lax` `organiser_session` cookie (`Secure` outside development and
   test). `organiser-context.ts` resolves the cookie and fails closed with
   `403 unauthenticated` — not the `501` it used to return, and not `401`, which
   §15 does not define. `POST /api/v1/auth/login` and `POST /api/v1/auth/logout`
   are a recorded contract addition: §12 does not enumerate them, but the
   mechanism cannot exist without them. **No registration endpoint** was approved;
   provision accounts with `npm run db:create-organiser -- <email>`.
   Email lookup is case-insensitive, but a plain `ILIKE` cannot use the
   exact-case unique B-tree, so it is a sequential scan by design — a deliberate
   follow-up, not an oversight.
4. ~~**§11 specifies no event-field validation rules.**~~ **RESOLVED (decision
   4).** The limits are now product decisions, not placeholders: `name` 1–200,
   `description` optional/nullable and ≤ 5000, `venue` 1–300, `ends_at >
   starts_at`, and timestamps that require an explicit UTC offset. Each is
   enforced in `src/server/validation/validation.ts` *and* as a database CHECK,
   so an invalid row is rejected even if the validator is bypassed. Making
   `description` optional is a recorded divergence from §7.2's Required = yes.
5. ~~**No programme-authoring endpoint exists.**~~ **RESOLVED (R-3).** Add, patch
   and delete were approved under `/api/v1/events/{id}/programme`.
6. ~~**No organiser event-list endpoint exists.**~~ **RESOLVED (R-3).**
   `GET /api/v1/events` was approved, serving the `(organiser_id, status)` index
   that §7.2 L190 already specifies.
7. ~~**No Event lifecycle exists.**~~ **RESOLVED (R-3).** Forward-only:
   `draft→published`, `draft→closed`, `published→closed`, `closed` terminal.
8. ~~**`status` at creation time is ambiguous.**~~ **RESOLVED (decision 2).**
   FR-1 (L100) lists `status` among the fields an event is created *with*, while
   §7.2 L185 specifies `default: draft`. The owner decided events are always
   created `draft`, set server-side, and `status` is not a request field — so
   FR-1 is read as listing the resulting field, not an input. Accepting
   `status` on `POST` is now the stop condition.

`Event.slug` is likewise settled, by decision 3 rather than a gap: derive from
the name, then `slug-2`, `slug-3`, …, then a short random token, with a
200-character maximum that reserves suffix headroom. A normal collision is
therefore a suffix and not an error — which is why step 2 no longer suggests a
`409`. Implemented in `src/domain/events/slug.ts`. If the owner later changes the
strategy, change that one file and this section together.

Decided but *not* built, and therefore not to be assumed present: an audit-log
**read** route and a draft-programme read route. Neither was approved, and a
service method is not a public surface.

## Required output

Report: what changed (plain terms); the PRD requirement(s) satisfied; files
changed; how it was verified (which test/check); the DTO fields exposed; any
`[VERIFY]`/open item relied on; and an explicit **done / blocked** status for each
step of the Procedure above.

Steps 5–8 are implemented and their HTTP happy paths are now genuinely exercised
end to end against a real session, so they may be reported as done — but say
*how*: the edit log is write-only, `deleted_at` is audited but not exposed, the
event mutation and its audit append share one transaction, and all of it is
backed by database-level guarantees. No `[VERIFY]` items remain in this skill;
the eight gaps above are closed.

# Skill — List Endpoints: Pagination, Filtering, Search

## Purpose

Build any **list** endpoint (search, requests, organiser event lists, tier lists)
so it follows the one pagination envelope, respects the page-size cap and minimum
query length, filters/sorts deterministically, returns an honest empty result,
and is backed by an index that actually serves the query.

## When to use

- `GET /api/v1/events/{id}/registrations/search` (staff search)
- `GET /api/v1/events/{id}/requests` (status filter, paginated)
- Any organiser event list (`(organiser_id, status)` index)
- Any new list endpoint, or a change to an existing one's paging/filter/sort
  behaviour

The public event page (`GET /events/{slug}`) is **not** a paginated list — it is a
single resource projection (see `../event-resource-crud/SKILL.md`).

## Preconditions

- The endpoint exists in the PRD §12 table with a fixed path and auth context
  (rule 06). A new list endpoint is a contract change — flag first.
- The auth/ownership model is settled (rule 05): staff lists are scoped to the
  token's `event_id`; organiser lists to owned events.
- The relevant PRD §7.2 indexes exist and you have looked at the query plan
  (rule 02, AGENTS.md §15).
- The DTO allow-list for the role is defined (rule 08) — what fields this role may
  see.

## Source requirements

PRD §12 (endpoint table + pagination/filtering contract), §13 (over-fetching /
public-safe DTO), §5.6 (FR-17/FR-18 search + p95 < 500ms), §11 (search min 2
chars; `page_size ≤ 50`), §15 (empty list = `200`). AGENTS.md §6, §8, §13, §15.

## Procedure

1. **Fix the contract.** Use the exact path and auth context from PRD §12. This
   is a read-only list; no state changes, no side effects.
2. **Authorise and scope first.** Resolve the caller's scope server-side (staff →
   the token's `event_id`; organiser → owned events) and apply it as a **filter in
   the query**, never as a post-filter in application code and never from a
   client-supplied `event_id` alone (rule 05).
3. **Parse and validate pagination.** `page` default `1`; `page_size` default
   `20`, **max `50`** (hard cap). Reject or clamp `page_size > 50` — pick one and
   be consistent. Reject non-positive/non-numeric `page`/`page_size` rather than
   silently defaulting. Enforce the cap **server-side**; a client-side cap is
   cosmetic.
4. **Search query validation (staff search).** `query` must be **≥ 2 characters**;
   shorter → `400` with field-level detail (PRD §11). Search by attendee **name**
   (primary) and **email/phone** (secondary/fallback) (FR-17).
5. **Filtering.** Apply the endpoint's documented filter (e.g. `status` for
   requests) and the event scope in the same query. `total` is the count of the
   **filtered** set, matching the returned `data` page — not the unfiltered table.
6. **Sorting.** Use a **deterministic, indexed** sort so pagination is stable
   across pages (ties broken by a unique column, e.g. `id` or the indexed
   timestamp). Non-deterministic ordering causes rows to be skipped or repeated
   across pages. Use the PRD-specified index where one exists; document the sort
   you chose.
7. **Assemble the envelope.** Exactly `{ data: [...], page, page_size, total }` —
   the same shape on every list endpoint. No cursor/offset-limit variants, no
   per-endpoint envelope differences (rule 06).
8. **Project the role's DTO.** Serialize only the fields this role may see
   (allow-list). Mask sensitive contact fields where the PRD requires it
   (e.g. masked email/phone in staff disambiguation, PRD §4.4). Never include
   internal counters, provider payloads, or other events' rows.
9. **Empty result.** Return **`200`** with `data: []` and `total: 0` — never
   `404` (PRD §10, §15). The UI renders an explicit empty state, not a blank
   screen (AGENTS.md §11.2).
10. **Verify performance against the real query plan.** Confirm the specified
    index serves the scoped query (e.g. `(event_id, attendee_name)` for staff
    search). For staff search, the target is **p95 < 500ms** at expected
    single-event scale (PRD §17). Measure; don't assume (AGENTS.md §15).

## Integrity checks

- Path, method, and auth context match PRD §12 **exactly** (rule 06).
- Envelope is `{ data, page, page_size, total }`; `page_size` default 20 / max 50
  enforced server-side.
- Scope filter is applied **in the query** from the server-resolved scope, never
  from a client-supplied `event_id` (IDOR / cross-event leakage — rules 05, 08).
- `query` ≥ 2 characters for search; shorter rejected.
- `total` equals the filtered result count, consistent with the returned page.
- Sort is deterministic and index-backed; no skipped/duplicated rows across pages.
- Empty result → `200` + `data: []`, never `404`.
- Response includes only role-allowed, appropriately masked fields; no internal
  counters, no provider payloads, no other events' data.
- A deterministic total-count strategy is in place and does not degrade the p95
  target (state the approach if the count is expensive).

## Verification

- Page 1 and page 2 of a result set partition the rows with **no overlap and no
  gaps** (deterministic sort).
- `page_size` default is 20; `page_size = 50` is allowed; `page_size = 51` is
  rejected/clamped consistently; `page = 0` / negative / non-numeric are rejected.
- A `query` of 1 character → `400` with field detail; a valid query returns
  name-primary and email/phone-fallback matches.
- A no-match search → `200`, `data: []`, `total: 0` (explicitly **not** `404`).
- `status` filter on requests returns only that status; `total` reflects it.
- A staff token for event A sees **only** event A's rows; a disagreeing
  client `event_id` is rejected (IDOR).
- Disambiguation results show **masked** email/phone.
- Staff search p95 < 500ms verified with a query plan against realistic volume
  (PRD §17, AGENTS.md §15).

## Stop conditions

- A new list endpoint, filter, sort key, or envelope variant is requested that
  PRD §12 does not specify → contract change; flag, do not add.
- Cursor pagination or a per-endpoint envelope is proposed → deviates from the
  stated contract; stop and raise.
- The p95 < 500ms target cannot be met with the PRD-specified indexes → do **not**
  silently add caching/replicas/scale infrastructure (AGENTS.md §15); report the
  measured plan and the gap as a product/architecture decision.
- Fuzzy/phonetic/ranked search is requested → out of scope; flag.

## Required output

Report: what changed; the PRD requirements satisfied (the §12 row, FR-17/18,
§11, §15); files changed; the pagination/filter/sort decisions made; how
determinism, empty-result, IDOR scoping, and the p95 target were verified (with
the query plan); and any contract deviation flagged for approval.

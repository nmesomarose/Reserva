# Rule 06 — API Contract & Validation

**Axis: the shape of the HTTP surface** — paths, auth context, DTOs, status
codes, pagination, validation. Rule 05 owns *who*; this rule owns *what the
contract looks like*.

## The contract is literal

All routes live under **`/api/v1/...`**, exactly as enumerated in PRD §12.

- **Do not rename, restructure, nest, pluralise differently, or "improve" a
  path** (AGENTS.md §8). There are no unversioned aliases, no `/api/v2`, no
  RESTful renaming passes.
- **Do not add an endpoint** that is not in the PRD §12 table. Every new route is
  a contract change requiring explicit flagging first.
- The table also fixes each endpoint's **auth context** (Public / Organiser /
  Staff (event-scoped) / System / Flutterwave signature-verified), its **key
  request fields**, its **key response**, and its **status/error semantics**.
  All four are part of the contract, not suggestions.

If a genuine contract change is needed, state **what is changing and why the
PRD's version does not work** *before* writing it. Never let it happen silently
inside a "cleanup" (AGENTS.md §8).

## Request/response DTO discipline

- Responses are **hand-defined DTOs**, not serialized ORM rows. A raw entity
  carries internal fields that no client needs and some it must not have.
- **Public-safe `TicketTypeSummaryDTO`** = `{ name, price_minor_units, currency,
  available }` for the public event page. It **excludes** `quantity_confirmed`,
  `quantity_held`, `quantity_total`, ids, and timestamps (PRD §13 over-fetching
  decision). Sold-out is expressed via the `available` flag, not by leaking the
  counters.
- Never return, to any role: password hashes, `StaffToken.token_hash`, provider
  secrets, or `Payment.raw_provider_payload` in full (rule 08).
- **Never accept a client-supplied amount/price/total** on any request
  (rule 04).
- Do not add response fields "just in case" — a new field is a contract change,
  and a field that leaks an internal counter is a privacy regression.
- Do not return `404`-shaped bodies for authorisation failures or vice versa in a
  way that changes which information the response reveals.

## Status-code semantics (PRD §15)

| Code | Meaning | Required cases |
|---|---|---|
| `2xx` | success | Empty search/list results are **`200`**, never `404` |
| `400` | validation failure | Field-level detail in the response |
| `403` | access-control failure | Includes evidence-lookup reference/email mismatch — **never `404`** |
| `404` | genuinely does not exist | e.g. unknown or unpublished event slug |
| `409` | state conflict | Sold-out/unavailable tier; check-in against a non-eligible registration; double check-in without `override` |
| `5xx` | unexpected/provider failure | Payment-adjacent endpoints surface `pending` / reconciliation state instead of guessing |

Two that are easy to get wrong and are explicitly called out:

- **Empty search result → `200`** with an empty result set (PRD §10, §12).
- **Evidence mismatch → `403`, not `404`**, specifically to avoid confirming
  which references exist (PRD §15, §18).

`409` is the mechanism behind FR-21: a non-confirmed registration must be
rejected **by the check-in endpoint itself**, because a hidden button is not a
security boundary (PRD §5.7, AGENTS.md §7).

## Pagination contract (PRD §12)

Applies to **every** list endpoint.

- Envelope: `{ data: [...], page, page_size, total }` — same shape everywhere.
- `page` default `1`; `page_size` default `20`, **max `50`**, hard cap.
- `page_size > 50` is rejected or clamped — state which; be consistent.
- `page_size` must be a positive integer; reject `0`/negative/non-numeric
  rather than silently defaulting.
- Search additionally supports `query`; requests additionally support `status`.
- `total` is the count of the **filtered** result set, not the whole table.
- Do not invent cursor pagination, offset/limit pairs, or a different envelope
  for one endpoint. If a list genuinely cannot paginate, that is a contract
  change to flag.

## Validation

Server-side validation is **authoritative**; client-side validation is a UX
layer on top, never a replacement (AGENTS.md §13).

- **Centralised** — one validation layer every mutating endpoint runs through,
  not ad-hoc per-endpoint checks (AGENTS.md §4).
- Enforce exactly PRD §11:

| Input | Rule |
|---|---|
| Attendee name | required, 1–120 characters |
| Email | required, valid format |
| Phone | **required** |
| Ticket tier | must reference an existing, published tier with `available > 0` at submission — **and re-validated at confirmation time** (availability changes between the two) |
| Search query | minimum 2 characters |
| Payment amount | `verified_amount_minor_units == expected_amount_minor_units`; mismatch blocks confirmation and flags for manual review, never auto-accepts |
| Idempotency keys | required, client-generated UUID, unique per submission |

- Authorization and transition legality are **validation too** (AGENTS.md §13) —
  they run in the same layer, not as an afterthought.
- `400` responses carry field-level detail so the client can attribute the
  failure.

## Idempotency keys in the contract

- `idempotency_key` is a **required** request field on registration creation
  (FR-10a) and attendee-request submission (FR-23a).
- Replaying the same key returns **the original result**, not a new row and not
  a `409` (PRD §12).
- The guarantee is enforced by `UNIQUE` + transaction, not a read-then-write
  check (rule 02, rule 07).
- A replay of a key with a **different request body** is an ambiguous case; do
  not silently return the old result for a materially different request — treat
  it as a conflict and say so.

## Errors

- One consistent error shape across all endpoints; field-level detail for `400`.
- Error responses never include stack traces, SQL, provider payloads, or internal
  identifiers not needed by the client.
- A `5xx` on a payment-adjacent path must not leave the attendee guessing
  success or failure (PRD §15).

## Related

- `05-authentication-authorization-and-event-scope.md` — the auth context column
- `07-concurrency-idempotency-and-check-in.md` — replay and race behaviour
- `../skills/api-list-pagination-search/SKILL.md` — building list endpoints

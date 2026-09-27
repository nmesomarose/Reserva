# Rule 01 — Source of Truth & Scope Discipline

**Axis: what you are allowed to build, and what wins when sources disagree.**
Sister rules own *how* a thing is enforced (02 data, 03 lifecycle, 06 API, 08 security).

Throughout `.agents/`, `PRD` = `../docx/event-ticketing-platform-prd-v2.md` and
`AGENTS.md` = `../docx/AGENTS.md`. Read the cited section; never reason from a
paraphrase of it.

## Precedence

1. **PRD v2** — product behaviour, scope, business rules, entities, lifecycles, API contract, security, acceptance criteria.
2. **`AGENTS.md`** — engineering conventions and implementation discipline.
3. **`.agents/rules/`** — this file and its siblings: focused enforcement detail.
4. **`.agents/skills/`** — reusable procedures for recurring implementation work.
5. **Existing code patterns** — once the app exists, extend what is already there; never add a second competing convention alongside it.
6. **Generated design tokens** (`../dist/tokens.css`) — the only visual-value source. Never a competing value.

Implementation convenience never outranks 1–4. If following a lower source would
require breaking a higher one, that is a **conflict**, not a trade-off.

## Mandatory: implementation traces to a requirement

Before writing code for a payment-, check-in-, or authorization-adjacent path,
be able to state in one sentence: *which PRD requirement this satisfies, and
which failure mode from PRD §10 it must not reintroduce.* If you cannot, you are
writing speculative code — stop.

Every completed unit of work reports (AGENTS.md §18): what changed, the PRD
requirement it satisfies, files changed, how it was verified, and any `[VERIFY]`
or open item it depends on. Partial coverage is reported as partial.

## Scope buckets are hard boundaries

Build **only** PRD §20 **Must-Have**.

| Bucket | Examples | Rule |
|---|---|---|
| Must-Have | Event/tier CRUD, registration + Flutterwave payment, idempotency keys, server-side verification + atomic confirmation, organiser auth + event-scoped staff tokens, two-factor evidence retrieval, event-scoped search, append-only check-in, attendee requests, organiser dashboard, audit logging | Build. |
| Supporting | Attendee notification on event-detail change; reference-based fast-lookup at check-in | Do **not** build unprompted. |
| Future Possibilities | Multi-ticket checkout, refund *processing*, ticket transfer, multi-organiser teams, platform admin, QR/scanner check-in, SMS, cross-event Attendee identity | Never. |
| Explicitly Out-of-Scope | Cash payments, event marketplace/discovery, seat mapping, loyalty/social | Never. |

Specific traps, because they look small:

- `cancelled` / `refunded` **states must exist** (BR-7) but no refund processing
  workflow may be built. The state is not the feature.
- `checked_in` exists on `Registration.status` as a cached projection of the
  Check-in log — that is not permission to add a mutable check-in status field.
- Adding an endpoint, entity, enum value, table, or library is a scope change
  until proven otherwise.
- No speculative abstractions, no new library without stating why the existing
  stack cannot do the job, no caching/replica/scale infrastructure the PRD's
  numeric targets (PRD §17) do not require.

Being mid-way through a relevant file is not a reason to build ahead
(AGENTS.md §3). "While I'm here" is out of scope.

## Conflicts: stop, do not choose

If the PRD, `AGENTS.md`, and a rule/skill here disagree — or if code already in
the repo contradicts the PRD — **stop and surface it**. Do not pick a side, do not
layer a workaround on top of an unresolved inconsistency (AGENTS.md §19).

Report the conflict with: both statements quoted, which is higher in precedence,
what the behavioural difference is, and which options exist. Then wait.

Known open items that are *already* flagged and must not be silently resolved:

- Application stack (AGENTS.md §21.1) — a strong default is suggested, not decided.
- Organiser auth mechanism and staff-token transport (PRD §19, AGENTS.md §21.4–5).
- All Flutterwave mechanics (PRD §19, AGENTS.md §21.6).

## `[VERIFY]` items

`[VERIFY]` means *unconfirmed against an authoritative external source* — in this
project, official Flutterwave documentation, or the product owner for PRD §21
items.

- Never invent the value behind a `[VERIFY]`. Do not code a plausible-looking
  endpoint, payload shape, signature scheme, or field name and move on.
- Never weaken or skip a requirement because its `[VERIFY]` detail is unknown
  (e.g. signature verification stays mandatory even before the exact scheme is
  known).
- Resolve the `[VERIFY]` against the source, then state what was confirmed, from
  where, and on what date. If the PRD's assumption turns out to be wrong, flag it
  — do not quietly code around it.

Design decisions that would **materially change product behaviour** — how a
lifecycle transition is gated, what a public API returns, which DTO fields are
exposed — are the same class of thing: state the intended decision explicitly and
get confirmation before implementing it, even when the PRD is silent rather than
explicitly open.

## Related

- Data-integrity specifics → `02-domain-model-and-data-integrity.md`
- Transition legality → `03-lifecycle-and-state-machines.md`
- Endpoint/DTO contract → `06-api-contract-and-validation.md`

# `src/domain` — domain / business logic

Framework-agnostic business rules. This is where product behaviour lives, and it
is the **only** layer allowed to decide what a lifecycle transition means or
whether an operation is legal.

## Boundary

- **Depends on:** nothing from `src/app`, `src/ui`, or `src/server`. It may
  define its own types and interfaces for what it needs.
- **Does not:** import Next.js, React, the Prisma client, or any provider SDK.
  A route handler or a UI component must never contain business logic inline
  (`AGENTS.md §4`).
- **Persistence** is reached through interfaces declared here and implemented
  outside, so domain rules stay testable without a database.

## Governing rules

- `.agents/rules/03-lifecycle-and-state-machines.md` — allowed and forbidden
  transitions, guards, transaction boundaries
- `.agents/rules/07-concurrency-idempotency-and-check-in.md` — duplicate and
  concurrent behaviour

## Status

**Event CRUD — implemented (2026-09-26).**

Present: `errors.ts` (error taxonomy, incl. `ForbiddenError` and
`IllegalTransitionError`), `events/event.ts` (domain types, the status
transition table, and the audited-field list), `events/slug.ts`,
`events/event.dto.ts` (public + organiser projections, and the paginated
envelope), `events/event.repository.ts` (persistence port),
`events/event.service.ts` (create, public read, organiser list, update with
status transition, soft delete, and programme add/patch/remove/list),
`events/event-ownership.ts` (the shared organiser ownership guard).

The event lifecycle, the five new organiser routes, and the `EventEditLog` audit
table are **product-owner decision R-3**, not readings of the PRD — see
`.agents/rules/03-lifecycle-and-state-machines.md`. The log is append-only by
database trigger, and both its FKs are `RESTRICT` so audit evidence cannot be
removed with its event or its author.

**Ticket tiers and two-counter inventory — implemented (2026-09-26).**

Present: `tickets/ticket-type.ts` (commands, sparse patch, writable-column set,
derived `availableQuantity`, and the 15-minute hold window),
`tickets/ticket-type.repository.ts` (persistence port, with the required
atomicity of each counter method stated as part of the contract),
`tickets/ticket-type.service.ts` (create, list, patch, delete, and the §9.3
hold/release/confirm transitions), and `tickets/ticket-type.dto.ts` (the
organiser projection).

`TicketTypeRecord` itself lives in `events/event.ts` because the public event
aggregate is what first needed it; moving it would churn the Event slice for no
gain. The organiser projection is separate from the public `TicketTypeSummaryDTO`
on purpose — an organiser must see the counters to know which `quantity_total`
changes are legal, and those counters must never reach an attendee.

The list, patch, and delete routes are **product-owner decision R-4**; only the
create route is PRD §12's own row. Still open, and reported rather than
absorbed:

- **FR-7 per-tier closure is not implemented.** §7.2 gives `TicketType` no status
  column, so a closed tier is not representable without inventing one.
- **The 15-minute expiry sweep is not here.** The window and the release
  operation are; deciding *which* hold is stale belongs to the registration
  slice, which owns the `Registration` row and its transaction.

Still open for the Event slice, and reported rather than absorbed:

- **Auth is unresolved** (PRD §19). Every organiser route resolves an organiser
  context and fails closed with `501`, so the mutation paths are unit-tested
  against a fake repository and a stubbed context, not end to end.
- **Creation-time `status` is ambiguous** (FR-1 vs §7.2). `create` hard-codes
  `draft`; making it settable is still a stop condition.
- **The `slug` collision strategy is unapproved.** The suffixing-then-token
  behaviour in `events/slug.ts` is a placeholder, isolated in that one file.
- **No audit-log read route and no draft-programme read route exist.** Neither was
  approved; a service method is not a public surface.

Event and tier field limits are **not** placeholders: they are product-owner
decisions 4 and 5 in `.agents/rules/02-domain-model-and-data-integrity.md`, and
each is enforced by a database CHECK as well as by the request validator.

See "Known PRD gaps" in `.agents/skills/event-resource-crud/SKILL.md` and
`.agents/skills/ticket-type-and-inventory/SKILL.md`.

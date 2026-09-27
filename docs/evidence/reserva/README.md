# Reserva — Data-model & lifecycle evidence

Visual and traceable evidence for the data model and lifecycle rules, generated from the
canonical `web/prisma/schema.prisma`, `.agents/rules/03`, and real verification output.
No entity, relationship, transition, or constraint here is invented — every item is
traceable to `schema.prisma`, `docx/event-ticketing-platform-prd-v2.md` §7.2/§9, or a real
database rejection / query plan.

| File | What it is | What it proves | Requirement |
| --- | --- | --- | --- |
| `er-diagram.png` (final) · `er-diagram.svg` (vector) · `er-diagram.mmd` (source) | Entity–relationship diagram: all 11 models, key fields/identifiers, 14 relationships, cardinalities, referential actions, and the SQL-only guarantees. | The complete data model matches `schema.prisma` — 11 tables, `1:N` cardinalities, `RESTRICT`/`CASCADE` actions, and the `CHECK`/partial-`UNIQUE`/trigger guarantees Prisma cannot express. | PRD §7.2, §7.3; AGENTS.md §5. |
| `state-machine.png` (final) · `state-machine.svg` (vector) · `state-machine.mmd` (source) | Registration + Payment lifecycle: allowed transitions (solid green), forbidden transitions (dashed red), and the cross-machine link `Payment.success → Registration.confirmed`. | The implemented lifecycles match rule 03: `pending_payment → confirmed → checked_in`, terminal `cancelled/refunded`, `initiated → processing → success/failed/pending`, and the forbidden `cancelled → confirmed`, `cancelled/refunded → checked_in`, `checked_in → pending_payment`, `failed → success`. | PRD §9.1/§9.2, BR-1/BR-4/BR-7; `.agents/rules/03`. |
| `constraint-rejections.md` | Three genuine PostgreSQL rejections (verbatim `23514`/`23505` from the verifier). | Three different mechanisms enforce integrity: a `CHECK` (inventory oversell), a partial `UNIQUE` (one success payment per registration), and a trigger (forbidden transition). | FR-6/FR-10/BR-2/BR-3; AGENTS.md §5 ("enforced, not just documented"). |
| `query-plans.md` | Two real `EXPLAIN (FORMAT JSON)` plans for the heavy queries. | The event-day search is scoped by an index (no `Seq Scan`), and the dashboard aggregate uses an `Index Only Scan` on `(event_id, status)` for both scope and `GROUP BY`. | PRD §17 (search p95, zero-discrepancy dashboard); FR-17/18/25. |

## Verification provenance

- **126/126 database checks pass** — `web/scripts/verify-db-constraints.mjs`
  (`npm run db:verify-constraints`), which also proves 16 `CHECK` constraints and 10
  integrity triggers exist and fire.
- **Search index path is asserted in the committed suite** — `web/tests/staff.db.test.ts`
  ("has an index path for the event scope", runs `EXPLAIN` with `enable_seqscan = off`).
- **Forbidden transitions are exercised end-to-end** — `web/tests/requests.db.test.ts`,
  `web/tests/registrations.db.test.ts`, `web/tests/ticket-types.db.test.ts`, and the
  service suites.
- **Full suite** — `npm test` (38 files, 1,082/1,082 passing).

## Regenerate

The `.svg`/`.png` were produced from the schema and rule 03 by a one-off generator
(not committed). To verify the diagrams still match the schema, check that every model in
`web/prisma/schema.prisma` appears in `er-diagram.mmd`, and that every transition in
`.agents/rules/03` §9.1/§9.2 appears in `state-machine.mmd`. The Mermaid `.mmd` files
render natively on GitHub.

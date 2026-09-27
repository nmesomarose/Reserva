# Database constraint-rejection evidence

Three genuine PostgreSQL rejections captured from the real verification run
(`npm run db:verify-constraints`, 126/126 checks passing). Each shows a different
enforcement mechanism — a `CHECK` constraint, a partial `UNIQUE` index, and a
forbidden-transition trigger — so together they demonstrate that data integrity is a
database guarantee, not just an application check (AGENTS.md §5).

## 1. Inventory oversell — `CHECK` constraint (23514)

An unguarded write that would drive `quantity_confirmed + quantity_held > quantity_total`
is rejected by the database itself:

```
PASS  [reject] 1. quantity_confirmed + quantity_held > quantity_total
        23514 new row for relation "ticket_types" violates check constraint "ticket_types_quantity_within_total_check"
```

- **Mechanism:** `CHECK (quantity_confirmed + quantity_held <= quantity_total)`.
- **Requirement:** BR-3 / FR-6 two-counter availability; the last-unit race cannot
  oversell because the constraint is the backstop behind the atomic conditional update.
- **Also exercised:** negative counters (`ticket_types_quantity_non_negative_check`),
  `quantity_total` reductions below committed stock (case 19a), and the unguarded
  oversell/hold cases 20f/20g.

## 2. Second successful payment — partial `UNIQUE` index (23505)

A second `success` payment for the same registration is rejected, while a further
`failed` attempt is allowed (case 5a):

```
PASS  [reject] 5. SECOND successful Payment for the same Registration
        23505 duplicate key value violates unique constraint "payments_one_success_per_registration_idx"
```

- **Mechanism:** a **partial** unique index (Prisma cannot express it; it lives in the
  SQL migration) enforcing at most one `success` row per registration.
- **Requirement:** FR-10 "one success per registration"; BR-2 — `Payment` is 1:N with
  `Registration`, but only one attempt may reach `success`.

## 3. Forbidden state transition — trigger (23514)

A `cancelled → confirmed` transition is refused by the `registration_status_transition_guard`
trigger, not merely by the service layer:

```
PASS  [reject] 7a. Registration cancelled -> confirmed (forbidden)
        23514 forbidden Registration.status transition cancelled -> confirmed (PRD v2 §9.2)
```

- **Mechanism:** `registration_status_transition_guard` (and the analogous
  `payment_status_transition_guard`) raise `23514` on any forbidden transition, so it is
  unreachable through *any* write path, including direct SQL.
- **Requirement:** PRD §9.2 / rule 03 — forbidden transitions are enforced, not just
  documented. The same guard rejects `cancelled → checked_in` (7b), `refunded → confirmed`
  (7c), `checked_in → pending_payment` (7d), and `Payment failed → success` on the same
  row (7f).

## Provenance

Every line above is verbatim from `web/scripts/verify-db-constraints.mjs` run against the
local `reserva_dev` PostgreSQL database. The full 126-case run is available via:

```bash
cd web && npm run db:verify-constraints
```

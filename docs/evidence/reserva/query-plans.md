# Query-plan / index-use evidence

Real `EXPLAIN (FORMAT JSON)` plans captured against the local `reserva_dev` PostgreSQL
database, with sequential scans disabled (`SET LOCAL enable_seqscan = off`) so the plan
proves the predicate is servable by an index rather than a table scan. These are the two
heavy reads the PRD's numeric targets apply to (PRD §17).

> The database holds no persistent seed rows (integration fixtures roll back), so the
> plan's row estimates are minimal; what is proven is the **plan shape and index choice**,
> which is what §17's index requirement is about.

## Query 1 — Event-day staff search (PRD §17 "p95 < 500 ms")

The exact predicate from `tests/staff.db.test.ts` (case "has an index path for the event
scope"). The leading `%` of `ILIKE '%…%'` can never use a b-tree index, so the **scope**
(`event_id = …`) must come from an index; the name/email/phone match is then a filter on
the scoped set.

```sql
SELECT r.id
FROM registrations r
WHERE r.event_id = $1::uuid
  AND (r.attendee_name  ILIKE '%ada%' ESCAPE '\'
    OR r.attendee_email ILIKE '%ada%' ESCAPE '\'
    OR r.attendee_phone ILIKE '%ada%' ESCAPE '\');
```

Observed plan (with `enable_seqscan = off`):

```
Index Scan on registrations_registrations_event_id_status_idx
  Index Cond: (event_id = '…'::uuid)
  Filter: (attendee_name ~~* '%ada%'  OR  attendee_email ~~* '%ada%'  OR  attendee_phone ~~* '%ada%')
```

- **No `Seq Scan`** — the event scope is index-backed.
- The candidate indexes `registrations_event_id_attendee_name_idx` and
  `registrations_event_id_status_idx` both lead with `event_id`; the planner may pick
  either. The test assertion is `toContain("registrations_event_id")` and
  `not.toContain("Seq Scan")`, which holds for both.
- **Requirement:** PRD §17 event-day search p95 < 500 ms; FR-17/FR-18. The index is
  declared in the schema (`@@index([eventId, attendeeName])`).

## Query 2 — Dashboard registrations-by-status (PRD §17 "zero discrepancy")

The first of the four FR-25 aggregate statements, from
`src/server/db/operations.repository.ts` (`loadDashboard`), read inside one
`REPEATABLE READ` transaction:

```sql
SELECT r.status, count(*)::bigint AS "count"
FROM registrations r
WHERE r.event_id = $1::uuid
GROUP BY r.status;
```

Observed plan (with `enable_seqscan = off`):

```
Aggregate (Strategy: Sorted, Group Key: status)
  → Index Only Scan on registrations_registrations_event_id_status_idx
      Index Cond: (event_id = '…'::uuid)
```

- **`Index Only Scan`** on `(event_id, status)` serves both the scope **and** the
  `GROUP BY status` — the aggregate is an ordered scan of the index, not a sort of a full
  table.
- **Requirement:** PRD §17 zero-discrepancy dashboard; FR-25. The index is declared in
  the schema (`@@index([eventId, status])`). The remaining dashboard statements reach
  `payments` and `check_ins` through joins also filtered on `event_id` (see
  `operations.repository.ts`), using `payments_registration_id_idx` and
  `check_ins_registration_id_checked_in_at_idx`.

## Provenance

Both plans were produced with a short `pg` script against the running database, using the
same SQL as the application code and the same `enable_seqscan = off` technique the test
suite already uses. The search-query assertion is already part of the committed test
suite (`web/tests/staff.db.test.ts`, lines 994–1022).

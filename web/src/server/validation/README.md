# `src/server/validation` — centralised validation

One validation layer that **every mutating endpoint runs through**.

## Boundary

- Validation is centralised by requirement, not by preference: `AGENTS.md §4`
  requires one validation layer rather than ad-hoc per-endpoint checks, and
  `AGENTS.md §13` makes server-side validation authoritative (client-side
  validation is a UX layer on top, never a replacement).
- Must enforce exactly PRD v2 §11: attendee name 1–120 characters; valid email;
  phone required; tier must be published with `available > 0` at submission
  **and re-validated at confirmation time**; search query minimum 2 characters;
  `verified_amount_minor_units == expected_amount_minor_units`; idempotency keys
  required, client-generated, unique per submission; `page_size <= 50`.
- Authorization and lifecycle-transition legality are validation too, and run in
  this layer rather than as an afterthought.
- `400` responses carry field-level detail.

## Status

**In place for events (2026-09-26).** `validation.ts` centralises parsing for
`POST /api/v1/events`: required/bounded strings, offset-aware ISO 8601
timestamps, `ends_at > starts_at`, and a strict allowlist that rejects undefined
fields. It is hand-rolled — six fields did not justify a schema dependency, per
AGENTS.md §4.

Caveat: PRD v2 §11 defines validation rules for attendees, tiers, search,
payments, and idempotency keys, but **none for event fields**. The event length
limits and the offset requirement are a documented placeholder pending a product
decision; see "Known PRD gaps" in `.agents/skills/event-resource-crud/SKILL.md`.

Not yet covered: the registration, ticket-tier, search, and attendee-request
rules that §11 does specify. Those arrive with their own slices.

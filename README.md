# Reserva — Event Management & Ticketing Platform

Reserva is a single-organiser event ticketing platform. An organiser creates and
publishes events, configures ticket tiers, and takes payment through Flutterwave;
attendees buy a ticket, retrieve their own ticket evidence, raise requests, and are
checked in by event-scoped staff. The organiser watches a live dashboard fed by SSE and
can drill into any individual registration.

The full Must-Have API surface is implemented: every PRD §12 endpoint, plus the three
product-owner-approved additions (`R-5`) recorded in `.agents/rules/03`. There is no
attendee account system by design — possession of the ticket reference plus the email it
was bought with is the credential (PRD §3).

The authoritative product spec is `docx/event-ticketing-platform-prd-v2.md`; engineering
rules live in `docx/AGENTS.md`, `web/.agents/rules/`, and `web/.agents/skills/`. A
requirement-by-requirement trace is kept in `web/docs/evidence/requirements-matrix.md`.

## Documentation map

| Document | What it is |
| --- | --- |
| `docx/event-ticketing-platform-prd-v2.md` | Product behaviour: requirements, entities, lifecycles, API contracts, security (§20 bucket list). |
| `docx/AGENTS.md` | How engineering builds, verifies, and extends the product. |
| `web/.agents/rules/` | Eight detailed rules (source-of-truth, data integrity, lifecycle, payment, auth, API contract, concurrency, security). |
| `web/.agents/skills/` | Seven reusable implementation workflows. |
| `web/README.md` | The application's own README: layout, commands, environment. |
| `docs/design-tokens.md` | The design-token build pipeline documentation (the generator lives at the repo root). |
| `web/docs/evidence/requirements-matrix.md` | Requirement → implementation trace and open items. |

## Core features implemented

- **Events** — create/read/list/update/soft-delete, forward-only lifecycle, append-only
  edit log written in the same transaction as the change it records (FR-1/FR-3/FR-4).
- **Programme** — an ordered agenda per event (`sort_order` stored, not inferred; FR-2).
- **Ticket tiers & inventory** — per-tier `price_minor_units` + ISO 4217 currency, the
  two-counter availability model (`quantity_confirmed` + `quantity_held`), 15-minute
  holds, sold-out detection (FR-5/FR-6, BR-3).
- **Registration** — idempotent creation, server-generated `unique_reference`
  (≥128-bit entropy), `pending_payment` until verified payment (FR-8/FR-9/FR-10a).
- **Flutterwave payment** — server-side initiation, verification, and webhook handling
  with signature verification and an atomic confirmation transaction (FR-11/FR-12/FR-13).
- **Evidence retrieval** — two-factor (reference + email), live event details, `403` on
  mismatch so existence is never disclosed (FR-15, BR-6).
- **Staff search & check-in** — event-scoped search with masked contact, append-only
  check-in log with override semantics (FR-17/FR-18/FR-20/FR-21, BR-4/BR-5).
- **Attendee requests** — idempotent submission, organiser queue, respond/resolve with
  retained resolution notes (FR-23/FR-23a/FR-24).
- **Organiser dashboard** — four aggregates (registrations, payments, tier sales,
  check-ins) plus an SSE stream for ≤5-second check-in propagation (FR-25/FR-22).
- **Full registration record** — every payment attempt and the whole check-in log for one
  registration (FR-26).
- **Staff tokens** — opaque bearer tokens, hashed, event-scoped, revocable, bounded
  lifetime.

## Tech stack

| Concern | Choice |
| --- | --- |
| Application framework | Next.js 16.3.6 (App Router) |
| Language | TypeScript 5, `strict: true`, `@/*` → `web/src/*` |
| ORM / DB | Prisma 7.10.0 (`@prisma/adapter-pg` + `pg`), PostgreSQL |
| Auth | Node `crypto` scrypt (passwords), opaque random session tokens stored as SHA-256 hashes |
| Realtime | SSE (`ReadableStream<Uint8Array>`) — no WebSockets (PRD §13) |
| Tests | Vitest 5 |
| Lint | ESLint 9 + `eslint-config-next` |
| Design system | In-repo token pipeline (`scripts/build-tokens.mjs`) → `dist/tokens.css` |
| Package manager | npm |

## Repository structure

```
Reserva/
├─ docx/                      PRD v2 and AGENTS.md (source of truth)
├─ design-tokens.tokens.json  Figma/W3C design-token export
├─ scripts/ + tests/          the design-token generator and its tests
├─ dist/                      generated token artefacts (committed)
├─ docs/design-tokens.md      design-token pipeline documentation
├─ evidence/                  submission evidence placeholders (see evidence/README.md)
└─ web/                       the application (Next.js + Prisma)
   ├─ src/app/api/v1/…        route handlers
   ├─ src/domain/…            framework-agnostic business logic
   ├─ src/server/…            server-only modules (db, auth, flutterwave, http, validation)
   ├─ prisma/                 schema.prisma + migrations/
   ├─ tests/                  unit, route, and PostgreSQL integration tests
   └─ .agents/                rules and skills
```

## Architecture & server-side boundaries

The application follows a strict layer separation (AGENTS.md §4):

- **Route handlers** (`src/app/api/v1/…`) parse and validate input, resolve the caller,
  call a domain service, and serialise the result. They contain no business logic.
- **Domain layer** (`src/domain/…`) holds the business rules and is framework- and
  database-agnostic — no Next.js or Prisma imports.
- **Persistence** (`src/server/db/…`) adapts repositories to Prisma/PostgreSQL.
- **Validation is centralised** in `src/server/validation/validation.ts`; every mutating
  endpoint runs through it (PRD §11).
- **Errors** funnel through one renderer, `src/server/http/error-response.ts`, so the
  `{ error: { code, message, fields } }` envelope and status-code map (§15) hold by
  construction. `unauthenticated` and `forbidden` are both `403` — the contract defines
  no `401` (PRD §15 L421).

Server-side-only boundaries that are never trusted from the client: payment amounts and
verification results, authorization/ownership decisions, and staff-token scope.

## Database / Prisma

The schema is the contractual PRD §7.2 model — 11 models:

`Organiser`, `OrganiserSession`, `Event`, `EventEditLog`, `ProgrammeItem`, `TicketType`,
`Registration`, `Payment`, `CheckIn`, `AttendeeRequest`, `StaffToken`.

Integrity is enforced in the database, not only in application code (AGENTS.md §5):
unique constraints (`slug`, `unique_reference`, both `idempotency_key`s,
`provider_reference`, `(event_id, name)`), `CHECK` constraints (availability counters,
request status/`resolved_at` agreement), indexes exactly as §7.2 specifies, `RESTRICT` /
`CASCADE` foreign keys, soft delete on `Event`, and triggers that guard the check-in and
attendee-request lifecycles against any write path.

There are **10 migrations** in `web/prisma/migrations/`, applied and up to date.

## Environment setup

Copy `web/.env.example` to `web/.env` and fill it in. `.env*` is git-ignored; the
template is committed and contains **no real secrets** — placeholders only.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | PostgreSQL connection string (with `options=-c timezone=UTC`). |
| `FLUTTERWAVE_SECRET_KEY` | For payments | Provider secret key, read lazily at first payment call. |
| `FLUTTERWAVE_WEBHOOK_SECRET` | For payments | The `verif-hash` webhook signing secret. |
| `FLUTTERWAVE_API_BASE_URL` | No | Overrides the live API base (default `https://api.flutterwave.com/v3`). |
| `FLUTTERWAVE_REDIRECT_BASE_URL` | No | Public origin sent back after hosted checkout; absent is a supported webhook-only mode. |

There is deliberately **no session secret**: sessions are opaque random tokens stored as a
SHA-256 hash and matched by lookup, so there is nothing to sign, rotate, or leak.
Organiser accounts are provisioned out of band (`npm run db:create-organiser -- <email>`);
there is no self-registration endpoint.

## Installation & development

```bash
# application (from web/)
cd web
npm install          # also runs `prisma generate` via postinstall
npm run dev          # development server

# design tokens (from the repository root)
npm run build        # regenerate dist/
npm run check        # fail if dist/ is out of date (CI)
```

`prisma validate` and `prisma generate` work without a database or `.env`. `prisma migrate
dev` cannot be used here (the development role lacks `CREATEDB`), so migrations are
authored against a scratch database and applied with `prisma migrate deploy`.

## Verification

Run from `web/` unless noted:

```bash
npm run typecheck              # tsc --noEmit
npm run lint                   # eslint
npm test                       # vitest run (PostgreSQL tests skip without DATABASE_URL)
npm run build                  # production build

npm run prisma:validate        # validate schema.prisma (no database needed)
npm run prisma:generate        # regenerate the client
npm run prisma:migrate:status  # migrations applied vs. pending

npm run db:verify-constraints  # 126 rejection/acceptance cases against real PostgreSQL
```

A single combined check is `npm run verify` (typecheck + lint + test + build).

## API overview

All routes live under `/api/v1` (plus the infra-only `/api/health`). Groups:

| Group | Endpoints |
| --- | --- |
| Auth | `POST /auth/login`, `POST /auth/logout` |
| Events | `POST /events`, `GET /events`, `GET/PATCH/DELETE /events/{id}` |
| Programme | `GET/POST /events/{id}/programme`, `PATCH/DELETE /events/{id}/programme/{itemId}` |
| Ticket types | `GET/POST /events/{id}/ticket-types`, `PATCH/DELETE /events/{id}/ticket-types/{id}` |
| Registrations | `POST /events/{id}/registrations`, `GET /events/{id}/registrations/search`, `GET /events/{id}/registrations/{registrationId}` (FR-26) |
| Payments | `POST /payments/initiate`, `POST/GET /payments/verify`, `POST /payments/webhook` |
| Check-in | `POST /registrations/{id}/check-in` |
| Evidence | `GET /registrations/evidence` |
| Requests | `POST /registrations/{id}/requests`, `GET /events/{id}/requests`, `PATCH /events/{id}/requests/{requestId}` |
| Dashboard | `GET /events/{id}/dashboard`, `GET /events/{id}/dashboard/stream` (SSE) |
| Staff tokens | `POST/GET/DELETE /events/{id}/staff-tokens` |

List endpoints use the pagination envelope `{ data, page, page_size, total }` with
`page_size` default 20 / max 50. Response DTOs never leak internal fields (e.g. the
public event DTO returns `TicketTypeSummaryDTO`, never the raw row with its counters).

## Authentication & authorization

Three tiers, all enforced server-side (PRD §3):

- **Public / attendee** — no account. Proves possession with `unique_reference` + email
  for evidence and request submission.
- **Organiser** — email + scrypt-hashed password; a cookie carries an opaque session
  token stored as a SHA-256 hash. Every organiser-scoped route checks
  `event.organiser_id == current_user.id` before reading (IDOR-guarded).
- **Staff / usher** — an event-scoped bearer token (SHA-256 hash stored), revocable,
  expiring at event end + 24h or an explicit earlier time. The token's own row determines
  scope; a client-supplied `event_id` is never trusted.

## Flutterwave payment flow

1. **Initiate** (`POST /payments/initiate`) — the amount is server-computed from the
   `TicketType` row, never client-supplied. The `Payment` attempt is committed (`initiated`)
   with our own `tx_ref` as `provider_reference` **before** the provider call, so a timed-out
   request still leaves a trace that `/verify` can resolve.
2. **Verify** (`POST/GET /payments/verify`) — a server-side provider verification precedes
   any write. On success, one atomic transaction (PRD §8.5): mark `success` → verify amount
   (`verified == expected`) → increment `quantity_confirmed` → decrement `quantity_held` →
   set the registration `confirmed`. All or nothing.
3. **Webhook** (`POST /payments/webhook`) — the `verif-hash` signature is checked before
   the body is read. The webhook is the eventual source of truth (§8.6): duplicate
   delivery is a no-op via `UNIQUE(provider_reference)`, and a disagreeing redirect check
   never overwrites the webhook's outcome.

## Ticket inventory & concurrency protection

- Two counters per tier, `CHECK (quantity_confirmed + quantity_held <= quantity_total)`.
  The **last-unit race** is settled by the constraint plus an atomic conditional update —
  exactly one of two racing attempts succeeds.
- Idempotency is a database guarantee, not a `SELECT-then-INSERT` check:
  `UNIQUE(idempotency_key)` on `Registration` and `AttendeeRequest`, `UNIQUE(provider_reference)`
  on `Payment`.
- Concurrent check-ins and request resolutions are guarded: check-in reads under a
  per-registration advisory lock; request resolution runs at `READ COMMITTED` so the
  conditional `WHERE status = 'open'` update sees a just-committed competing resolve, and
  exactly one wins.

## Registration / check-in / request / evidence flows

- **Registration** — a client-supplied `idempotency_key` guards duplicate submission;
  replay returns the original result, a materially different body on the same key is `409`.
- **Check-in** — append-only: each check-in is a new `CheckIn` row; an override is a second
  row with `is_override = true`, never an edit. `Registration.status = checked_in` is a
  maintained projection. Staff can only check in `confirmed` registrations (FR-21, `409`
  otherwise).
- **Requests** — an attendee submits against their registration (reference + email);
  the organiser queue is event-scoped and status-filterable. Responding writes notes
  (still `open`); resolving sets `status = resolved` + `resolved_at` with non-blank notes
  and is terminal.
- **Evidence** — reference + email, live event details joined from `Event`, and an
  identical `403` for every mismatch kind (anti-enumeration).

## Database integrity & lifecycle decisions

- Forbidden transitions are enforced (triggers + transactional guards), never only
  documented: `FAILED → SUCCESS` on a payment, `CANCELLED → CONFIRMED` on a registration,
  reopening a resolved request, deleting/editing check-ins or requests.
- One `success` payment per registration (partial unique index); `Payment` is 1:N with
  `Registration`, `CheckIn` is 1:N (append-only).
- Event soft delete only — never hard delete once payments exist (audit, §14).
- The dashboard aggregate and the FR-26 record are read inside a single `REPEATABLE READ`
  transaction, so their numbers describe one instant (zero-discrepancy, §17).

## Testing & verification results

Latest verified run:

| Gate | Result |
| --- | --- |
| Test suite | **38 files, 1,082 / 1,082 passing** (189 against real PostgreSQL across 8 files) |
| Database constraint verifier | **126 / 126 checks passing** |
| Migrations | **10 applied, database up to date** |
| Typecheck | passing |
| Lint | passing |
| Production build | passing |

The `.db.test.ts` files exercise real PostgreSQL (idempotency races, last-unit sale,
append-only check-in, guarded resolution, transaction rollback); they skip when
`DATABASE_URL` is unset so `npm test` still passes in CI without a database.

## Deliberate limitations

Only items already documented in the project (see `web/docs/evidence/requirements-matrix.md`
Part 5 and `web/README.md`):

- **Flutterwave reversal handling** (`O-7`) — the webhook verifies authenticity and
  settles normal payments but does not yet recognise a post-success reversal.
- **FR-14 outbound confirmation email** — deferred by decision `R-8`: the guarantee is
  delivered through the create response plus FR-15 evidence, not a mail channel.
- **FR-7 per-tier closure** — deferred by decision `R-7`: the support path is reducing
  `quantity_total`, not a per-tier status.
- **A phone format rule** (`O-6`) — PRD §11 says only "required", so no stricter format is
  invented; it awaits a product-owner answer.
- **The measured p95 search figure** (§17) — the index path is proved by `EXPLAIN`; the
  number itself needs a loaded dataset.
- **The UI layer** — the API surface is complete; the browser UI is not yet built.

# `web` — Event Management & Ticketing Platform (application)

The full Must-Have API surface is implemented: every PRD §12 row, plus the three
product-owner-approved additions (`R-5`) recorded in `.agents/rules/03`. The
authoritative requirements are `../docx/event-ticketing-platform-prd-v2.md` and
`../docx/AGENTS.md`; the engineering constraints are in `.agents/rules/` and
`.agents/skills/`. A requirement-by-requirement trace is kept in
`docs/evidence/requirements-matrix.md`.

## Stack

| Concern | Choice |
| --- | --- |
| Framework | Next.js 16.3.6 (App Router, Turbopack) |
| Language | TypeScript 5, `strict: true`, `@/*` → `src/*` |
| ORM | Prisma 7.10.0 (`prisma` + `@prisma/client` + `@prisma/adapter-pg` + `pg`) |
| Database | PostgreSQL |
| Tests | Vitest 5 (node environment) |
| Lint | ESLint 9 + `eslint-config-next` |
| Package manager | npm (lockfile: `package-lock.json`) |

Chosen from the strong default in `AGENTS.md §4` / §21.1, confirmed before
scaffolding. It satisfies the PRD constraints that matter: server-side-only
payment and authorization logic, real PostgreSQL transactions for the atomic
confirmation sequence (PRD §8.5), constraint-heavy schema migrations (PRD §7),
and SSE for the organiser dashboard (PRD §13).

## Commands

```bash
npm install          # also runs `prisma generate` via postinstall
npm run dev          # development server
npm run build        # production build
npm run start        # serve the production build

npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm test             # vitest run
npm run verify       # typecheck + lint + test + build

npm run prisma:validate   # validate schema.prisma (needs no database)
npm run prisma:generate   # regenerate the client
npm run prisma:migrate    # create/apply a migration (needs a live database)
npm run prisma:migrate:status

npm run db:verify-constraints   # assert the schema rejects invalid rows
npm run db:create-organiser -- <email>
```

`prisma validate` and `prisma generate` deliberately work **without** a
database or a `.env`, so they can run in CI.

`prisma migrate dev` cannot be used here: the development role lacks `CREATEDB`,
so no shadow database can be created. Create migrations against a scratch
database and apply them with `prisma migrate deploy`, recording each migration's
PRD §7.2 line as `AGENTS.md §5` requires.

The `*.db.test.ts` files run against a real PostgreSQL database and are skipped
when `DATABASE_URL` is unset, so `npm test` passes in CI without one.

## Layout

```
src/
  app/            Next.js App Router — route handlers and the root layout
    api/health/   infrastructure health check (NOT a PRD §12 endpoint)
    api/v1/       the PRD §12 surface: auth, events, payments, registrations
    globals.css   imports the repository's generated design tokens
  domain/         business logic; framework- and database-agnostic
    events/       event rules: slug strategy, audit diffing, lifecycle
    requests/     attendee requests, the queue, response/resolution
    operations/   dashboard aggregates and the FR-26 full record
  ui/             components and client interaction
  server/         server-only modules
    env.ts        centralised, validated environment access
    db/           Prisma client (driver adapter) and repositories
    auth/         sessions, password hashing, organiser context
    dashboard/    the SSE stream lifecycle (frames, polling, keepalive)
    flutterwave/  provider redirect/URL assembly
    http/         error envelope, pagination, cache policy
    providers/    external provider adapters
    validation/   centralised request validation
  generated/      Prisma client output (generated; git-ignored)
prisma/
  schema.prisma   full PRD §7.2 model
  migrations/     checked in; apply with `npm run prisma:migrate`
tests/            unit, route, and PostgreSQL integration tests
```

`AGENTS.md §4` requires UI, route handlers, domain logic, persistence, and
third-party integrations to stay in distinct layers, and requires a route
handler to call into domain logic rather than embedding business rules inline.
Each layer directory documents its boundary and which rule governs it.

## Design tokens

The repository's token pipeline is the single visual-value source of truth. The
app imports the committed, generated `../dist/tokens.css` and adds no colours,
spacing, shadows, or typography of its own. Regenerate from the repository root:

```bash
npm run build     # regenerate dist/
npm run check     # fail if dist/ is out of date (use in CI)
```

`next.config.ts` sets `turbopack.root` to the repository root so the app can
resolve that artefact; this keeps exactly one copy of the tokens.

A known gap is recorded in `src/app/globals.css`: the current token export
defines no `background` / `surface` / `text` / `outline` roles. That gap should
be closed in `design-tokens.tokens.json`, not patched in the app.

## Environment

Copy `.env.example` to `.env` and fill it in. Only `DATABASE_URL` is required,
even now that authentication exists: sessions are opaque random tokens stored
as a SHA-256 hash and matched by lookup, so there is no signing key to keep and
nothing to leak from a compromised secret. `.env*` is git-ignored;
`.env.example` is committed.

The payment endpoints are implemented, so `.env.example` documents the variables
they read. Only `DATABASE_URL` is required at startup; `FLUTTERWAVE_SECRET_KEY`
and `FLUTTERWAVE_WEBHOOK_SECRET` are read lazily the first time a payment
endpoint is used, and a missing one fails loudly by variable name. The one
remaining payment gap is reversal handling (`O-7`, recorded in
`docs/evidence/requirements-matrix.md`); the Flutterwave mechanics themselves
were confirmed against official documentation and are recorded in
`docs/evidence/flutterwave-verify-resolution.md`.

Organiser accounts are provisioned out of band — there is no self-registration
endpoint:

```bash
npm run db:create-organiser -- owner@example.com
```

## Not implemented

The UI layer, and three decisions that are deferred rather than forgotten:

- **Flutterwave reversal handling** (`O-7`) — the webhook verifies authenticity
  and settles normal payments, but does not yet recognise a reversal.
- **FR-14 outbound confirmation email** — resolved by decision `R-8`: the
  guarantee is delivered through the create response plus FR-15 evidence, not a
  mail channel.
- **The measured p95 search figure** (§17) — the index path is proved by
  `EXPLAIN`; the number itself needs a loaded dataset this repository does not
  have.

Implemented: the full PRD §7.2 schema with its constraints and triggers,
organiser authentication, the Event and programme slice, ticket tiers and
inventory, idempotent registration, the Flutterwave initiate/verify/webhook
flow, append-only check-in with staff tokens, two-factor evidence retrieval,
attendee requests (submit, queue, respond/resolve), and the organiser dashboard
with its SSE stream.

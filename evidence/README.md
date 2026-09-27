# Submission evidence

Each numbered file below is a **placeholder** for a screenshot you capture manually.
Replace the placeholder with your actual image, keeping the filename exactly as named so
the numbering stays stable. The table states, for each file: the command or action to
perform, the successful result that must be visible, and the project requirement it
supports.

| File | Command / action | Successful result that must be visible | Requirement it supports |
| --- | --- | --- | --- |
| `01-test-suite.png` | From `web/`, run `npm test` | Vitest summary: **`38 passed (38)` test files and `1082 passed (1082)` tests** (or the equivalent "Tests 1082 passed (1082)" line). | PRD §16; `AGENTS.md §17` — the full automated test suite is green. |
| `02-build.png` | From `web/`, run `npm run build` | `✓ Compiled successfully`, "Running TypeScript", "Generating static pages", and the route table ending without errors. | `AGENTS.md §17` — the production build compiles and type-checks. |
| `03-database-integrity.png` | From `web/`, run `npm run db:verify-constraints` | The final line **`126/126 checks passed.`** | PRD §16 "rejected invalid inserts"; `AGENTS.md §5` — constraints/triggers actually reject what they must. |
| `04-migration-status.png` | From `web/`, run `npm run prisma:migrate:status` | `10 migrations found in prisma/migrations` and **`Database schema is up to date!`** | PRD §7; `AGENTS.md §5` — schema and migrations are applied and in sync. |
| `05-github-final-state.png` | After the baseline commit, view the repository (e.g. `git log --oneline` and `git status`) | The commit `feat: complete Reserva event platform` on `master`, and **`nothing to commit, working tree clean`**; no `node_modules`, `.env`, `.next`, or generated Prisma client in the tree. | Submission closeout — one clean baseline commit, hygiene verified. |
| `06-readme.png` | View the root `README.md` (rendered) | The document shows Overview, Core features, Tech stack, Structure, Database, Environment, Verification, API, Auth, Flutterwave, Concurrency, and Testing sections. | Final documentation package — the platform is documented as built. |

## Capture notes

- Run every command from the directory shown in the table (`web/` for all four test/build
  commands).
- Capture the **full tail** of the output so the summary line (file count / pass count /
  "126/126" / "up to date") is visible, not just the beginning.
- `npm test` may skip the `*.db.test.ts` files if `DATABASE_URL` is unset — that is
  expected and still shows `1082/1082`; if you want the PostgreSQL cases included, run
  with `DATABASE_URL` set to the local database.
- Do not include any screen content that reveals `.env` values or provider secrets.

## Evidence ↔ requirement summary

- `01`, `02` prove the codebase builds and its tests pass (`AGENTS.md §17`, PRD §16).
- `03` proves the database rejects invalid writes (PRD §16's "rejected invalid inserts").
- `04` proves the schema is at the documented migration state (PRD §7, `AGENTS.md §5`).
- `05` proves the repository was closed out cleanly (one commit, no secrets/artefacts).
- `06` proves the final documentation package exists and is complete.

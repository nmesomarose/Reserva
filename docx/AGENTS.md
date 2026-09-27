# AGENTS.md — Event Management & Ticketing Platform

**Source of truth for product behaviour:** `event-ticketing-platform-prd-v2.md` (PRD v2)
**This document defines:** how engineering agents build, verify, and extend that product.

This file does not restate the PRD. Where a rule below references a PRD section, go read that section — don't reason from memory of a paraphrase.

---

## 0. Status of this document

Written before the application repository exists. Two sections below (Architecture & Project Structure, part of UI/UX & Design System) are therefore scaffolded as **decisions to confirm at project init**, not settled conventions — because no code exists yet to observe conventions from. Everything else is fully specified now, from the PRD and from the design-token tooling that does already exist. See Section 21 (Open Items) for the exact list of what still needs confirming once the repo is created.

---

## 1. Agent Role

You are a senior product engineer on this codebase. That means:

- You implement the PRD faithfully — its requirements, its explicit non-requirements, and its stated assumptions are all binding until the product owner changes them, not just the parts that are convenient to build.
- You protect data integrity ahead of development speed. If a PRD rule requires a database constraint, a check that lives only in application code is not a substitute — it's a gap.
- You respect security boundaries even when it would be faster not to (an unauthenticated shortcut during local dev is not something you leave in place).
- You maintain UI/UX quality using the project's actual design tokens, not ad-hoc values.
- You write maintainable code: the smallest coherent change that satisfies the requirement, not a rewrite dressed up as a fix.
- You verify before declaring anything done — see Section 17 and Section 18.

You reason about *product behaviour*, not just code structure. Before writing a line of a payment-adjacent or check-in-adjacent feature, be able to state which PRD requirement it satisfies and which failure mode (Section 10, PRD) it must not reintroduce.

---

## 2. Source-of-Truth Hierarchy

When sources conflict, **stop and surface the conflict** — do not silently pick one, and do not let implementation convenience override an explicit PRD requirement.

1. **PRD v2** (`event-ticketing-platform-prd-v2.md`) — product behaviour, scope, business rules, entities, lifecycles, API contracts, security requirements, acceptance criteria.
2. **This file (`AGENTS.md`)** — engineering conventions and implementation rules.
3. **`.agents/rules/`** — detailed project rules (create as needed; none exist yet).
4. **`.agents/skills/`** — reusable implementation workflows (create as needed; none exist yet).
5. **Existing project architecture and established patterns** — once the repo exists, follow what's already there over inventing something new (Section 4).
6. **Existing design-token CSS variables** — the generated output of `scripts/build-tokens.mjs` (Section 11) is the visual-system source of truth. Never a competing value.

If you find yourself about to violate a PRD rule "just for this one case," that's the signal to stop and ask, not to proceed.

---

## 3. Scope Discipline

Implement only what PRD Section 20 places in **Must-Have**. Do not build ahead into **Supporting**, **Future Possibilities**, or **Explicitly Out-of-Scope** without an explicit instruction to do so — even if it looks like "just a small addition" while you're already in the relevant file.

Reference — from PRD v2 §20:

| Bucket | Examples (non-exhaustive — see PRD for full list) |
|---|---|
| **Must-Have** | Event/tier CRUD, registration + Flutterwave payment with idempotency keys, server-side verification + atomic confirmation, organiser auth + event-scoped staff tokens, two-factor evidence retrieval, event-scoped search with disambiguation, append-only check-in log, attendee requests, organiser dashboard, audit logging |
| **Supporting** | Attendee notification on event-detail changes, reference-based fast-lookup at check-in |
| **Future Possibilities** | Multi-ticket checkout, refund processing, ticket transfer, multi-organiser teams, platform admin layer, QR check-in, SMS notifications, cross-event attendee identity |
| **Explicitly Out-of-Scope** | Cash payments, event marketplace/discovery, seat-mapping, loyalty/social features |

Additional discipline:
- No speculative abstractions ("we might need this later" is not a reason to build it now).
- No new libraries without stating why the existing stack can't do the job.
- No premature optimisation — build to the PRD's actual numeric targets (§13, §17 PRD), not to imagined future scale.
- If an implementation decision would materially change product behaviour (e.g., how a lifecycle transition is gated, what a public API returns), stop and ask rather than deciding silently — this includes decisions the PRD flagged as open in its own §21.

---

## 4. Architecture & Project Structure

**No application repository exists yet.** The rules below are the boundaries to enforce regardless of the specific stack chosen at scaffold time; the specific stack itself is an open item (Section 21).

Mandatory boundaries, whatever the framework:
- **Payment logic is server-side only.** No payment amount, verification result, or provider secret is ever computed or trusted from client code (PRD §5.4, §18).
- **Authorization checks are server-side only.** A client-provided `event_id`, role claim, or ownership assertion is never trusted without a server-side check against the authenticated identity (PRD §3, §18).
- **Layer separation:** keep UI, API/route handlers, domain/business logic, persistence, and third-party integrations (Flutterwave) in distinct layers. A route handler should call into domain logic, not embed payment-verification or lifecycle-transition logic inline.
- **Validation is centralised**, not scattered per-endpoint ad hoc — one validation layer that every mutating endpoint runs through (PRD §11, §13 of this file).
- Once the repo exists, **inspect it before adding a new pattern.** If a convention is already established (e.g., a specific folder-per-feature layout, a specific ORM usage pattern), extend it — don't introduce a second, competing convention alongside it.

Suggested default (not yet confirmed — flagged in Section 21): the account's other in-flight projects (Predictive Home Intelligence Platform, Secure Record Management, Tegvoc) consistently use **Next.js + TypeScript + Prisma + PostgreSQL**. That stack satisfies every PRD constraint here (server-side route handlers, transactional Postgres for the atomic confirmation transaction in PRD §8.5, Prisma migrations for the constraint-heavy schema in PRD §7). Treat this as a strong default to confirm at scaffold time, not a decision already made.

---

## 5. Database & Data Integrity

The schema in PRD §7 is contractual. Every one of the following must be a real database-level guarantee, not just an application-level check that happens to run first in practice:

- UUID primary keys on every entity.
- Foreign keys with the exact `RESTRICT`/`CASCADE` behaviour specified per relationship in PRD §7.2 (e.g., `Event.organiser_id` → `RESTRICT`; `ProgrammeItem.event_id` → `CASCADE`).
- `UNIQUE` constraints: `Event.slug`, `Registration.unique_reference`, `Registration.idempotency_key`, `Payment.provider_reference`, `AttendeeRequest.idempotency_key`, `(TicketType.event_id, name)`.
- `CHECK` constraints: `quantity_confirmed + quantity_held <= quantity_total`, `quantity_confirmed >= 0 AND quantity_held >= 0`.
- Indexes exactly as specified: `(organiser_id, status)` on Event; `(event_id, sort_order)` on ProgrammeItem; `event_id` on TicketType; `(event_id, attendee_name)` and `(event_id, status)` on Registration; `registration_id` on Payment; `(registration_id, checked_in_at DESC)` on Check-in.
- Monetary values as `price_minor_units` (integer) + `currency` (ISO 4217) — never a float, never a bare decimal without a currency code alongside it.
- Lifecycle enums exactly as PRD §9 defines them, including the states added in v2 (`Registration.status` includes `checked_in`; see PRD §7.3 denormalisation note for why).
- **Forbidden transitions are enforced, not just documented.** Where PRD §9 says a transition is forbidden (e.g., `CANCELLED → CONFIRMED`, `FAILED → SUCCESS` on the same Payment row), that must be unreachable through the write path — via application-transaction guards at minimum, and via a database trigger/constraint where practical.
- `created_at`/`updated_at` on every entity that has them in PRD §7.2 — don't drop them because a given entity feels append-only.
- Soft delete (`deleted_at`) on `Event`, never hard delete once a `Payment` exists against it (PRD §14).
- **`Payment` is 1:N with `Registration`** — one registration can have multiple payment attempts; only one may reach `success`. Do not model this as 1:1; that was v1's core bug and the audit's first blocking correction.
- **`Check-in` is 1:N with `Registration`**, append-only — an override is a new row with `is_override = true`, never an edit to the original row.
- Idempotency: `UNIQUE(Payment.provider_reference)` is described in the PRD as "the single most important constraint in the schema." Do not implement idempotency as an application-level `SELECT-then-INSERT` check alone — that has a race window under concurrent webhook delivery. The unique constraint plus a transaction is what actually closes the race.

When you write a migration, be able to point to which PRD line it satisfies. When you're tempted to relax a constraint "to make the seed data easier," don't — fix the seed data instead.

---

## 6. Payment Integrity

Flutterwave is the payment provider (fixed by the PRD; not up for reconsideration without an explicit product decision).

Hard rules, from PRD §8:
- Payment amount is always server-computed from `TicketType.price_minor_units` at the moment of initiation. Never accept a client-supplied amount.
- Redirect state is **never** authoritative. Every redirect triggers a server-side verification call before any confirmation.
- Webhook authenticity (signature/secret verification) is checked before any state change is made from a webhook payload.
- `UNIQUE(Payment.provider_reference)` makes duplicate webhook delivery a no-op at the database level, not just something the application "should" catch.
- The confirmation sequence (mark Payment success -> verify amount -> increment `quantity_confirmed` -> decrement `quantity_held` -> set Registration to `confirmed`) is **one atomic transaction** (PRD §8.5). If any step fails, the whole thing rolls back and is safely retried using the same `provider_reference` — never leave a state where money moved but no ticket exists, and never leave a state where the retry accidentally double-confirms.
- The webhook is the eventual source of truth (PRD §8.6). If a redirect-triggered check and a later webhook disagree, the webhook wins, and the registration reconciles — including reversing a provisional confirmation if warranted.
- **Every Flutterwave-specific mechanic in the PRD is marked `[VERIFY]` for a reason** — the exact verification endpoint, webhook payload shape, signature scheme, and response-time contract are not yet confirmed against current Flutterwave documentation. **Do not invent these.** Before writing any Flutterwave integration code, verify the current mechanics against official docs, and if something in the PRD's assumption turns out to be wrong, flag it — don't quietly code around it.

---

## 7. Authentication & Authorization

Per PRD §3, three access tiers, all enforced server-side:

**Public / Attendee** — no platform account. Can: view published events, submit a registration, initiate/complete payment, retrieve their own evidence via **reference + email** (two-factor — reference alone is not sufficient), submit an issue tied to their own registration.

**Organiser** — full platform account. Can: manage only events where `event.organiser_id == current_user.id`; configure tiers; view the dashboard; manage attendee requests; issue and revoke staff tokens. Never grant access to another organiser's event by ID guess (IDOR — test this explicitly, PRD §16).

**Staff/Usher** — event-scoped access token, not a full account. Can: search and check in within the **one event the token is scoped to**, nothing else. Cannot see other events, cannot edit configuration, cannot see raw payment-provider data. Tokens expire and are revocable; a revoked token must be rejected on its very next server-side request, not just hidden from the UI.

Rules that apply everywhere:
- Never trust a client-supplied `event_id` as proof of authorization for a staff-token request — the token's own scope determines which event it can touch, looked up server-side.
- The check-in endpoint itself, not just the UI, returns `409` if the registration isn't in a check-in-eligible state (PRD §5.7, FR-21) — the "check-in button is hidden" behaviour must be backed by a real server-side rejection, since a hidden button is not a security boundary.

---

## 8. API Engineering Standards

All routes live under `/api/v1/...` exactly as enumerated in PRD §12. Do not rename, restructure, or "improve" these paths without explicitly flagging the change as an API-contract deviation first.

For every endpoint, preserve:
- The stated auth context (public / organiser / staff / system-webhook) from PRD §12's table.
- The stated request fields, including `idempotency_key` where the PRD requires one (registration creation, attendee requests).
- The stated status-code semantics (PRD §15): `200` for empty search/list results, `403` (not `404`) on evidence-lookup mismatch, `409` for state conflicts, etc.
- Pagination envelope: `{ data: [...], page, page_size, total }`, `page_size` default 20 / max 50, on every list endpoint.
- Response DTOs that don't leak internal fields — e.g., the public event endpoint returns a `TicketTypeSummaryDTO` (`name`, `price_minor_units`, `currency`, `available`), never the raw `TicketType` row with its internal counters (PRD §13 over-fetching decision).

If a genuine API-contract change is needed during implementation, say so explicitly (what's changing, why the PRD's version doesn't work) before writing it — don't let it happen silently inside a "cleanup."

---

## 9. Lifecycle & State-Machine Discipline

Treat PRD §9's four lifecycles (Payment, Registration, Ticket availability, Check-in) as contracts, including their forbidden transitions.

For every transition you implement, be able to answer:
- What is the current state?
- Is the requested transition in the allowed list for that lifecycle?
- Is the caller authorized to trigger it?
- What happens if two callers trigger it concurrently (Section 10 below)?
- What's the transaction boundary, and what's the rollback behaviour if a later step fails?

Never resolve an invalid or unexpected state by simply overwriting the current value to whatever seems convenient. If a Check-in row exists for a registration whose Payment somehow got reversed after the fact, that's a `requires_reconciliation` case (PRD §8.5/§8.6), not something to silently patch over.

---

## 10. Concurrency & Idempotency

Treat every one of these as a required, testable guarantee, not a nice-to-have (PRD §16):

- Duplicate registration submission -> guarded by client-supplied `idempotency_key`, `UNIQUE` in the database; replay returns the original result.
- Duplicate attendee-request submission -> same mechanism.
- Duplicate Flutterwave webhook delivery -> guarded by `UNIQUE(Payment.provider_reference)`.
- Simultaneous purchase of the last available unit -> guarded by the `CHECK(quantity_confirmed + quantity_held <= quantity_total)` constraint plus an atomic conditional update — exactly one of two racing attempts succeeds.
- Repeated check-in requests -> the append-only Check-in log plus the `409`-without-override rule (PRD §5.7).
- Payment confirmation retries -> safe because the confirmation transaction (PRD §8.5) is idempotent on `provider_reference`.
- Redirect/webhook races -> resolved by the "webhook is eventual source of truth" rule (PRD §8.6).

For each of these, you should be able to explain *why* the race cannot produce an invalid state — cite the specific constraint or transaction boundary, not "the code checks for it."

---

## 11. UI/UX & Design System

### 11.1 Token system (confirmed — use this)

The project already has a design-token pipeline: `scripts/build-tokens.mjs` reads a Figma/W3C dTCG export (`design-tokens.tokens.json`) and generates CSS custom properties (plus a JSON report, Markdown reference, and HTML style guide). Regenerate/verify with `npm run build` or `npm run check`; `npm run stdout` prints output without writing files.

Confirmed conventions from the build config:
- All custom properties are prefixed **`--ds-`**.
- Colours are split into **primitives** (`--ds-color-primitive-key-*`, `-primary-*`, `-secondary-*`, `-tertiary-*`, `-neutral-*`, `-neutral-variant-*`, `-error-*`) and **semantic roles** (`--ds-color-*`), where roles are aliases to primitives (`roleValues: "alias"`) — **use role tokens in components** (`--ds-color-<role>`), not primitives directly, unless you're extending the palette itself.
- `colorFormat: "modern"` with `channels: true` — expect modern colour syntax with exposed channels for opacity/`color-mix()` composition, not bare hex.
- Effects/shadows: `--ds-shadow-*`.
- Spacing: `--ds-spacing-*`.
- Typography: `--ds-typography-*`, with a font shorthand available (`fontShorthand: true`) alongside individual properties.

**Rule: before creating or modifying any UI, inspect and reuse the project's existing design-token CSS variables. Do not introduce a competing design-token system or arbitrary visual values (hex codes, magic pixel numbers, ad hoc shadows) when an existing token applies.** If a needed value genuinely isn't covered by an existing token, document the gap explicitly (which value, which component needs it) rather than silently hardcoding something that looks close.

The exact path of the *generated* CSS output (as opposed to the build config) is not yet confirmed — see Section 21. Locate it (likely something the build script writes alongside `design-tokens.tokens.json`, check `scripts/build-tokens.mjs` for the output path) before writing your first component, and update this section with the real path once found.

### 11.2 Product-state UI requirements (non-negotiable)

This product's entire premise is that it never misrepresents payment/registration state (PRD §1, §18). UI must reflect that honestly — a `pending` payment must never *look* like a confirmed ticket, even briefly. Every one of these needs a distinct, intentional treatment (not a generic spinner or a reused "success" component):

| State | Requirement |
|---|---|
| Payment pending / confirming | Visually and textually distinct from confirmed — explicit "confirming your payment" state, time-bounded to the 15-minute hold window (PRD §5.3/§20) |
| Payment failed | Distinct from pending; offers retry |
| Payment confirmed | Only state that visually resembles "success" |
| Sold-out tier | Clearly disabled/labeled at the public event page, not just omitted |
| No registration found (search) | Explicit empty state with an escalation path, not a blank screen |
| Multiple matches (search) | Disambiguation list with masked email/phone, not an arbitrary single pick |
| Payment not confirmed (search result) | Distinct status badge; check-in control is **absent**, not just disabled-looking |
| Already checked in | Shows original timestamp; override is a distinct, deliberate action, not a silent re-click |
| Check-in success | Immediate, unambiguous confirmation |
| Check-in conflict (409) | Clear message distinguishing "already checked in" from "not eligible" |
| Attendee request submitted | Clear acknowledgment tied to their registration |
| Empty organiser dashboard | Distinct from "loading" or "error" |
| Expired/revoked staff access | Clear message, not a generic auth error |

Standard component/system conventions to apply consistently once the token system's full value set is visible: buttons, inputs, forms, cards, tables, badges/status indicators, dialogs/modals, navigation, loading states, error states — all built from `--ds-*` tokens, all following one spacing/typography rhythm across the app. Never use colour alone to distinguish status (pair every status badge with text/icon).

---

## 12. Accessibility

- Semantic HTML first — use the right element before reaching for ARIA.
- All interactive elements keyboard-accessible with a visible, token-based focus state.
- Accessible labels on every form input (visually hidden where appropriate, never absent).
- Status/loading feedback exposed to assistive tech (e.g., `aria-live` on payment-confirming and search-result states), not just visual.
- Contrast sourced from the existing token palette — verify pairings (particularly status badges — Section 11) meet contrast requirements using tokens as given, rather than picking an off-token shade to "fix" contrast locally.
- Never colour-only status communication (Section 11).

---

## 13. Validation

Server-side validation is authoritative; client-side validation is a UX layer on top of it, never a replacement. Enforce, server-side, exactly what PRD §11 specifies:

- Attendee name: 1–120 characters.
- Email: valid format.
- Phone: required.
- Ticket tier: must be published and have `available > 0` at submission, **re-validated again** at confirmation time (availability can change between the two).
- Search query: minimum 2 characters.
- Payment amount: `verified_amount_minor_units == expected_amount_minor_units`, mismatch blocks confirmation and flags for manual review rather than auto-accepting.
- Idempotency keys: required, client-generated, unique per submission.
- Pagination/search limits exactly as PRD §12 specifies (`page_size <= 50`).
- Authorization and state-transition legality (Sections 7, 9 of this file) — these are validation too, not a separate concern.

---

## 14. Security & Privacy

Never expose, in any API response:
- Password hashes or staff-token secrets/hashes.
- Raw payment-provider payloads to attendees or staff (organiser/audit-only, per PRD §18).
- Internal payment-provider details beyond what a role actually needs.

Preserve specifically:
- Evidence lookup requires reference + email; a mismatch returns `403`, never `404` (avoids confirming which references exist — PRD §15, §18).
- `unique_reference` and `idempotency_key` values carry >= 128 bits of entropy — not sequential, not guessable.
- Staff-token scope is enforced server-side on every request, not cached client-side as an assumption.
- Organiser ownership is checked on every organiser-scoped request (IDOR).
- Webhook payloads are signature-verified before any write.

Never log secrets (staff-token values, provider signing secrets, raw card-adjacent data) — log identifiers and outcomes, not the sensitive payload itself.

---

## 15. Performance

Build to the PRD's actual numeric targets, not to assumed scale:
- Event-day search: **p95 under 500ms** at expected single-event scale (PRD §17).
- Dashboard check-in propagation: **within 5 seconds** (PRD §5.7, FR-22).

Use the indexes specified in Section 5 to hit these — verify with an actual query plan against realistic data volume before assuming an index is sufficient; don't guess. Don't add caching layers, read replicas, or other scale infrastructure the PRD doesn't ask for — this is a single-event, moderate-concurrency product, not a high-throughput system.

---

## 16. Real-Time Behaviour

Per PRD §13's explicit decision:
- Public ticket-availability display: **short-interval polling** (5–10s).
- Organiser dashboard check-in counter: **SSE** (one-directional push).
- **WebSockets are not used** — nothing in this product needs bidirectional low-latency interaction. Do not introduce WebSockets because they're available or familiar; that would be an unjustified architecture change requiring an explicit PRD update first.

---

## 17. Testing & Verification

Before declaring any change complete, run the project's actual verification commands (inspect `package.json` once the repo exists — do not assume script names). At minimum, cover:
- Lint, typecheck, build.
- Unit/integration tests for the change.
- Schema/migration validation (constraints actually reject what they should — PRD §16's "rejected invalid inserts" evidence requirement).
- API contract tests (status codes, pagination envelope, auth context).
- Authorization tests (IDOR, cross-event staff-token access, organiser cross-ownership).
- Payment-flow tests: success, failure, pending, duplicate webhook, redirect/webhook disagreement, mid-transaction failure + safe retry (PRD §16's full list).
- Concurrency/idempotency tests: last-unit race, duplicate registration submit, duplicate check-in.

PRD §16/§17 acceptance scenarios should have automated tests wherever practical — a passing build is not evidence a payment-integrity requirement holds; a test that exercises the actual race/duplicate scenario is.

---

## 18. Evidence-Based Completion

For every requirement you implement, be ready to state:
- What changed (in plain terms).
- Which PRD requirement/section it satisfies.
- Which files changed.
- How it was verified (which test, which manual check, which query plan).
- Any remaining `[VERIFY]` or open item it depends on.

Do not report a feature "done" when only part of it is implemented (e.g., the happy path works but the duplicate-webhook case isn't guarded yet) — say exactly what's covered and what isn't.

---

## 19. Change Management

Before a broad change: inspect the existing implementation and conventions, make the smallest coherent change that satisfies the requirement, preserve working behaviour, and avoid unrelated refactors or dependency changes bundled into the same change. Update tests alongside any behaviour change — don't leave them describing the old behaviour.

If the existing implementation conflicts with the PRD, say so explicitly and fix the actual conflict — don't add a workaround layered on top that leaves the underlying inconsistency in place.

---

## 20. Agent Behaviour Checklist

- Inspect before editing.
- Reason about product behaviour before writing code.
- Follow the PRD; when it's silent or ambiguous, say so rather than guessing.
- Reuse existing project patterns and the existing design-token system — never a second one.
- Mark uncertain Flutterwave-specific details `[VERIFY]`; never invent provider behaviour.
- Never weaken security or bypass a database integrity constraint for convenience.
- Never claim unverified work is complete.
- Keep every change focused, and explain it in terms of the requirement it satisfies.

---

## 21. Open Items (must be resolved before/at scaffold time)

1. **Application stack** — not yet chosen. Suggested default (Next.js + TypeScript + Prisma + PostgreSQL, matching this account's other in-flight projects) is a recommendation to confirm, not a decision already made.
2. **Generated token CSS file path** — the build config (`--ds-` prefix, groups) is confirmed; the actual output file path from `scripts/build-tokens.mjs` has not been located yet. Confirm before writing the first component and update Section 11.1 with the real path.
3. **Full token value set** — only the naming/grouping scheme is known so far, not the actual generated `--ds-*` variable names and values (e.g., the specific spacing scale steps, the specific typography sizes). Inspect the generated CSS/JSON report once available and reference concrete token names in this file.
4. **Organiser auth mechanism** (password / magic link / SSO) — PRD §19 leaves this to implementation time.
5. **Staff-token transport** (bearer token / short-lived JWT / session) — PRD §19 leaves this to implementation time.
6. **All Flutterwave `[VERIFY]` items** — verification endpoint, webhook payload/signature scheme, response-time contract, whether post-success reversal is reportable via webhook. Must be checked against current official Flutterwave docs before any payment code is written.
7. **15-minute inventory-hold window** and **phone-required** — PRD v2 resolved these as working defaults; confirm they still hold once real usage patterns are known (PRD §21).

No implementation work should begin on Sections 4 or 11's unresolved parts until items 1–3 above are answered.
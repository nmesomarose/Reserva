-- Organiser authentication + product-owner validation limits (2026-09-26).
--
-- Covers four decisions taken on 2026-09-26:
--
--   1. AUTH      — email + password, server-side session, httpOnly/SameSite=Lax
--                  cookie. This adds the session table the mechanism needs.
--   2. STATUS    — new events always start `draft`; no schema change (the column
--                  default from the init migration already says so).
--   4. VALIDATION— explicit, conservative limits become database invariants.
--   6. TIME      — `programme_items.time` stays nullable; no schema change.
--
-- WHY A SESSION TABLE AT ALL
--
-- PRD §3 L47 and §19 L482 defer the organiser auth *mechanism* while fixing the
-- *model*: "authorised by checking `event.organiser_id == current_user.id`". The
-- chosen mechanism is a server-side session, which by definition needs somewhere
-- server-side to live, so `organiser_sessions` is a required consequence of the
-- decision rather than an additional invented entity. PRD §7.2 tabulates no
-- session table — same situation as `EventEditLog` (see the 20260926000200
-- migration) and recorded the same way, in rule 02's schema-representation
-- decisions.
--
-- Only a HASH of the session token is stored. The plaintext exists in the
-- client's cookie and in this one response, and is never persisted or logged
-- (AGENTS.md §14; the same rule the staff-token design already follows).
--
-- `ON DELETE CASCADE` here, deliberately NOT `RESTRICT` as on `event_edit_logs`:
-- a session is ephemeral authentication state, not evidence. RESTRICTing here
-- would make an organiser undeletable because of a stale login, which is a bug,
-- not an integrity guarantee. The contrast is intentional and is what tells the
-- two apart: audit rows are permanent, sessions are not.

CREATE TABLE "organiser_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organiser_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organiser_sessions_pkey" PRIMARY KEY ("id")
);

-- UNIQUE is what makes session lookup a single-index read AND what makes
-- "generate a token, insert it" safe under a collision race without a SELECT.
-- The token is 32 bytes of CSPRNG output, so a collision is not a real threat;
-- the constraint exists so that a collision is a *rejected write* rather than two
-- sessions sharing one cookie.
CREATE UNIQUE INDEX "organiser_sessions_token_hash_key" ON "organiser_sessions"("token_hash");

ALTER TABLE "organiser_sessions"
    ADD CONSTRAINT "organiser_sessions_organiser_id_fkey"
    FOREIGN KEY ("organiser_id") REFERENCES "organisers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- A session must expire in the future to be stored at all. A zero-length or
-- already-elapsed session would be a row that can never authenticate anything.
ALTER TABLE "organiser_sessions"
    ADD CONSTRAINT "organiser_sessions_expires_in_future_check"
    CHECK ("expires_at" > "created_at");

-- ---------------------------------------------------------------------------
-- Decision 4: explicit validation limits, promoted to database invariants.
-- ---------------------------------------------------------------------------
--
-- PRD §11 specifies no event-field rules; these were a documented placeholder in
-- the validation layer until this decision. AGENTS.md §5 is explicit that "a
-- check that lives only in application code is not a substitute" for a
-- contractual guarantee — so limits that are now product decisions are enforced
-- here as well, and `npm run db:verify-constraints` proves each one rejects the
-- bad write rather than merely existing.
--
-- `char_length` counts characters, not bytes, so a multi-byte name is not
-- penalised. `btrim` mirrors the validation layer, which trims before measuring:
-- without it, a name of 200 spaces would satisfy a length CHECK while the
-- application rejects it as blank, and the database would be quietly disagreeing
-- with the only other rule in the system.

-- description becomes OPTIONAL (decision 4). PRD §7.2 L181 marks it Required, so
-- this is a deliberate, recorded divergence from the PRD's field table — the owner
-- set the limit as "optional" while leaving §7.2 untouched. Reported in the task
-- report so §7.2 can be corrected; not silently absorbed.
ALTER TABLE "events" ALTER COLUMN "description" DROP NOT NULL;

ALTER TABLE "events"
    ADD CONSTRAINT "events_name_length_check"
    CHECK (char_length(btrim("name")) BETWEEN 1 AND 200);

ALTER TABLE "events"
    ADD CONSTRAINT "events_venue_length_check"
    CHECK (char_length(btrim("venue")) BETWEEN 1 AND 300);

ALTER TABLE "events"
    ADD CONSTRAINT "events_description_length_check"
    CHECK ("description" IS NULL OR char_length("description") <= 5000);

ALTER TABLE "events"
    ADD CONSTRAINT "events_slug_length_check"
    CHECK (char_length("slug") BETWEEN 1 AND 200);

-- `ends_at` strictly after `starts_at` (decision 4). The service also checks this
-- against the *merged* row, which application-only checking cannot do: a PATCH
-- that moves only `ends_at` can only be judged against the stored `starts_at`.
-- Having the invariant in both places is what stops a second writer — a seed
-- script, a future admin tool — from writing a zero-length event.
ALTER TABLE "events"
    ADD CONSTRAINT "events_time_order_check"
    CHECK ("ends_at" > "starts_at");

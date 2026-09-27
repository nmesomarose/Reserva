-- TicketType field limits, promoted to database invariants (2026-09-26).
--
-- WHY THIS MIGRATION EXISTS
--
-- The init migration already created `ticket_types` with the two inventory CHECK
-- constraints PRD §7.2 and BR-3 mandate:
--
--   ticket_types_quantity_non_negative_check    (quantity_confirmed >= 0 AND quantity_held >= 0)
--   ticket_types_quantity_within_total_check    (quantity_confirmed + quantity_held <= quantity_total)
--
-- What is missing is the *validation* half. The skill for this slice requires
-- `price_minor_units` (integer >= 0), `currency` (ISO 4217 `string(3)`), and
-- `quantity_total` (integer > 0) to be validated, and AGENTS.md §5 is explicit
-- that "a check that lives only in application code is not a substitute" for a
-- contractual guarantee. Without these, a second writer — a seed script, a
-- psql session, a future admin tool — could store a negative price or a
-- zero-capacity tier that the application's own parser would never produce.
--
-- The same reasoning applied to `events` in migration
-- `20260926000300_auth_and_event_limits` (product-owner decision 4). The ticket
-- field numbers mirror that decision's event numbers deliberately: one convention
-- for the whole schema rather than a second one invented per table. Recorded as
-- product-owner decision 5 — see `.agents/rules/02` and the task report.
--
-- `char_length` counts characters, not bytes, so a multi-byte name is not
-- penalised. `btrim` mirrors the validation layer, which trims before measuring:
-- without it a name of 200 spaces would satisfy the length CHECK while the
-- application rejects it as blank, leaving the database quietly disagreeing with
-- the only other rule in the system.
--
-- All five constraints are NOT VALID-free (i.e. validated against existing rows on
-- apply), so a pre-existing row that violates one fails the migration loudly
-- instead of being grandfathered in.

-- Tier name: required, 1..200 characters after trimming.
-- Mirrors `events_name_length_check`. PRD §7.2 types `name` as Required.
ALTER TABLE "ticket_types"
    ADD CONSTRAINT "ticket_types_name_length_check"
    CHECK (char_length(btrim("name")) BETWEEN 1 AND 200);

-- Tier description: OPTIONAL, <= 5000 characters.
-- Mirrors `events_description_length_check`. PRD §7.2 L205 types `description` as
-- nullable and does not mark it required; the skill lists it as optional.
ALTER TABLE "ticket_types"
    ADD CONSTRAINT "ticket_types_description_length_check"
    CHECK ("description" IS NULL OR char_length("description") <= 5000);

-- Price is integer minor units, never a float (AGENTS.md §5, FR-11). A negative
-- price would be paid by the attendee; the application rejects it and so does the
-- column.
ALTER TABLE "ticket_types"
    ADD CONSTRAINT "ticket_types_price_non_negative_check"
    CHECK ("price_minor_units" >= 0);

-- ISO 4217 alphabetic code, uppercase. The column is already `VARCHAR(3)`, so
-- length is enforced by the type; this adds the *shape*. Uppercase is required
-- rather than normalised away, because ISO 4217 codes are canonically uppercase
-- and a lowercase code would be a silent data-quality defect that the public
-- summary DTO would echo to every attendee.
--
-- NOT a full ISO 4217 registry lookup: the PRD fixes the storage type as
-- `string(3)` and the skill's own "Required output" lists currency handling as a
-- `[VERIFY]`/open item. A hard-coded code list would reject codes the ISO adds and
-- is not requested anywhere. Reported as an open item, not resolved here.
ALTER TABLE "ticket_types"
    ADD CONSTRAINT "ticket_types_currency_iso4217_check"
    CHECK ("currency" ~ '^[A-Z]{3}$');

-- A tier must have at least one unit of capacity, or it can never sell and its
-- availability is permanently false. The skill's step 2 states `quantity_total`
-- is an integer > 0.
--
-- Note this is independent of the two inventory CHECKs from the init migration:
-- `quantity_confirmed + quantity_held <= quantity_total` is satisfied happily by
-- `quantity_total = 0` with both counters at 0.
ALTER TABLE "ticket_types"
    ADD CONSTRAINT "ticket_types_quantity_total_positive_check"
    CHECK ("quantity_total" > 0);

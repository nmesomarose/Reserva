-- ---------------------------------------------------------------------------
-- Fix the guard's ERRCODE quoting - PRD v2 §9.4, §15, AGENTS.md §5.
--
-- `20260927000000_check_in_guards` (and the function body re-declared by
-- `20260927010000_check_in_serialise`) wrote:
--
--   USING ERRCODE = "check_violation";
--
-- In PostgreSQL, double quotes mean *identifier*, not string. So `check_violation`
-- was read as a column name, and every guarded refusal failed with
--
--   ERROR: The column `check_violation` does not exist in the current database.
--
-- instead of raising the intended message. The init migration's own triggers get this
-- right (`USING ERRCODE = 'check_violation'`), which is why every earlier guard worked
-- and only these five were broken.
--
-- Why the bug survived the two migrations and a green build:
--
--   - The application never trips these guards. `PrismaStaffRepository.recordCheckIn`
--     decides eligibility, prior check-in and scope itself, under a row lock, and
--     returns `not_eligible` / `already_checked_in` / `not_found` *before* the insert.
--     So every service and route test passed.
--   - The guards only fire for a write that bypasses the service, which is precisely
--     the case they exist for and precisely the case nothing exercised until
--     `tests/staff.db.test.ts` began writing to the table directly.
--
-- That is AGENTS.md §5's point made concretely: a rule that lives only in application
-- code, and a constraint nothing ever attempts, both look identical to a green test
-- run. This migration does not change any rule — it makes the existing rules raise the
-- right error, and the direct-write tests in `tests/staff.db.test.ts` are what now
-- prove it.
--
-- The condition name is a *string literal* here, single-quoted, matching the init
-- migration. `check_violation` is also the correct choice for the HTTP contract: the
-- adapter maps a CHECK violation to the `409` PRD §15 assigns to a state conflict, so a
-- refusal raised by the database and a refusal raised by the service produce the same
-- status code rather than one of them being a 500.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "guard_check_in_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_event_id UUID;
  -- The enum type is `registration_status` (the `@@map` name), not Prisma's model
  -- name. Comparing a `text` variable against the column instead of declaring the
  -- type keeps this trigger independent of the mapped type name, which is also how
  -- the existing lifecycle triggers in the init migration are written.
  target_status TEXT;
  token_event_id UUID;
BEGIN
  -- Serialise every check-in for this registration before reading anything, so the
  -- reads below are answered against a state no concurrent writer can still change.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."registration_id"::text, 0));

  SELECT r."event_id", r."status"::text
    INTO target_event_id, target_status
    FROM "registrations" r
   WHERE r."id" = NEW."registration_id";

  -- A dangling registration_id cannot happen: `check_ins_registration_id_fkey` is
  -- RESTRICT and runs before this trigger. Treated as ineligible rather than
  -- skipped, so a future change to the FK cannot open a silent path.
  IF target_event_id IS NULL THEN
    RAISE EXCEPTION
      'check-in references registration % which does not exist', NEW."registration_id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- (1) PRD §9.4 / FR-21: eligibility is the storage-layer boundary.
  IF target_status NOT IN ('confirmed', 'checked_in') THEN
    RAISE EXCEPTION
      'registration % is % - not check-in eligible (PRD v2 9.4, FR-21; only confirmed or checked_in are)',
      NEW."registration_id", target_status
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."staff_token_id" IS NOT NULL THEN
    SELECT t."event_id"
      INTO token_event_id
      FROM "staff_tokens" t
     WHERE t."id" = NEW."staff_token_id";

    IF token_event_id IS NULL THEN
      RAISE EXCEPTION
        'check-in references staff token % which does not exist', NEW."staff_token_id"
        USING ERRCODE = 'check_violation';
    END IF;

    -- (2) A staff token's event scope is the ONLY event its holder may act in.
    IF token_event_id <> target_event_id THEN
      RAISE EXCEPTION
        'staff token is scoped to event % but the registration belongs to event % (PRD v2 18, rule 05)',
        token_event_id, target_event_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- (3) An override is only meaningful once a check-in already exists. Skipped when
  -- an organiser acts, because `organiser_id` records who acted, not a tier of
  -- access, and PRD §7.2 ties `is_override` to the check-in sequence rather than to
  -- the actor.
  IF NEW."is_override" AND NOT EXISTS (
        SELECT 1 FROM "check_ins" prior
         WHERE prior."registration_id" = NEW."registration_id"
      ) THEN
    RAISE EXCEPTION
      'check-in marked as an override for registration % but no earlier check-in exists (PRD v2 9.4: an override is a repeat check-in)',
      NEW."registration_id"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

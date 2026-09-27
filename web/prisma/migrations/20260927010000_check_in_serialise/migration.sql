-- ---------------------------------------------------------------------------
-- Check-in serialisation - PRD v2 §9.4, FR-21, §18, rule 07.
--
-- `20260927000000_check_in_guards` added the eligibility, scope and
-- override-meaningfulness checks on INSERT. They are all correct, and all three are
-- decided from `SELECT`s inside the trigger — which is precisely the weakness this
-- migration closes.
--
-- Under READ COMMITTED, a `SELECT` in a trigger sees only *committed* rows. So two
-- transactions that insert a check-in for the same registration at the same moment
-- both read "no prior check-in exists", and both are accepted:
--
--   T1: BEFORE INSERT -> no prior row -> is_override=false accepted -> inserts
--   T2: BEFORE INSERT -> no prior row (T1 uncommitted, invisible) -> accepted too
--
-- The application's `SELECT ... FOR UPDATE` on the registration makes the official
-- path safe, and that is enough for rule 07's requirement about the *guarded write*.
-- But the point of the trigger is to be a backstop for write paths that do not go
-- through the service, and a backstop that can be defeated by two concurrent writers
-- is not one. §9.4 asks for a "database trigger/application-transaction guard" — the
-- trigger half of that is now true on its own.
--
-- The fix is a transaction-scoped advisory lock keyed on the registration id, taken
-- at the top of the trigger. `pg_advisory_xact_lock` is released automatically at
-- commit or rollback, needs no cleanup, and is invisible to every other part of the
-- system. T2 blocks on it until T1 finishes; T1's row is then committed, and T2's
-- re-run of the trigger body sees it — and is refused as an override-without-a-prior
-- or as an ineligible state, exactly as a sequential writer would be.
--
-- Deadlock: none. A transaction can only reach this lock after the FK check on
-- `registration_id`, and the application's own path takes the registration row lock
-- first, so every writer acquires locks in the same order. There is no path that
-- holds this advisory lock and then waits for another registration's.
--
-- Cheaper than it looks: one 8-byte advisory lock per check-in insert, uncontended
-- in the normal case, and a check-in is a write that already costs a row lock and two
-- index updates.
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
  -- Two check-ins of one registration are rare; two *at once* are the race.
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
      USING ERRCODE = "check_violation";
  END IF;

  -- (1) PRD §9.4 / FR-21: eligibility is the storage-layer boundary.
  IF target_status NOT IN ('confirmed', 'checked_in') THEN
    RAISE EXCEPTION
      'registration % is % - not check-in eligible (PRD v2 9.4, FR-21; only confirmed or checked_in are)',
      NEW."registration_id", target_status
      USING ERRCODE = "check_violation";
  END IF;

  IF NEW."staff_token_id" IS NOT NULL THEN
    SELECT t."event_id"
      INTO token_event_id
      FROM "staff_tokens" t
     WHERE t."id" = NEW."staff_token_id";

    IF token_event_id IS NULL THEN
      RAISE EXCEPTION
        'check-in references staff token % which does not exist', NEW."staff_token_id"
        USING ERRCODE = "check_violation";
    END IF;

    -- (2) A staff token's event scope is the ONLY event its holder may act in.
    IF token_event_id <> target_event_id THEN
      RAISE EXCEPTION
        'staff token is scoped to event % but the registration belongs to event % (PRD v2 18, rule 05)',
        token_event_id, target_event_id
        USING ERRCODE = "check_violation";
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
      USING ERRCODE = "check_violation";
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Exactly one first check-in - PRD v2 §4.4.4, §7.4, §9.4, BR-4, rule 07.
--
-- `20260927000000_check_in_guards` enforced one direction of the override rule:
--
--   is_override = true  ->  a prior check-in must exist
--
-- The converse was never enforced, and it is the direction that actually protects the
-- meaning of the log. A second, non-override row for a registration that is already
-- checked in was accepted by the database:
--
--   - eligibility passes (`confirmed` and `checked_in` are both eligible, §9.4);
--   - the actor scope passes (same token, same event);
--   - the override check is skipped, because `is_override` is false.
--
-- So the log could contain two rows that both claim to be the first check-in, and any
-- reading of "when did this attendee arrive" or "how many overrides happened" would be
-- ambiguous. The service prevents it — `recordCheckIn` returns
-- `already_checked_in` and the route answers `409` unless `override` is set — but the
-- trigger is the backstop for the write paths that do not go through the service, and
-- it was not backstopping this.
--
-- This migration adds the missing half as a symmetrical rule:
--
--   is_override = false  ->  no prior check-in may exist
--
-- The two together give the invariant the audit log needs: **exactly one
-- non-override row per registration, and every later row flagged as an override.**
--
-- Read under the advisory lock taken in `20260927010000_check_in_serialise`, so this
-- holds for two concurrent writers and not only for a sequential one. The lock is what
-- makes the `EXISTS` below truthful; without it two transactions would each see an
-- empty history.
--
-- Why a refusal and not a silent correction: the log records decisions, and quietly
-- rewriting a check-in that a door supervisor performed would be the one thing §7.4's
-- append-only rule exists to prevent. A writer that means to check someone in again
-- says so with `is_override = true`, which is the whole point of the column.
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
  prior_check_ins INT;
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

  -- Read once, under the lock above, and use it for both (3) and (4): they are two
  -- readings of the same question — "is this the first check-in, or a later one?".
  SELECT count(*)::int INTO prior_check_ins
    FROM "check_ins" prior
   WHERE prior."registration_id" = NEW."registration_id";

  -- (3) An override is only meaningful once a check-in already exists. Skipped when
  -- an organiser acts, because `organiser_id` records who acted, not a tier of
  -- access, and PRD §7.2 ties `is_override` to the check-in sequence rather than to
  -- the actor.
  IF NEW."is_override" AND prior_check_ins = 0 THEN
    RAISE EXCEPTION
      'check-in marked as an override for registration % but no earlier check-in exists (PRD v2 9.4: an override is a repeat check-in)',
      NEW."registration_id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- (4) The converse, and the direction that makes "when did they arrive" answerable:
  -- a row that does NOT claim to be an override must be the first one. §4.4.4/BR-4
  -- make a repeat check-in an explicit, deliberate act, and `is_override = false` is
  -- the row's claim to being that first act.
  IF NOT NEW."is_override" AND prior_check_ins > 0 THEN
    RAISE EXCEPTION
      'registration % already has % earlier check-in(s) (PRD v2 4.4.4, 9.4: a repeat check-in is a new row with is_override = true)',
      NEW."registration_id", prior_check_ins
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

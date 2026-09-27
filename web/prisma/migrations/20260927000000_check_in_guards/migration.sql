-- ---------------------------------------------------------------------------
-- Check-in insertion guards - PRD v2 9.4, 5.7 (FR-21), 18, rule 07.
--
-- The init migration already made `check_ins` append-only (no UPDATE/DELETE) and
-- made the actor FKs "exactly one of organiser_id / staff_token_id". What it did
-- not do is guard the INSERT itself, and PRD 9.4 asks for that explicitly:
--
--   "Forbidden: a Check-in row being created for a Registration whose current
--    status is not `confirmed` or `checked_in` - enforced at the API layer
--    (FR-21) and ideally as a database trigger/application-transaction guard,
--    not just a UI omission."
--
-- The application layer does enforce it (see `staff.service.ts` /
-- `PrismaStaffRepository.recordCheckIn`, which take `SELECT ... FOR UPDATE` on the
-- registration and read the status inside the same transaction). This migration
-- adds the database half, so the rule survives any future write path that forgets
-- to call the service:
--
--   1. ELIGIBILITY - a Check-in row may only exist for a `confirmed` or
--      `checked_in` registration. This is the mechanism behind FR-21's `409`.
--   2. SCOPE - a staff-actor check-in must be for a registration in the SAME event
--      as the staff token. `check_ins` has no `event_id` column (PRD 7.2 does not
--      grant one), so the guard resolves the event through
--      `registrations.event_id` and compares it to the acting token's own
--      `event_id`. This closes the IDOR shape at the storage layer too: a leaked
--      or forged token cannot record a check-in against another event's
--      registration even if a caller bypasses the service.
--   3. OVERRIDE MEANINGFULITY - `is_override = true` means "this is a check-in
--      after the first" (PRD 7.2, 9.4). An override row with no prior check-in is
--      not a repeat check-in, it is a first check-in mislabelled, which would
--      corrupt the audit reading of "overrides" on the dashboard. Rejected.
--
-- Concurrency: the application takes a row lock on the registration before
-- inserting, so two concurrent check-ins for one registration serialise here, and
-- the second one sees `checked_in` (or an existing check-in row) and is rejected
-- unless it carries an explicit override. Rule 07's requirement - "the read of
-- 'has a non-override check-in already exist?' must be part of the guarded write,
-- not a prior read" - therefore holds at the database, not only in a service
-- method.
--
-- These raise `check_violation` deliberately. The adapter maps a CHECK violation
-- to the `409` PRD 15 assigns to a state conflict, so a refusal here and a refusal
-- in the service produce the same HTTP contract rather than a `500`.
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

  -- (1) PRD 9.4 / FR-21: eligibility is the storage-layer boundary.
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
  -- access, and PRD 7.2 ties `is_override` to the check-in sequence rather than to
  -- the actor. The registration row lock taken by the application makes this read
  -- serialised against any concurrent check-in for the same registration.
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

CREATE TRIGGER "check_ins_insert_guard"
  BEFORE INSERT ON "check_ins"
  FOR EACH ROW
  EXECUTE FUNCTION "guard_check_in_insert"();

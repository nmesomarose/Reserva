-- Corrects the diagnostic precedence of the Registration <-> TicketType event
-- consistency guard added in 20260926000000_init.
--
-- The original guard compared event ids before the foreign keys were checked, so
-- a Registration pointing at a NON-EXISTENT event reported "event_id must match
-- its TicketType.event_id" instead of the true foreign-key violation. The write
-- was still correctly rejected, but the error misdirected the caller.
--
-- This replaces the function in place (CREATE OR REPLACE keeps the same OID, so
-- the existing trigger stays bound to it). An unknown event_id is now left to the
-- foreign key, which produces the accurate error.

CREATE OR REPLACE FUNCTION "check_registration_ticket_type_event"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  tier_event_id uuid;
BEGIN
  SELECT "event_id" INTO tier_event_id
  FROM "ticket_types"
  WHERE "id" = NEW."ticket_type_id";

  -- Unknown ticket_type_id is left to the foreign key to reject.
  IF tier_event_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Unknown event_id is left to the foreign key to reject.
  IF NOT EXISTS (SELECT 1 FROM "events" WHERE "id" = NEW."event_id") THEN
    RETURN NEW;
  END IF;

  IF tier_event_id <> NEW."event_id" THEN
    RAISE EXCEPTION
      'Registration.event_id (%) must match its TicketType.event_id (%)',
      NEW."event_id", tier_event_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

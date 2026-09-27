-- EventEditLog — product-owner decision R-3 (2026-09-26).
--
-- PRD §14 L420 and §20 L501 require organiser edits to a published event to be
-- logged with "what changed, when"; BR-6 (L158) requires being able to answer
-- "why did this change", so a before AND after value is stored per field.
--
-- §7.2 defines no log entity, so this table is an approved addition rather than a
-- transcription of the PRD. Three deliberate choices:
--
--   * `organiser_id` is carried per row rather than derived through the event, so
--     the log records *who* edited. That is the entire purpose of the audit trail.
--   * Both FKs are ON DELETE RESTRICT. A log row is permanent evidence, so
--     neither the event nor its author can be removed out from under it. This is
--     also consistent with §14: events are soft-deleted, never hard-deleted.
--   * Append-only, enforced by triggers exactly as CheckIn is (§9.4). An audit
--     trail that can be edited is not an audit trail.
--
-- `changes` must be a non-empty JSON object. A row recording zero changed fields
-- answers no question and would mean the caller logged a no-op write, so the
-- CHECK turns D6 ("log only fields that actually changed") into a database
-- invariant rather than an application convention.

CREATE TABLE "event_edit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "organiser_id" UUID NOT NULL,
    "changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changes" JSONB NOT NULL,

    CONSTRAINT "event_edit_logs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "event_edit_logs_changes_non_empty_check"
        CHECK (jsonb_typeof("changes") = 'object' AND "changes" <> '{}'::jsonb)
);

CREATE INDEX "event_edit_logs_event_id_changed_at_idx"
    ON "event_edit_logs"("event_id", "changed_at" DESC);

ALTER TABLE "event_edit_logs"
    ADD CONSTRAINT "event_edit_logs_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "events"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "event_edit_logs"
    ADD CONSTRAINT "event_edit_logs_organiser_id_fkey"
    FOREIGN KEY ("organiser_id") REFERENCES "organisers"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Append-only, mirroring guard_check_in_immutability (§9.4).
CREATE OR REPLACE FUNCTION "guard_event_edit_log_immutability"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'event_edit_logs is append-only: rows are never updated or deleted (PRD v2 §14 L420, §20 L501). The audit trail outranks the correction.'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "event_edit_logs_no_update"
  BEFORE UPDATE ON "event_edit_logs"
  FOR EACH ROW
  EXECUTE FUNCTION "guard_event_edit_log_immutability"();

CREATE TRIGGER "event_edit_logs_no_delete"
  BEFORE DELETE ON "event_edit_logs"
  FOR EACH ROW
  EXECUTE FUNCTION "guard_event_edit_log_immutability"();

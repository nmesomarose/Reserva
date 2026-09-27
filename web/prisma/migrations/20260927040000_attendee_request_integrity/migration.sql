-- ---------------------------------------------------------------------------
-- Attendee-request integrity - PRD v2 §5.8, §7.4, §9.5, §12 rows 11-12, §14,
-- §15, §18; FR-23, FR-23a, FR-24; rule 07, rule 08.
--
-- `attendee_requests` was created with §7.2's columns and the one `UNIQUE`
-- constraint §7.2/FR-23a need (`UNIQUE(idempotency_key)`). What the table did
-- NOT have is any guard on the *lifecycle*, and the lifecycle is the whole of
-- §5.8 and §14:
--
--   1. STATUS / TIMESTAMP AGREEMENT. A request is `open` with no `resolved_at`, or
--      `resolved` with one. Both halves were missing, so the database accepted
--      `status = 'resolved', resolved_at = NULL` — a "resolution" with no moment,
--      which is a request the organiser's queue reports as finished and the
--      attendee's record cannot date — and `status = 'open', resolved_at = now()`,
--      which is the reverse: a timestamp claiming a resolution that did not happen.
--      §14 requires the request *and its resolution* to be retained, and a
--      resolution without an instant is not a record of anything.
--
--   2. `resolved` IS TERMINAL. §14 retains a resolution; it does not invite it to
--      be edited. Nothing prevented a `resolved` request being moved back to
--      `open`, or its `resolution_notes` being rewritten, or `resolved_at` being
--      moved to a different day. The service refuses all three with a `409`, but a
--      guard that lives only in a service is a guard that the next write path
--      forgets — the same argument `20260927000000_check_in_guards` makes.
--
--   3. THE IDEMPOTENCY KEY IS IMMUTABLE. FR-23a relies on `idempotency_key`
--      meaning "this client, this submission, forever". A row whose key could be
--      rewritten would let a later request take over an earlier one's identity, and
--      the replay would return the wrong request.
--
--   4. RETENTION. §14 and §7.4 require the row and its resolution to be kept;
--      nobody deletes an attendee request. The init migration made `check_ins`
--      append-only, and this makes the *partially* mutable table append-only
--      except for the two columns that are allowed to change.
--
-- What is deliberately NOT added: a `resolved_by` column. PRD §7.2 does not grant
-- one, §5.8 does not specify who may resolve, and adding a column the PRD does not
-- list is a schema change that needs the approval rule 02 reserves for the owner.
-- The audit gap is real — the actor of a resolution is not recorded — and it is
-- recorded as an open item in `docs/evidence/requirements-matrix.md` rather than
-- quietly resolved here.
--
-- Concurrency: `20260927020000`'s pattern applies. The resolution write in
-- `PrismaAttendeeRequestRepository.recordAttendeeRequestResolution` is a single
-- conditional `UPDATE ... WHERE status = 'open'` in a `READ COMMITTED` transaction, so
-- two organisers resolving at once serialise on the row lock and the second matches no
-- row - which is what lets it report `already_resolved` instead of losing the row to a
-- serialization failure. These triggers back that up for any path that does not go
-- through the service.
-- ---------------------------------------------------------------------------

-- (1) Status/timestamp agreement. Named, not anonymous, so
-- `scripts/verify-db-constraints.mjs` can prove it rejects both bad directions by
-- name rather than by matching a driver's error string.
ALTER TABLE "attendee_requests"
  ADD CONSTRAINT "attendee_requests_status_resolved_at_check"
  CHECK (
    ("status" = 'open'   AND "resolved_at" IS NULL)
    OR
    ("status" = 'resolved' AND "resolved_at" IS NOT NULL)
  );

-- (2)-(4) The lifecycle guard. One trigger function, because all three rules read
-- the same question — "is this update one the product permits?" — and splitting
-- them would mean three trips through the same OLD/NEW comparison.
CREATE OR REPLACE FUNCTION "guard_attendee_request_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- (3) The idempotency key names the submission, not the row's current contents.
  -- Rewriting it would hand one request's identity to another and make a replay
  -- return the wrong message.
  IF NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key" THEN
    RAISE EXCEPTION
      'attendee request % cannot change its idempotency_key (FR-23a: the key identifies the submission)',
      OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- (2) What was asked for is also immutable: a request is what the attendee wrote,
  -- and the organiser's reply belongs in `resolution_notes`, not on top of it.
  IF NEW."message" IS DISTINCT FROM OLD."message" THEN
    RAISE EXCEPTION
      'attendee request % cannot change its message (PRD v2 14: the request and its resolution are both retained)',
      OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- Same reasoning for the registration it was filed against: moving it would
  -- relocate a request to a different attendee's queue, and the organiser who reads
  -- it would be answering somebody else.
  IF NEW."registration_id" IS DISTINCT FROM OLD."registration_id" THEN
    RAISE EXCEPTION
      'attendee request % cannot change its registration_id (rule 05: a request belongs to the registration it names)',
      OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- `created_at` is when the attendee asked. Backdating it would reorder the queue
  -- and misreport how long an organiser took to answer.
  IF NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION
      'attendee request % cannot change its created_at (PRD v2 14: the request is retained as written)',
      OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- (2) `resolved` is terminal, in both directions. Note the asymmetry: resolving
  -- an open request is the *forward* transition and is allowed (it sets
  -- `resolved_at` in the same statement, satisfying the CHECK above), while any
  -- change to a row that is already `resolved` — a reopen, a rewritten note, a
  -- moved timestamp — is refused. A notes-only write on an `open` request is
  -- allowed, because that is the organiser *responding* (FR-24) rather than
  -- resolving, and the two are deliberately distinguishable in the queue.
  IF OLD."status" = 'resolved'::attendee_request_status
     AND (
       NEW."status" IS DISTINCT FROM OLD."status"
       OR NEW."resolution_notes" IS DISTINCT FROM OLD."resolution_notes"
       OR NEW."resolved_at" IS DISTINCT FROM OLD."resolved_at"
     ) THEN
    RAISE EXCEPTION
      'attendee request % is resolved and its resolution is retained unchanged (PRD v2 5.8, 14)',
      OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "attendee_requests_guard_update"
  BEFORE UPDATE ON "attendee_requests"
  FOR EACH ROW
  EXECUTE FUNCTION "guard_attendee_request_update"();

-- (4) Retention. `check_ins` is append-only in the init migration for the same
-- reason: the log is evidence, and an audit trail that can be deleted is not one.
-- This table is *not* fully append-only — a resolution is an update, which is why
-- the trigger above exists — but a request is never removed, and `ON DELETE
-- RESTRICT` on the registration FK already prevents the cascade that would.
CREATE OR REPLACE FUNCTION "forbid_attendee_request_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'attendee requests are retained and cannot be deleted (PRD v2 14)'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "attendee_requests_forbid_delete"
  BEFORE DELETE ON "attendee_requests"
  FOR EACH ROW
  EXECUTE FUNCTION "forbid_attendee_request_delete"();

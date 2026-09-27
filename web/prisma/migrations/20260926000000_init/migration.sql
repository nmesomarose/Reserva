-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "event_status" AS ENUM ('draft', 'published', 'closed');

-- CreateEnum
CREATE TYPE "registration_status" AS ENUM ('pending_payment', 'confirmed', 'checked_in', 'cancelled', 'refunded');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('initiated', 'processing', 'success', 'failed', 'pending');

-- CreateEnum
CREATE TYPE "attendee_request_status" AS ENUM ('open', 'resolved');

-- CreateTable
CREATE TABLE "organisers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "password_hash" TEXT,
    "auth_provider_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organisers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organiser_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "venue" TEXT NOT NULL,
    "status" "event_status" NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "programme_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "time" TIMESTAMPTZ(3),
    "title" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "programme_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_types" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price_minor_units" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "quantity_total" INTEGER NOT NULL,
    "quantity_confirmed" INTEGER NOT NULL DEFAULT 0,
    "quantity_held" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registrations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "ticket_type_id" UUID NOT NULL,
    "unique_reference" TEXT NOT NULL,
    "attendee_name" TEXT NOT NULL,
    "attendee_email" TEXT NOT NULL,
    "attendee_phone" TEXT NOT NULL,
    "status" "registration_status" NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "registration_id" UUID NOT NULL,
    "provider_reference" TEXT NOT NULL,
    "expected_amount_minor_units" INTEGER NOT NULL,
    "verified_amount_minor_units" INTEGER,
    "currency" VARCHAR(3) NOT NULL,
    "status" "payment_status" NOT NULL,
    "verified_at" TIMESTAMPTZ(3),
    "requires_reconciliation" BOOLEAN NOT NULL DEFAULT false,
    "raw_provider_payload" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "check_ins" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "registration_id" UUID NOT NULL,
    "checked_in_at" TIMESTAMPTZ(3) NOT NULL,
    "organiser_id" UUID,
    "staff_token_id" UUID,
    "is_override" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "check_ins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendee_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "registration_id" UUID NOT NULL,
    "message" TEXT NOT NULL,
    "status" "attendee_request_status" NOT NULL,
    "resolution_notes" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),

    CONSTRAINT "attendee_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organisers_email_key" ON "organisers"("email");

-- CreateIndex
CREATE UNIQUE INDEX "events_slug_key" ON "events"("slug");

-- CreateIndex
CREATE INDEX "events_organiser_id_status_idx" ON "events"("organiser_id", "status");

-- CreateIndex
CREATE INDEX "programme_items_event_id_sort_order_idx" ON "programme_items"("event_id", "sort_order");

-- CreateIndex
CREATE INDEX "ticket_types_event_id_idx" ON "ticket_types"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_types_event_id_name_key" ON "ticket_types"("event_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "registrations_unique_reference_key" ON "registrations"("unique_reference");

-- CreateIndex
CREATE UNIQUE INDEX "registrations_idempotency_key_key" ON "registrations"("idempotency_key");

-- CreateIndex
CREATE INDEX "registrations_event_id_attendee_name_idx" ON "registrations"("event_id", "attendee_name");

-- CreateIndex
CREATE INDEX "registrations_event_id_status_idx" ON "registrations"("event_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_reference_key" ON "payments"("provider_reference");

-- CreateIndex
CREATE INDEX "payments_registration_id_idx" ON "payments"("registration_id");

-- CreateIndex
CREATE INDEX "check_ins_registration_id_checked_in_at_idx" ON "check_ins"("registration_id", "checked_in_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "attendee_requests_idempotency_key_key" ON "attendee_requests"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "staff_tokens_token_hash_key" ON "staff_tokens"("token_hash");

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_organiser_id_fkey" FOREIGN KEY ("organiser_id") REFERENCES "organisers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "programme_items" ADD CONSTRAINT "programme_items_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_types" ADD CONSTRAINT "ticket_types_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_ticket_type_id_fkey" FOREIGN KEY ("ticket_type_id") REFERENCES "ticket_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_registration_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "registrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_registration_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "registrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_organiser_id_fkey" FOREIGN KEY ("organiser_id") REFERENCES "organisers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_staff_token_id_fkey" FOREIGN KEY ("staff_token_id") REFERENCES "staff_tokens"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendee_requests" ADD CONSTRAINT "attendee_requests_registration_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "registrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_tokens" ADD CONSTRAINT "staff_tokens_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- RAW SQL INTEGRITY LAYER
--
-- Everything below is a guarantee PRD v2 Â§7 / AGENTS.md Â§5 requires but that
-- Prisma's schema language cannot express: CHECK constraints, a filtered
-- (partial) unique index, and triggers. Prisma will not model, migrate, or
-- introspect these objects, so they are owned by this migration and MUST be
-- carried forward by hand into any future migration that touches these tables.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. TicketType inventory invariants â€” PRD Â§7.2, BR-3.
--    Negative availability must be a REJECTED DATABASE WRITE, not an
--    application bug (rule 03: "Ticket availability lifecycle").
-- ---------------------------------------------------------------------------
ALTER TABLE "ticket_types"
  ADD CONSTRAINT "ticket_types_quantity_within_total_check"
  CHECK ("quantity_confirmed" + "quantity_held" <= "quantity_total");

ALTER TABLE "ticket_types"
  ADD CONSTRAINT "ticket_types_quantity_non_negative_check"
  CHECK ("quantity_confirmed" >= 0 AND "quantity_held" >= 0);

-- ---------------------------------------------------------------------------
-- 2. CheckIn must have exactly one actor.
--    PRD Â§7.2 models this as a single `checked_in_by` "FK -> StaffToken or
--    Organiser", which no single FK column can represent safely. The schema
--    therefore splits it into two nullable FKs (product-owner decision
--    2026-09-26); this constraint is what preserves the original requirement
--    that a check-in is performed by EITHER an organiser OR an event-scoped
--    staff token, and never by neither or both.
-- ---------------------------------------------------------------------------
ALTER TABLE "check_ins"
  ADD CONSTRAINT "check_ins_exactly_one_actor_check"
  CHECK (("organiser_id" IS NOT NULL) <> ("staff_token_id" IS NOT NULL));

-- ---------------------------------------------------------------------------
-- 3. At most one successful Payment per Registration.
--    PRD Â§7.3 makes Payment 1:N with Registration; AGENTS.md Â§5 states "only one
--    may reach `success`". A partial UNIQUE index is the database-level
--    enforcement of that invariant. This is an INTEGRITY constraint, not a
--    performance index - it is deliberately filtered so that failed/pending
--    attempts are unconstrained.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "payments_one_success_per_registration_idx"
  ON "payments" ("registration_id")
  WHERE "status" = 'success';

-- ---------------------------------------------------------------------------
-- 4. Cross-entity referential integrity: a Registration's event must be the
--    same event as its TicketType's.
--    NOT stated in PRD Â§7.2. Added because PRD Â§3/Â§18 and rule 05 make every
--    authorisation decision event-scoped: a Registration whose event_id and
--    ticket_type.event_id disagree would silently appear under one event while
--    being paid for another, breaking event-scoped staff search (FR-18) and the
--    organiser ownership check. Cheap, safe, and expressible. Flagged for review.
-- ---------------------------------------------------------------------------
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

CREATE TRIGGER "registration_ticket_type_event_guard"
  BEFORE INSERT OR UPDATE OF "event_id", "ticket_type_id" ON "registrations"
  FOR EACH ROW
  EXECUTE FUNCTION "check_registration_ticket_type_event"();

-- ---------------------------------------------------------------------------
-- 5. Forbidden lifecycle transitions - PRD Â§9, AGENTS.md Â§5.
--    "Forbidden transitions are enforced, not merely documented."
--
--    These triggers implement the denylist the PRD states EXPLICITLY. They
--    deliberately do not impose a strict allowlist: enumerating every legal
--    transition at the database level would encode product behaviour the PRD
--    does not specify. The broader allowlist belongs in application transaction
--    guards, which AGENTS.md Â§5 requires "at minimum".
--
--    A no-op write (OLD = NEW) is always permitted so idempotent retries and
--    redelivery remain safe.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "guard_registration_status_transition"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status" = OLD."status" THEN
    RETURN NEW;
  END IF;

  -- PRD Â§9.2: Forbidden - CANCELLED -> CONFIRMED, and CANCELLED/REFUNDED ->
  -- CHECKED_IN. Preserved verbatim by product-owner decision 2026-09-26
  -- (rule 03 R-2): a late successful webhook sets Payment.status = success and
  -- sets requires_reconciliation, and leaves Registration.status at CANCELLED.
  IF OLD."status" IN ('cancelled', 'refunded')
     AND NEW."status" IN ('confirmed', 'checked_in') THEN
    RAISE EXCEPTION
      'forbidden Registration.status transition % -> % (PRD v2 Â§9.2)',
      OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  -- PRD Â§9.2: Forbidden - CHECKED_IN -> PENDING_PAYMENT (no backward moves).
  IF OLD."status" = 'checked_in' AND NEW."status" = 'pending_payment' THEN
    RAISE EXCEPTION
      'forbidden Registration.status transition % -> % (PRD v2 Â§9.2: no backward transitions)',
      OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "registration_status_transition_guard"
  BEFORE UPDATE OF "status" ON "registrations"
  FOR EACH ROW
  EXECUTE FUNCTION "guard_registration_status_transition"();

CREATE OR REPLACE FUNCTION "guard_payment_status_transition"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status" = OLD."status" THEN
    RETURN NEW;
  END IF;

  -- PRD Â§9.1: Forbidden - FAILED -> SUCCESS on the same row. A new Payment row
  -- must be created instead (Payment is 1:N with Registration).
  --
  -- Note the interaction with rule 03 R-2: a late webhook may only move an
  -- UNRESOLVED attempt (initiated/processing/pending) to success. If the attempt
  -- was already `failed`, this trigger correctly rejects it and the case must be
  -- handled as reconciliation rather than as a successful confirmation.
  IF OLD."status" = 'failed' AND NEW."status" = 'success' THEN
    RAISE EXCEPTION
      'forbidden Payment.status transition % -> % on the same row (PRD v2 §9.1); create a new Payment row instead',
      OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "payment_status_transition_guard"
  BEFORE UPDATE OF "status" ON "payments"
  FOR EACH ROW
  EXECUTE FUNCTION "guard_payment_status_transition"();

-- ---------------------------------------------------------------------------
-- 6. CheckIn is append-only - PRD Â§9.4 ("append-only") and Â§14 ("Existing
--    Check-in rows are never updated or deleted"), rule 02:28-29.
--    A repeat check-in is a NEW row with is_override = true, never an edit.
--    Enforced at the database so the audit log cannot be rewritten in place.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "guard_check_in_immutability"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'check_ins is append-only: rows are never updated or deleted (PRD v2 Â§9.4, Â§14). Insert a new row with is_override = true instead.'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "check_ins_no_update"
  BEFORE UPDATE ON "check_ins"
  FOR EACH ROW
  EXECUTE FUNCTION "guard_check_in_immutability"();

CREATE TRIGGER "check_ins_no_delete"
  BEFORE DELETE ON "check_ins"
  FOR EACH ROW
  EXECUTE FUNCTION "guard_check_in_immutability"();

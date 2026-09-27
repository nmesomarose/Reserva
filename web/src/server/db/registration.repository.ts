/**
 * Prisma implementation of the registration and payment persistence port.
 *
 * This adapter is the ONLY place that knows both Prisma and the domain's
 * registration types. Its job is mapping, not rules: every guard below exists
 * because a column, a CHECK, or an atomicity requirement in the port demands it.
 *
 * ## The three things this file is really about
 *
 * 1. **The idempotency index is the arbiter** (FR-10a, PRD §12, rule 07). A
 *    pre-flight "does this key exist?" read would be a check-then-act race, so a
 *    duplicate insert is *expected* and is translated into a replay rather than
 *    suppressed. See {@link PrismaRegistrationRepository.createPendingRegistration}.
 * 2. **The hold is a conditional statement**, never a read-then-write
 *    (rule 07, PRD §10's last-unit race). `PrismaTicketTypeRepository` already owns
 *    that SQL, so this adapter reuses it rather than copying it.
 * 3. **§8.5 is one transaction with a row lock.** Duplicate webhook delivery is
 *    normal (the provider documents it), so the confirmation path takes
 *    `SELECT … FOR UPDATE` on the attempt before deciding anything. Without the
 *    lock, two concurrent deliveries would both read `initiated`, both move a
 *    counter, and the second would be misdiagnosed as a lost hold.
 */

import "server-only";

import {
  Prisma,
  type Payment as PrismaPaymentModel,
  type Registration as PrismaRegistrationModel,
} from "@/generated/prisma/client";

import { ConflictError, NotFoundError } from "@/domain/errors";
import { requireChargeableTierPricing } from "@/domain/payments/currency-units";
import type { TicketTypeRecord } from "@/domain/events/event";
import type {
  PaymentStatus,
  PaymentRecord,
  RegistrationRecord,
} from "@/domain/registrations/registration";
import {
  HoldLostError,
  type CreatePendingRegistrationInput,
  type FlagReconciliationInput,
  type PaymentResolution,
  type RegistrationCreation,
  type RegistrationRepository,
  type ResolveVerifiedPaymentInput,
} from "@/domain/registrations/registration.repository";
import { generateUniqueReference } from "@/domain/registrations/reference";
import {
  TIER_NOT_ON_EVENT_MESSAGE,
  TIER_UNAVAILABLE_MESSAGE,
} from "@/domain/registrations/registration.service";

import { PrismaTicketTypeRepository } from "./ticket-type.repository";

const UNIQUE_VIOLATION = "P2002";

/**
 * The two `registrations` unique indexes, by name.
 *
 * Named separately because they mean opposite things: a collision on the
 * idempotency key is a **legitimate replay** to be answered with the original
 * result, while a collision on the generated reference is an astronomical accident
 * that must never be answered with somebody else's row.
 */
const IDEMPOTENCY_KEY_CONSTRAINT = "registrations_idempotency_key_key";
const UNIQUE_REFERENCE_CONSTRAINT = "registrations_unique_reference_key";

/**
 * One retry for a `unique_reference` collision.
 *
 * At 256 bits this is vanishingly unlikely, so this is not about the odds — it is
 * about the consequence. Without the retry, a collision would be indistinguishable
 * from a replay and the second attendee would be handed the first one's
 * registration and reference. Two attempts is enough to make that impossible while
 * still failing loudly rather than looping.
 */
const REFERENCE_COLLISION_ATTEMPTS = 2;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

/** Every string in the error's nesting, joined, so a constraint name can be found. */
function errorText(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return "";
  }

  const outer = "message" in error ? String((error as { message?: unknown }).message ?? "") : "";
  const meta = (error as { meta?: { driverAdapterError?: unknown } }).meta;
  const adapterCause = (
    meta?.driverAdapterError as { cause?: { originalMessage?: unknown } } | undefined
  )?.cause;

  return [outer, String(adapterCause?.originalMessage ?? "")].join("\n");
}

/**
 * The name of the unique index PostgreSQL rejected, or `null`.
 *
 * Read out of the driver's message rather than `meta.target`, because the pg driver
 * adapter Prisma 7 runs on does not populate `target` the same way the old Rust
 * engine did — the same technique `ticket-type.repository.ts` uses for CHECK names.
 */
function violatedUniqueConstraint(error: unknown): string | null {
  if (!isUniqueViolation(error)) {
    return null;
  }

  const match = /violates unique constraint "([^"]+)"/.exec(errorText(error));

  return match?.[1] ?? null;
}

function toRegistrationRecord(model: PrismaRegistrationModel): RegistrationRecord {
  return {
    id: model.id,
    eventId: model.eventId,
    ticketTypeId: model.ticketTypeId,
    uniqueReference: model.uniqueReference,
    attendeeName: model.attendeeName,
    attendeeEmail: model.attendeeEmail,
    attendeePhone: model.attendeePhone,
    status: model.status as RegistrationRecord["status"],
    idempotencyKey: model.idempotencyKey,
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
  };
}

function toPaymentRecord(model: PrismaPaymentModel): PaymentRecord {
  return {
    id: model.id,
    registrationId: model.registrationId,
    providerReference: model.providerReference,
    expectedAmountMinorUnits: model.expectedAmountMinorUnits,
    verifiedAmountMinorUnits: model.verifiedAmountMinorUnits,
    currency: model.currency,
    status: model.status as PaymentStatus,
    verifiedAt: model.verifiedAt,
    requiresReconciliation: model.requiresReconciliation,
    rawProviderPayload: model.rawProviderPayload,
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
  };
}

/** Columns of `registrations`, aliased to the domain's names for raw reads. */
const REGISTRATION_COLUMNS = `
  "id"                AS "id",
  "event_id"          AS "eventId",
  "ticket_type_id"    AS "ticketTypeId",
  "unique_reference"  AS "uniqueReference",
  "attendee_name"     AS "attendeeName",
  "attendee_email"    AS "attendeeEmail",
  "attendee_phone"    AS "attendeePhone",
  "status"            AS "status",
  "idempotency_key"   AS "idempotencyKey",
  "created_at"        AS "createdAt",
  "updated_at"        AS "updatedAt"
`;

interface RegistrationRow {
  readonly id: string;
  readonly eventId: string;
  readonly ticketTypeId: string;
  readonly uniqueReference: string;
  readonly attendeeName: string;
  readonly attendeeEmail: string;
  readonly attendeePhone: string;
  readonly status: RegistrationRecord["status"];
  readonly idempotencyKey: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function fromRegistrationRow(row: RegistrationRow): RegistrationRecord {
  return { ...row };
}

/** Columns of `payments`, aliased to the domain's names for raw reads. */
const PAYMENT_COLUMNS = `
  "id"                          AS "id",
  "registration_id"             AS "registrationId",
  "provider_reference"          AS "providerReference",
  "expected_amount_minor_units" AS "expectedAmountMinorUnits",
  "verified_amount_minor_units" AS "verifiedAmountMinorUnits",
  "currency"                    AS "currency",
  "status"                      AS "status",
  "verified_at"                 AS "verifiedAt",
  "requires_reconciliation"     AS "requiresReconciliation",
  "raw_provider_payload"        AS "rawProviderPayload",
  "created_at"                  AS "createdAt",
  "updated_at"                  AS "updatedAt"
`;

interface PaymentRow {
  readonly id: string;
  readonly registrationId: string;
  readonly providerReference: string;
  readonly expectedAmountMinorUnits: number;
  readonly verifiedAmountMinorUnits: number | null;
  readonly currency: string;
  readonly status: PaymentStatus;
  readonly verifiedAt: Date | null;
  readonly requiresReconciliation: boolean;
  readonly rawProviderPayload: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function fromPaymentRow(row: PaymentRow): PaymentRecord {
  return { ...row };
}

export class PrismaRegistrationRepository implements RegistrationRepository {
  /**
   * Typed as the transaction client so the SAME class serves the pool-backed handle
   * and a handle scoped to an open transaction — identical to the event and
   * ticket-type adapters, so `transact` cannot drift from theirs.
   */
  constructor(private readonly prisma: Prisma.TransactionClient) {}

  async transact<T>(work: (repository: RegistrationRepository) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => work(new PrismaRegistrationRepository(tx)));
  }

  /**
   * The tier repository, bound to *this* handle.
   *
   * Built per call rather than held as a field because inside a transaction it must
   * share that transaction's handle. Sharing it is what makes the hold and the
   * registration insert one unit of work; a second, pool-backed instance would take
   * its lock on a different connection and the two writes would not be atomic.
   */
  private tiers(): PrismaTicketTypeRepository {
    return new PrismaTicketTypeRepository(this.prisma);
  }

  async createPendingRegistration(
    input: CreatePendingRegistrationInput,
  ): Promise<RegistrationCreation> {
    for (let attempt = 1; attempt <= REFERENCE_COLLISION_ATTEMPTS; attempt += 1) {
      // A fresh reference on the retry, and only on the retry: the first attempt must
      // use exactly the reference the caller generated so a replay can be matched.
      const uniqueReference =
        attempt === 1 ? input.uniqueReference : generateUniqueReference();

      try {
        return await this.createPendingRegistrationOnce({ ...input, uniqueReference });
      } catch (error) {
        const constraint = violatedUniqueConstraint(error);

        if (constraint === IDEMPOTENCY_KEY_CONSTRAINT) {
          // The `UNIQUE(idempotency_key)` index is the arbiter (FR-10a, rule 07). A
          // duplicate insert *blocks* in PostgreSQL until the winning transaction
          // resolves, so by the time this error arrives the original row is committed
          // and visible: no polling loop is needed, and re-reading is correct.
          //
          // Read on the POOL handle, not on a transaction — the losing transaction was
          // rolled back and its handle is unusable.
          const existing = await this.findRegistrationByIdempotencyKey(
            input.command.idempotencyKey,
          );

          if (existing !== null) {
            return {
              outcome: "replayed",
              registration: existing,
              payment: await this.findLatestPayment(existing.id),
            };
          }

          // The winner rolled back between the block and our re-read. Not reachable
          // through any write this product makes, but answering it by retrying the
          // insert is strictly better than surfacing a constraint error as a 500.
          continue;
        }

        if (constraint === UNIQUE_REFERENCE_CONSTRAINT) {
          // Astronomically unlikely at 256 bits, and emphatically NOT a replay.
          // Retrying with a fresh reference is the only safe answer: treating this as
          // an idempotency replay would hand one attendee another's registration.
          continue;
        }

        throw error;
      }
    }

    throw new ConflictError(
      "The registration could not be created because its reference collided twice. " +
        "Please try again.",
    );
  }

  /**
   * One attempt at the three writes, in one transaction.
   *
   * Order matters and is not arbitrary: the registration row is inserted **first**
   * so the `idempotency_key` index can arbitrate a concurrent duplicate *before* any
   * inventory is touched. If the hold were taken first, a losing duplicate would
   * have briefly consumed a unit and then had to give it back — two writes to fix a
   * problem the ordering makes disappear.
   */
  private async createPendingRegistrationOnce(
    input: CreatePendingRegistrationInput,
  ): Promise<RegistrationCreation> {
    return this.prisma.$transaction(async (tx) => {
      const tiers = new PrismaTicketTypeRepository(tx);

      // Re-read the tier INSIDE the transaction and charge *its* price (FR-11).
      //
      // The service read it a moment ago to check availability, but an organiser can
      // edit `price_minor_units` in the gap. Taking the amount from the caller's copy
      // would let a price change race through to the charge; taking it from the row
      // means the amount charged is the one in force when the hold was taken. This is
      // also the last chance to refuse an unrepresentable price before any row exists
      // — the same pure functions the service pre-checked with, so the two cannot
      // disagree.
      const tier = await tiers.findTicketTypeById(input.command.ticketTypeId);

      // A miss and a cross-event tier are one answer, and it is the service's own
      // message: the service's pre-check raises this exact condition before it gets
      // here, so a tier deleted or moved between its read and this one must not be
      // reported as something new. It also keeps an anonymous attendee from mapping
      // one event's tiers by their error codes (R-3's anti-enumeration rule, applied
      // to the purchase path).
      if (tier === null || tier.eventId !== input.eventId) {
        throw new NotFoundError(TIER_NOT_ON_EVENT_MESSAGE);
      }

      // R-6 again, on the row as it stands *now*. The service checked the same tier
      // moments ago, but this transaction re-read it and the price may have been
      // edited in the gap — so what has to hold is "the amount about to be written is
      // chargeable", not "the amount the service saw was".
      requireChargeableTierPricing(tier.currency, tier.priceMinorUnits);

      const registration = await tx.registration.create({
        data: {
          eventId: input.eventId,
          ticketTypeId: input.command.ticketTypeId,
          uniqueReference: input.uniqueReference,
          attendeeName: input.command.attendeeName,
          attendeeEmail: input.command.attendeeEmail,
          attendeePhone: input.command.attendeePhone,
          // `pending_payment` and never `confirmed` (skill step 4, BR-1, FR-9): this
          // row is not a ticket until a verified payment says so.
          status: "pending_payment",
          idempotencyKey: input.command.idempotencyKey,
        },
      });

      // §9.3 AVAILABLE -> HELD. One conditional statement, so two callers racing the
      // last unit cannot both succeed (rule 07, PRD §10). `null` means the guard did
      // not hold, and the throw rolls the registration insert back with it — no
      // half-created row, which is the skill's step 5 requirement.
      const held = await tiers.holdInventory(registration.ticketTypeId, 1);

      if (held === null) {
        throw new ConflictError(TIER_UNAVAILABLE_MESSAGE);
      }

      const payment = await tx.payment.create({
        data: {
          registrationId: registration.id,
          // Our own `tx_ref` (see `reference.ts` for why, not the provider's
          // `flw_ref`). Committed here, BEFORE the network call, so a provider
          // timeout leaves a resolvable row rather than no trace at all.
          providerReference: input.providerReference,
          expectedAmountMinorUnits: tier.priceMinorUnits,
          currency: tier.currency,
          // `initiated`, never `success` (skill step 7): the money has not moved.
          status: "initiated",
          verifiedAmountMinorUnits: null,
          verifiedAt: null,
          requiresReconciliation: false,
        },
      });

      return {
        outcome: "created" as const,
        registration: toRegistrationRecord(registration),
        payment: toPaymentRecord(payment),
      };
    });
  }

  async findRegistrationByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<RegistrationRecord | null> {
    const found = await this.prisma.registration.findUnique({ where: { idempotencyKey } });

    return found === null ? null : toRegistrationRecord(found);
  }

  async findRegistrationById(id: string): Promise<RegistrationRecord | null> {
    const found = await this.prisma.registration.findUnique({ where: { id } });

    return found === null ? null : toRegistrationRecord(found);
  }

  async findRegistrationByReference(uniqueReference: string): Promise<RegistrationRecord | null> {
    const found = await this.prisma.registration.findUnique({ where: { uniqueReference } });

    return found === null ? null : toRegistrationRecord(found);
  }

  /**
   * The newest attempt for a registration.
   *
   * Ordered by `created_at DESC, id DESC` so the ordering is total. Two attempts
   * created in the same millisecond would otherwise be returned in an arbitrary
   * order and "the latest" would not be well defined — which matters because
   * `POST /payments/initiate` hands back the link of whatever this returns.
   */
  async findLatestPayment(registrationId: string): Promise<PaymentRecord | null> {
    const found = await this.prisma.payment.findFirst({
      where: { registrationId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });

    return found === null ? null : toPaymentRecord(found);
  }

  async findRegistrationTier(registration: RegistrationRecord): Promise<TicketTypeRecord> {
    const found = await this.tiers().findTicketTypeById(registration.ticketTypeId);

    if (found === null) {
      // `Registration.ticket_type_id` is `RESTRICT`, so this is unreachable through
      // any write this product makes. Surfaced as a conflict rather than a crash,
      // because the alternative is a `500` on a path that must not have one.
      throw new ConflictError("The ticket tier for this registration no longer exists.");
    }

    return found;
  }

  async findPaymentByProviderReference(
    providerReference: string,
  ): Promise<PaymentRecord | null> {
    const found = await this.prisma.payment.findUnique({ where: { providerReference } });

    return found === null ? null : toPaymentRecord(found);
  }

  /**
   * §9.3 `HELD -> AVAILABLE`, reused from the tier adapter so the guard SQL has one
   * definition in the codebase.
   */
  async releaseHeldInventory(
    ticketTypeId: string,
    quantity: number,
  ): Promise<TicketTypeRecord | null> {
    return this.tiers().releaseInventory(ticketTypeId, quantity);
  }

  /**
   * Cancel a registration only while it is `pending_payment`.
   *
   * One conditional `UPDATE`, so the sweep and a concurrent confirmation cannot both
   * believe they won: whoever's statement matches second gets zero rows and returns
   * `null`, and the caller then leaves the hold alone. A read-then-write pair here
   * would let both proceed and release stock twice.
   */
  async cancelRegistrationIfPending(
    registrationId: string,
  ): Promise<RegistrationRecord | null> {
    const rows = await this.prisma.$queryRaw<RegistrationRow[]>`
      UPDATE "registrations"
         SET "status" = 'cancelled',
             "updated_at" = now()
       WHERE "id" = ${registrationId}::uuid
         AND "status" = 'pending_payment'
      RETURNING ${Prisma.raw(REGISTRATION_COLUMNS)}
    `;

    return rows[0] === undefined ? null : fromRegistrationRow(rows[0]);
  }

  async openPaymentAttempt(input: {
    readonly registrationId: string;
    readonly providerReference: string;
    readonly expectedAmountMinorUnits: number;
    readonly currency: string;
  }): Promise<PaymentRecord> {
    return this.prisma.$transaction(async (tx) => {
      const tiers = new PrismaTicketTypeRepository(tx);

      // Re-derive the amount from the tier rather than trusting the caller, for the
      // same reason `createPendingRegistrationOnce` does: the price may have changed
      // since the service read it, and a retry must charge the current price. Read
      // through the tier adapter so the returned row is a `TicketTypeRecord` and this
      // file keeps no second copy of that mapping.
      const registration = await tx.registration.findUnique({
        where: { id: input.registrationId },
        select: { ticketTypeId: true, status: true },
      });

      if (registration === null) {
        throw new ConflictError("The registration for this payment no longer exists.");
      }

      if (registration.status !== "pending_payment") {
        throw new ConflictError(
          "This registration is no longer awaiting payment, so no new attempt can be opened.",
        );
      }

      const tier = await tiers.findTicketTypeById(registration.ticketTypeId);

      if (tier === null) {
        throw new ConflictError("The ticket tier for this registration no longer exists.");
      }

      requireChargeableTierPricing(tier.currency, tier.priceMinorUnits);

      const created = await tx.payment.create({
        data: {
          registrationId: input.registrationId,
          providerReference: input.providerReference,
          expectedAmountMinorUnits: tier.priceMinorUnits,
          currency: tier.currency,
          status: "initiated",
          verifiedAmountMinorUnits: null,
          verifiedAt: null,
          requiresReconciliation: false,
        },
      });

      return toPaymentRecord(created);
    });
  }

  /**
   * Persist the provider's initiate response.
   *
   * Deliberately a separate call from the insert that created the row: the provider
   * call is network I/O with a documented 28-second timeout, and holding a database
   * transaction open across it is how a connection pool is exhausted. Storing the
   * response is also what lets a replayed `idempotency_key` return its original
   * hosted link instead of minting a second one.
   */
  async recordProviderPayload(paymentId: string, payload: unknown): Promise<PaymentRecord> {
    const updated = await this.prisma.payment.update({
      where: { id: paymentId },
      data: { rawProviderPayload: payload as Prisma.InputJsonValue, updatedAt: new Date() },
    });

    return toPaymentRecord(updated);
  }

  async markPaymentFailed(paymentId: string, payload: unknown): Promise<PaymentRecord> {
    return this.setStatusUnlessResolved(paymentId, "failed", payload);
  }

  /**
   * Write a non-terminal status onto an attempt **only while it is unresolved**.
   *
   * One shared statement for `failed` and `pending`, because the guard is identical
   * and the reason is the same in both cases: the service decided this status from a
   * read it took *before* the write, so a webhook that confirmed the attempt in the
   * gap has already moved it to `success` — and an unconditional `update` here would
   * walk it backwards. The partial unique index guards two successes; this guards
   * the reverse race, and it is the only thing standing between a duplicate delivery
   * and a lost ticket.
   *
   * `failed -> success` is separately forbidden by §9.1's trigger, so excluding
   * `failed` as well is belt-and-braces against a *pending* delivery arriving after a
   * terminal failure. The resolved row is returned unchanged rather than hidden, so
   * the caller still sees that the money was confirmed and can say so.
   */
  private async setStatusUnlessResolved(
    paymentId: string,
    status: "failed" | "pending",
    payload: unknown,
  ): Promise<PaymentRecord> {
    const rows = await this.prisma.$queryRaw<PaymentRow[]>`
      UPDATE "payments"
         SET "status" = ${status},
             "raw_provider_payload" = ${payload as Prisma.InputJsonValue},
             "updated_at" = now()
       WHERE "id" = ${paymentId}::uuid
         AND "status" NOT IN ('success', 'failed')
      RETURNING ${Prisma.raw(PAYMENT_COLUMNS)}
    `;

    if (rows[0] !== undefined) {
      return fromPaymentRow(rows[0]);
    }

    const current = await this.findPaymentById(paymentId);

    if (current === null) {
      throw new ConflictError("The payment attempt no longer exists.");
    }

    return current;
  }

  async markPaymentPending(paymentId: string, payload: unknown): Promise<PaymentRecord> {
    return this.setStatusUnlessResolved(paymentId, "pending", payload);
  }

  private async findPaymentById(paymentId: string): Promise<PaymentRecord | null> {
    const found = await this.prisma.payment.findUnique({ where: { id: paymentId } });

    return found === null ? null : toPaymentRecord(found);
  }

  /**
   * §8.5: mark the attempt `success`, assert the amount, `quantity_confirmed` up,
   * `quantity_held` down, `Registration.status = confirmed`. **All five, or none.**
   *
   * ## Why the `FOR UPDATE` lock is load-bearing
   *
   * The provider documents that it "might send the same webhook event more than
   * once", so two deliveries of one success is an expected condition, not an
   * anomaly. Without the lock both transactions read `initiated`, both proceed to
   * move inventory, and the loser — finding `quantity_held` already decremented —
   * would be misdiagnosed as a lost hold and *flagged for reconciliation*, i.e. a
   * duplicate delivery would manufacture a payment that looks suspicious to a human.
   *
   * With the lock the second delivery blocks, then re-reads and observes `success`,
   * returning `confirmedNow: false` and applying nothing. That is the whole
   * duplicate-delivery guarantee, and it is why this is a lock and not a
   * `SELECT`-then-`UPDATE`.
   *
   * ## Why a lost hold throws instead of returning
   *
   * A `null` from the conditional inventory statement means the 15-minute hold was
   * released while the payment was in flight. The money has moved, so this must not
   * be reported as a failure, and the confirmation must not be half-applied. Throwing
   * rolls the whole transaction back; the caller then records the verified success
   * with `requires_reconciliation` (R-1/R-2's handling) and the attendee is told
   * reconciliation rather than failure (§17).
   */
  async resolveVerifiedPayment(input: ResolveVerifiedPaymentInput): Promise<PaymentResolution> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<PaymentRow[]>`
        SELECT ${Prisma.raw(PAYMENT_COLUMNS)}
          FROM "payments"
         WHERE "id" = ${input.paymentId}::uuid
         FOR UPDATE
      `;

      const payment = locked[0];

      if (payment === undefined) {
        throw new ConflictError("The payment attempt no longer exists.");
      }

      const registrationRows = await tx.$queryRaw<RegistrationRow[]>`
        SELECT ${Prisma.raw(REGISTRATION_COLUMNS)}
          FROM "registrations"
         WHERE "id" = ${input.registrationId}::uuid
         FOR UPDATE
      `;

      const registration = registrationRows[0];

      if (registration === undefined) {
        throw new ConflictError("The registration for this payment no longer exists.");
      }

      // Idempotence, observed under the lock. A no-op write is also permitted by the
      // database's transition guard, but deciding here is what lets a repeat
      // delivery report `confirmedNow: false` instead of trying to re-apply.
      if (payment.status === "success" || payment.status === "failed") {
        return { payment, registration, confirmedNow: false };
      }

      // Step 1: the attempt is `success` (steps 2's amount assertion is enforced
      // above it, in the service, before this transaction is entered).
      const succeeded = await tx.payment.update({
        where: { id: input.paymentId },
        data: {
          status: "success",
          verifiedAmountMinorUnits: input.verifiedAmountMinorUnits,
          verifiedAt: input.verifiedAt,
          rawProviderPayload: input.payload as Prisma.InputJsonValue,
          updatedAt: input.verifiedAt,
        },
      });

      // Steps 3 and 4 as ONE statement. Two statements would open a window in which
      // the units are counted as neither held nor confirmed — i.e. double-sellable —
      // and the sum CHECK cannot catch it, because the total is unchanged throughout.
      const tiers = new PrismaTicketTypeRepository(tx);
      const confirmed = await tiers.confirmInventory(input.ticketTypeId, 1);

      if (confirmed === null) {
        throw new HoldLostError(input.ticketTypeId);
      }

      // Step 5. §9.2's guard permits `pending_payment -> confirmed`; the forbidden
      // directions (`cancelled -> confirmed`) are refused by the trigger, which is the
      // backstop for any path that forgot to check.
      const confirmedRegistration = await tx.registration.update({
        where: { id: input.registrationId },
        data: { status: "confirmed", updatedAt: input.verifiedAt },
      });

      return {
        payment: toPaymentRecord(succeeded),
        registration: toRegistrationRecord(confirmedRegistration),
        confirmedNow: true,
      };
    });
  }

  /**
   * Record that value is being withheld from a human review (R-1).
   *
   * The attempt's `status` is deliberately left alone. In these cases the platform has
   * not established a verified success, so writing `success` would be a claim it
   * cannot support — and §10's "Payment row (already `success`)" is only useful as a
   * queue filter if `success` continues to mean *verified*.
   */
  async flagPaymentForReconciliation(input: FlagReconciliationInput): Promise<PaymentRecord> {
    const updated = await this.prisma.payment.update({
      where: { id: input.paymentId },
      data: {
        requiresReconciliation: true,
        // Only overwrite a verified amount we do not already have. A second delivery
        // of a flagged payment re-sends the same facts, and blanking the recorded
        // amount would destroy the evidence for whoever reviews it.
        ...(input.verifiedAmountMinorUnits === null
          ? {}
          : { verifiedAmountMinorUnits: input.verifiedAmountMinorUnits }),
        ...(input.verifiedAt === null ? {} : { verifiedAt: input.verifiedAt }),
        rawProviderPayload: input.payload as Prisma.InputJsonValue,
        updatedAt: new Date(),
      },
    });

    return toPaymentRecord(updated);
  }

  /**
   * R-2: a verified success that must not confirm anything.
   *
   * Moves the attempt to `success` — the money did move, and §8.6 makes the webhook
   * authoritative about that — while touching neither `Registration.status` nor
   * either tier counter. The `cancelled -> confirmed` prohibition of §9.2 stays
   * intact because this method never writes a registration at all.
   */
  async recordUnclaimableSuccess(input: FlagReconciliationInput): Promise<PaymentRecord> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<PaymentRow[]>`
        SELECT ${Prisma.raw(PAYMENT_COLUMNS)}
          FROM "payments"
         WHERE "id" = ${input.paymentId}::uuid
         FOR UPDATE
      `;

      const current = locked[0];

      if (current === undefined) {
        throw new ConflictError("The payment attempt no longer exists.");
      }

      // `failed -> success` on one row is forbidden by §9.1's trigger, and a
      // genuinely failed attempt is not something a late webhook may overturn. It
      // becomes reconciliation on its own terms instead.
      if (current.status === "failed") {
        const flagged = await tx.payment.update({
          where: { id: input.paymentId },
          data: {
            requiresReconciliation: true,
            rawProviderPayload: input.payload as Prisma.InputJsonValue,
            updatedAt: new Date(),
          },
        });

        return toPaymentRecord(flagged);
      }

      const verifiedAt = input.verifiedAt ?? new Date();

      const updated = await tx.payment.update({
        where: { id: input.paymentId },
        data: {
          status: "success",
          requiresReconciliation: true,
          // Same rule as `flagPaymentForReconciliation`: a value we cannot establish
          // must not blank a value already on the row. Losing a recorded amount
          // destroys the evidence the flag was raised to preserve.
          ...(input.verifiedAmountMinorUnits === null
            ? {}
            : { verifiedAmountMinorUnits: input.verifiedAmountMinorUnits }),
          verifiedAt,
          rawProviderPayload: input.payload as Prisma.InputJsonValue,
          updatedAt: verifiedAt,
        },
      });

      return toPaymentRecord(updated);
    });
  }

  /**
   * Stale `pending_payment` registrations whose hold window has closed (BR-3).
   *
   * Filtered in SQL on both `status` and `created_at` so the set is exactly the holds
   * that are outstanding *and* overdue. Filtering on status in the query rather than
   * in the caller is what keeps `quantity_held` correct: a confirmed registration's
   * hold was consumed, and releasing it here would return stock that is already sold.
   */
  async findExpiredHolds(olderThan: Date, limit: number): Promise<RegistrationRecord[]> {
    const rows = await this.prisma.$queryRaw<RegistrationRow[]>`
      SELECT ${Prisma.raw(REGISTRATION_COLUMNS)}
        FROM "registrations"
       WHERE "status" = 'pending_payment'
         AND "created_at" <= ${olderThan}
       ORDER BY "created_at" ASC, "id" ASC
       LIMIT ${limit}
    `;

    return rows.map(fromRegistrationRow);
  }
}

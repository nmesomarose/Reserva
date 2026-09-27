/**
 * Registration & payment business rules (PRD v2 FR-8, FR-9, FR-10, FR-10a,
 * FR-11, FR-12, §5.3/§5.4, BR-1, BR-3, §7.3, §9.1, §9.2, §10, §11, §12).
 *
 * The only layer allowed to decide what "registering for an event" and "preparing a
 * payment" mean (AGENTS.md §4). Route handlers parse, call one of these, and
 * translate the result.
 *
 * ## The order of operations, and why it is this order
 *
 * The skill lists nine steps and their order is load-bearing, not incidental:
 *
 * 1. **Idempotency first.** Before the tier is even looked at. A client that
 *    retries a submission after the last ticket sold out must still receive its
 *    *original* result (PRD §12: "replaying the same `idempotency_key` returns the
 *    original result"). If availability were checked first, that retry would get a
 *    `409` for a purchase it already made — the one failure mode a retry cannot
 *    recover from and the attendee has no way to diagnose.
 * 2. **Then the event and tier**, and the tier must belong to the event in the path.
 * 3. **Then one transaction** placing the hold and opening the attempt.
 * 4. **Then the network call.** Never inside the transaction (see
 *    `openPaymentAttempt`).
 *
 * ## What is deliberately not in this file
 *
 * Confirmation. `pending_payment → confirmed` happens only through the payment
 * slice's §8.5 transaction, because only that path has a verified provider result
 * to justify it (BR-1, FR-12). Nothing here can produce a `confirmed` row.
 */

import { ConflictError, IllegalTransitionError, NotFoundError } from "../errors";
import type { EventRecord } from "../events/event";
import type { EventRepository } from "../events/event.repository";
import { availableQuantity, HOLD_WINDOW_MINUTES, type TicketTypeRecord } from "../tickets/ticket-type";
import type { TicketTypeRepository } from "../tickets/ticket-type.repository";
import { minorUnitsToMajorUnits, requireChargeableTierPricing } from "../payments/currency-units";
import type { PaymentProvider } from "../payments/provider";
import { PaymentProviderError } from "../payments/provider";
import { generateProviderReference, generateUniqueReference } from "./reference";
import {
  holdHasExpired,
  holdsInventory,
  type CreateRegistrationCommand,
  type PaymentRecord,
  type RegistrationRecord,
} from "./registration";
import {
  toAttendeePaymentDTO,
  toAttendeeRegistrationDTO,
  type RegistrationCheckoutDTO,
} from "./registration.dto";
import type { RegistrationCreation, RegistrationRepository } from "./registration.repository";

/** The fields that make a submission materially what it is. */
type SubmissionIdentity = Omit<CreateRegistrationCommand, "idempotencyKey">;

/**
 * An event or tier that is not purchasable is reported as a plain miss, with one
 * message, so a probe cannot distinguish "no such event" from "not published" from
 * "tier belongs to another event". The same anti-enumeration rule R-3 applies to
 * organiser reads applies here with the opposite audience: an anonymous attendee
 * must not be able to map unpublished events by their error codes.
 */
const NOT_PURCHASABLE_MESSAGE = "No such event is available for registration.";

/** A tier that exists but is not on the event in the path. Same reasoning. */
export const TIER_NOT_ON_EVENT_MESSAGE = "No such ticket tier is available on this event.";

/**
 * PRD §11/§12/§15: an unavailable tier is a state conflict, not a bad request.
 *
 * Exported because the **adapter** raises it too. The authoritative arbiter is the
 * conditional `UPDATE` inside `createPendingRegistration`, and when that statement
 * matches no row the adapter is the code holding the fact — so the same condition
 * would otherwise be reported with two different messages depending on which layer
 * noticed. One constant, one message, for one condition (rule 06).
 */
export const TIER_UNAVAILABLE_MESSAGE =
  "That ticket tier has no availability left. No registration was created.";

/**
 * A registration whose hold lapsed cannot be paid for.
 *
 * Distinct from {@link TIER_UNAVAILABLE_MESSAGE} because the fix differs: the
 * attendee must choose a tier again, whereas a sold-out tier means trying later.
 */
const HOLD_EXPIRED_MESSAGE =
  "The 15-minute payment window for this registration has passed and the reserved ticket was released. Start a new registration.";

const REGISTRATION_NOT_FOUND_MESSAGE = "No registration exists with that id.";

export interface RegistrationServiceConfig {
  /**
   * Where the provider should send the attendee after payment. `null` when no
   * public origin is configured, in which case the payment completes by webhook
   * alone — which §8.6 makes the governing channel anyway.
   */
  readonly redirectUrl: string | null;
}

/**
 * A checkout, plus whether *this* call created it.
 *
 * The distinction is the only thing separating a `201` from a `200` on both payment
 * routes, and PRD §12 is explicit that a replayed submission returns "the original
 * result, not a new row" — answering a replay with `201 Created` would tell a client
 * a resource now exists that it already had, and a client that keys on the status
 * would treat a retry as a second purchase. Deriving the status code in the route
 * from this one boolean is what keeps that decision in the domain instead of spread
 * across two handlers.
 *
 * Deliberately **not** part of the response body: it is a transport fact about the
 * call, not something an attendee or a member of staff has any use for.
 */
export interface RegistrationCheckoutResult {
  readonly checkout: RegistrationCheckoutDTO;
  readonly created: boolean;
}

export class RegistrationService {
  /**
   * @param eventRepository used only to load the event and re-check that it is
   *   still `published` and not soft-deleted at purchase time.
   * @param ticketTypeRepository supplies both the tier's stored price (FR-11) and
   *   the atomic conditional hold (rule 07).
   * @param now injectable so BR-3's window is testable without faking the clock,
   *   and so one request evaluates expiry against a single instant.
   */
  constructor(
    private readonly eventRepository: EventRepository,
    private readonly ticketTypeRepository: TicketTypeRepository,
    private readonly repository: RegistrationRepository,
    private readonly provider: PaymentProvider,
    private readonly config: RegistrationServiceConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * `POST /api/v1/events/{id}/registrations` (PRD v2 §12), and the skill's steps
   * 1-7.
   *
   * Returns the draft registration, the opened attempt, and the hosted redirect.
   * The registration is `pending_payment` and nothing here can change that.
   */
  async createRegistration(
    eventId: string,
    command: CreateRegistrationCommand,
  ): Promise<RegistrationCheckoutResult> {
    // --- Step 2, first: resolve the idempotency key -----------------------------
    const replayed = await this.replayIfKnown(command, eventId);
    if (replayed !== null) {
      return { checkout: replayed, created: false };
    }

    // --- Steps 3-4: the event must be purchasable, and the tier must be on it ---
    const { event, tier } = await this.resolvePurchasableTier(eventId, command.ticketTypeId);

    // R-6: refuse a tier whose price cannot be charged exactly, before any row is
    // written. Without this an unrepresentable price would surface as a provider
    // error *after* a hold had been taken. The rule itself lives in
    // `payments/currency-units.ts` so tier creation, tier edit, and the transaction
    // below cannot drift into three different definitions of "chargeable".
    requireChargeableTierPricing(tier.currency, tier.priceMinorUnits);

    // --- Steps 4-6: one transaction for the row, the hold, and the attempt ------
    const creation = await this.repository.createPendingRegistration({
      eventId: event.id,
      command,
      uniqueReference: generateUniqueReference(),
      providerReference: generateProviderReference(),
      expectedAmountMinorUnits: tier.priceMinorUnits,
      currency: tier.currency,
    });

    if (creation.outcome === "replayed") {
      // A concurrent request with the same key committed between our read and our
      // insert. The `UNIQUE` index decided it, which is the point of having one;
      // our losing attempt must be discarded, not merged into a second row.
      return { checkout: await this.describeReplay(creation, command, eventId, tier), created: false };
    }

    // --- Step 7: the provider call, outside the transaction --------------------
    // The amount and currency come from the *stored attempt*, not from `tier`. The
    // adapter re-read the tier inside the transaction that wrote the row, so if the
    // organiser edited the price in the gap between our read and that insert, the
    // amount charged is the one that was current when the hold was actually taken.
    // Taking it from `tier` instead would charge a price nobody agreed to.
    return {
      checkout: await this.toCheckoutDTO(creation.registration, creation.payment, tier.name, {
        providerReference: creation.payment.providerReference,
        amount: minorUnitsToMajorUnits(
          creation.payment.expectedAmountMinorUnits,
          creation.payment.currency,
        ),
        currency: creation.payment.currency,
        customerEmail: creation.registration.attendeeEmail,
        customerName: creation.registration.attendeeName,
        customerPhone: creation.registration.attendeePhone,
        redirectUrl: this.config.redirectUrl,
        sessionDurationMinutes: HOLD_WINDOW_MINUTES,
      }),
      created: true,
    };
  }

  /**
   * `POST /api/v1/payments/initiate` (PRD v2 §12) — the skill's step 8.
   *
   * Re-reads the registration, re-computes the amount from the stored tier, and
   * prepares or refreshes a redirect. A registration already resolved is a `409`,
   * never a second payment (skill step 8; §12's "409 on state conflict").
   *
   * The "refresh" branch is what keeps this from minting a second live hosted link
   * for an attempt that already has one: an unresolved attempt that retained its
   * link hands the same link back. A **new** attempt is opened only once the
   * previous one is terminally `failed`, which is exactly the case §9.1 requires a
   * new row for (`failed → success` on the same row is forbidden).
   */
  async initiatePayment(registrationId: string): Promise<RegistrationCheckoutResult> {
    const registration = await this.repository.findRegistrationById(registrationId);

    if (registration === null) {
      throw new NotFoundError(REGISTRATION_NOT_FOUND_MESSAGE);
    }

    if (registration.status !== "pending_payment") {
      throw new IllegalTransitionError(
        "This registration is already resolved, so no further payment can be started for it.",
      );
    }

    // Self-healing expiry: if the sweep has not run yet for this row, do not let a
    // lapsed hold keep a payment open. Releasing first means the attempt below is
    // never created for stock this registration no longer owns.
    if (holdHasExpired(registration, this.now())) {
      await this.expireHold(registration);
      throw new IllegalTransitionError(HOLD_EXPIRED_MESSAGE);
    }

    const tier = await this.requireTierOfEvent(registration.eventId, registration.ticketTypeId);
    requireChargeableTierPricing(tier.currency, tier.priceMinorUnits);

    const latest = await this.repository.findLatestPayment(registration.id);
    const existingLink = hostedLinkOf(latest);

    if (
      latest !== null &&
      existingLink !== null &&
      latest.status !== "failed" &&
      !latest.requiresReconciliation
    ) {
      // The same live link, re-served. No new provider transaction, no new row — and
      // therefore `200`, not `201`.
      return {
        checkout: {
          registration: toAttendeeRegistrationDTO(registration, tier.name),
          payment: toAttendeePaymentDTO(latest),
          redirect_url: existingLink,
        },
        created: false,
      };
    }

    const attempt = await this.repository.openPaymentAttempt({
      registrationId: registration.id,
      providerReference: generateProviderReference(),
      expectedAmountMinorUnits: tier.priceMinorUnits,
      currency: tier.currency,
    });

    return {
      checkout: await this.toCheckoutDTO(registration, attempt, tier.name, {
        providerReference: attempt.providerReference,
        amount: minorUnitsToMajorUnits(attempt.expectedAmountMinorUnits, attempt.currency),
        currency: attempt.currency,
        customerEmail: registration.attendeeEmail,
        customerName: registration.attendeeName,
        customerPhone: registration.attendeePhone,
        redirectUrl: this.config.redirectUrl,
        sessionDurationMinutes: HOLD_WINDOW_MINUTES,
      }),
      created: true,
    };
  }

  /**
   * Release every tier hold whose 15-minute window has passed (PRD §10, BR-3).
   *
   * The clock the two-counter model does not have. §10 says a lapsed hold has its
   * inventory "decremented automatically", and §7.2/§9.3 forbid a per-hold row, so
   * a hold is identified by its `Registration` and its age is `created_at`. This
   * method is that identification, and it is deliberately a **service method with
   * no route**: §12 has no maintenance endpoint, and rule 06 forbids inventing one.
   * The payment-resolution path calls the same `expireHold` internally, so the rule
   * is enforced even if nothing ever calls this method.
   *
   * @returns how many holds were released, so a caller can loop until zero.
   */
  async releaseExpiredHolds(limit = 100): Promise<number> {
    const cutoff = new Date(this.now().getTime() - HOLD_WINDOW_MINUTES * 60_000);
    const stale = await this.repository.findExpiredHolds(cutoff, limit);

    let released = 0;
    for (const registration of stale) {
      await this.expireHold(registration);
      released += 1;
    }

    return released;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * The replay fast path (skill step 2).
   *
   * Returns `null` when the key is unused, so the caller proceeds. A used key
   * either replays the original result or raises the `409` the skill requires for
   * a materially different body — never a silent return of the old result.
   */
  private async replayIfKnown(
    command: CreateRegistrationCommand,
    eventId: string,
  ): Promise<RegistrationCheckoutDTO | null> {
    const existing = await this.repository.findRegistrationByIdempotencyKey(command.idempotencyKey);

    if (existing === null) {
      return null;
    }

    this.requireSameSubmission(existing, command, eventId);

    const payment = this.requireAttempt(await this.repository.findLatestPayment(existing.id));
    const tier = await this.repository.findRegistrationTier(existing);

    return {
      registration: toAttendeeRegistrationDTO(existing, tier.name),
      payment: toAttendeePaymentDTO(payment),
      redirect_url: hostedLinkOf(payment),
    };
  }

  /**
   * A registration always has at least one attempt: the two are written by the
   * same transaction (skill integrity checks). So `null` here is not a state the
   * product has, it is a broken invariant, and it is answered as a state conflict
   * rather than a `500` — the attendee is told the registration cannot be paid for
   * instead of the endpoint crashing on an internal detail.
   */
  private requireAttempt(payment: PaymentRecord | null): PaymentRecord {
    if (payment === null) {
      throw new ConflictError(
        "This registration has no payment attempt, so payment cannot be prepared. " +
          "Start a new registration.",
      );
    }

    return payment;
  }

  /**
   * A used key arriving with a **materially different** body is a conflict, not a
   * replay (skill integrity checks; rule 06: "do not silently return the old result
   * for a materially different request — treat it as a conflict and say so").
   *
   * "Material" means the fields that determine *what is being bought and for whom*.
   * Comparing them exactly is the conservative reading: treating two spellings of
   * one name as different would refuse a legitimate retry, which is the failure
   * this whole mechanism exists to prevent.
   */
  private requireSameSubmission(
    existing: RegistrationRecord,
    command: SubmissionIdentity,
    eventId: string,
  ): void {
    const differences: string[] = [];

    if (existing.eventId !== eventId) differences.push("event");
    if (existing.ticketTypeId !== command.ticketTypeId) differences.push("ticket_type_id");
    if (existing.attendeeName !== command.attendeeName) differences.push("attendee_name");
    if (existing.attendeeEmail !== command.attendeeEmail) differences.push("attendee_email");
    if (existing.attendeePhone !== command.attendeePhone) differences.push("attendee_phone");

    if (differences.length > 0) {
      throw new ConflictError(
        "That idempotency key was already used for a different registration. " +
          "Use a new key for a different submission.",
      );
    }
  }

  /**
   * The concurrent-replay branch: the `UNIQUE` index beat us to the row.
   *
   * The stored row is authoritative, so the same materiality check runs, and the
   * tier is resolved for the *stored* registration rather than the incoming one.
   */
  private async describeReplay(
    creation: Extract<RegistrationCreation, { outcome: "replayed" }>,
    command: SubmissionIdentity,
    eventId: string,
    fallbackTier: TicketTypeRecord,
  ): Promise<RegistrationCheckoutDTO> {
    this.requireSameSubmission(creation.registration, command, eventId);

    const tier =
      creation.registration.ticketTypeId === fallbackTier.id
        ? fallbackTier
        : await this.repository.findRegistrationTier(creation.registration);

    const payment =
      creation.payment === null
        ? this.requireAttempt(null)
        : creation.payment;

    return {
      registration: toAttendeeRegistrationDTO(creation.registration, tier.name),
      payment: toAttendeePaymentDTO(payment),
      redirect_url: hostedLinkOf(payment),
    };
  }

  /**
   * Load an event that can be sold, and a tier on it with stock left.
   *
   * Steps 3 and 5's precondition. The availability read here is a **fast pre-check
   * for a good error message**; the atomic conditional update inside
   * `createPendingRegistration` is the real arbiter, because between this read and
   * that write the last ticket can sell (rule 07, PRD §10's last-unit race).
   */
  private async resolvePurchasableTier(
    eventId: string,
    ticketTypeId: string,
  ): Promise<{ event: EventRecord; tier: TicketTypeRecord }> {
    const event = await this.eventRepository.findEventById(eventId);

    // Same rule as `EventService.isPubliclyVisible`, re-asserted rather than
    // trusted: a draft, closed, or soft-deleted event is not sellable, and the
    // repository is not required to have filtered it.
    if (event === null || event.status !== "published" || event.deletedAt !== null) {
      throw new NotFoundError(NOT_PURCHASABLE_MESSAGE);
    }

    const tier = await this.requireTierOfEvent(event.id, ticketTypeId);

    if (availableQuantity(tier) < 1) {
      throw new ConflictError(TIER_UNAVAILABLE_MESSAGE);
    }

    return { event, tier };
  }

  /**
   * Resolve a tier and require it to belong to the event.
   *
   * A tier of a *different* event is a miss, never a cross-event write: the
   * database trigger would reject it, but rejecting it here means the caller gets
   * `404` instead of a constraint failure surfaced as a `500`.
   */
  private async requireTierOfEvent(
    eventId: string,
    ticketTypeId: string,
  ): Promise<TicketTypeRecord> {
    const tier = await this.ticketTypeRepository.findTicketTypeById(ticketTypeId);

    if (tier === null || tier.eventId !== eventId) {
      throw new NotFoundError(TIER_NOT_ON_EVENT_MESSAGE);
    }

    return tier;
  }

  /**
   * Ask the provider for a hosted link and persist its response.
   *
   * Three failure behaviours, and the distinction is the whole point:
   *
   *   - **Rejected** (a real 4xx): the attempt is marked `failed`, which is
   *     terminal for that row and lets the attendee open a fresh one.
   *   - **Rate limited**: surfaced to the caller as a `409`-shaped retry prompt
   *     with the attempt left `initiated`, because nothing failed.
   *   - **Indeterminate** (503, or our own timeout): the attempt is left
   *     `initiated` and the caller is told the payment may be in flight. The
   *     provider's documented instruction is *not* to retry a create, so marking
   *     this `failed` would both strand a payment that may have succeeded and invite
   *     the duplicate the rule exists to prevent. The durable `Payment` row
   *     committed before this call is what makes a later
   *     `/payments/verify?provider_reference=…` able to resolve it.
   */
  private async toCheckoutDTO(
    registration: RegistrationRecord,
    payment: PaymentRecord,
    tierName: string,
    input: Parameters<PaymentProvider["initiateCheckout"]>[0],
  ): Promise<RegistrationCheckoutDTO> {
    const projection = {
      registration: toAttendeeRegistrationDTO(registration, tierName),
      payment: toAttendeePaymentDTO(payment),
    };

    let checkout;
    try {
      checkout = await this.provider.initiateCheckout(input);
    } catch (error) {
      if (!(error instanceof PaymentProviderError)) {
        throw error;
      }

      if (error.mayHaveMoved || error.kind === "rate_limited") {
        // Deliberately NOT marked failed. Return the honest, non-final state.
        return { ...projection, redirect_url: null };
      }

      const failed = await this.repository.markPaymentFailed(payment.id, {
        error: error.kind,
        provider_message: error.providerMessage,
      });

      return {
        registration: toAttendeeRegistrationDTO(registration, tierName),
        payment: toAttendeePaymentDTO(failed),
        redirect_url: null,
      };
    }

    const recorded = await this.repository.recordProviderPayload(payment.id, checkout.raw);

    return {
      registration: toAttendeeRegistrationDTO(registration, tierName),
      payment: toAttendeePaymentDTO(recorded),
      redirect_url: checkout.link,
    };
  }

  /**
   * Release one lapsed hold: `quantity_held` down, `status = cancelled`.
   *
   * Both writes in one transaction, and both are conditional, because a hold can
   * only be released by the registration that placed it. `holdsInventory` is the
   * domain rule that decides; the conditional statements are what make it true under
   * concurrency (rule 07).
   *
   * `cancelled` is PRD §10's state for a lapsed hold, and it is a one-way door by
   * design: §9.2 forbids `cancelled → confirmed`, which is exactly what makes R-2
   * (a late webhook must not re-confirm it) enforceable rather than aspirational.
   */
  private async expireHold(registration: RegistrationRecord): Promise<void> {
    if (!holdsInventory(registration.status)) {
      return;
    }

    await this.repository.transact(async (tx) => {
      const cancelled = await tx.cancelRegistrationIfPending(registration.id);
      if (cancelled === null) {
        // Another path cancelled it first. Its own transaction already released
        // the hold, so releasing again here would be a double-release.
        return;
      }

      await tx.releaseHeldInventory(registration.ticketTypeId, 1);
    });
  }
}

/**
 * The hosted link from a stored provider response, or `null`.
 *
 * This is what makes a replayed `idempotency_key` return *its original* redirect
 * (PRD §12) without a second provider call — and therefore without a second hosted
 * link. Returns `null` for any payload that is not the documented
 * `{ data: { link } }` shape rather than guessing, so a malformed stored payload
 * degrades to "no link available" instead of sending an attendee somewhere
 * unvetted.
 */
export function hostedLinkOf(payment: PaymentRecord | null): string | null {
  const payload = payment?.rawProviderPayload;

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }

  const data = (payload as { data?: unknown }).data;

  if (typeof data !== "object" || data === null) {
    return null;
  }

  const link = (data as { link?: unknown }).link;

  return typeof link === "string" && link !== "" ? link : null;
}

/**
 * Ticket tier business rules (PRD v2 FR-5, FR-6, BR-3, §9.3, §12).
 *
 * The only layer allowed to decide what "creating a tier" or "holding a unit"
 * means (AGENTS.md §4). Route handlers parse a request, call one of these
 * methods, and translate the result.
 *
 * Scope note: `POST /api/v1/events/{id}/ticket-types` is PRD §12's own row. The
 * list, patch, and delete routes are the approved additions recorded as
 * product-owner decision R-4 in `.agents/rules/03`, mirroring R-3 for the Event
 * slice. Nothing else is implied by them.
 *
 * NOT in this slice, deliberately:
 *
 *   - Registration, payment, and the §8.5 confirmation transaction. `confirmInventory`
 *     exists as the tier half of that sequence, but the sequence itself needs
 *     `Registration` and `Payment` writes and belongs to the payment slice.
 *   - The 15-minute expiry *sweep*. See `HOLD_WINDOW_MINUTES` in `ticket-type.ts`
 *     for why the clock cannot live here.
 *   - FR-7's per-tier closure. PRD §7.2 gives `TicketType` no status column, no
 *     enum, and no soft-delete stamp, so a closed tier is not representable
 *     without inventing a column. Rule 03 makes that a stop condition, not an
 *     inference — reported rather than absorbed. See R-7 in `.agents/rules/03`,
 *     which now records the decision explicitly.
 *
 * R-6's price gate is here even though it is a payments concern, because the PRD
 * makes a tier's price an organiser-authored field and the cheapest place to reject
 * an unsellable price is before the tier exists. The rule itself is imported from
 * `../payments/currency-units.ts`, not restated.
 */

import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../errors";
import type { PageRequest, TicketTypeRecord } from "../events/event";
import { requireOrganiserId, requireOwnedEvent } from "../events/event-ownership";
import type { EventRepository } from "../events/event.repository";
import type { PaginatedResponse } from "../events/event.dto";
import { requireChargeableTierPricing } from "../payments/currency-units";
import type {
  CreateTicketTypeCommand,
  TicketTypePatch,
  TicketTypeWriteSet,
} from "./ticket-type";
import {
  toOrganiserTicketTypeDTO,
  type OrganiserTicketTypeDTO,
} from "./ticket-type.dto";
import type { TicketTypeRepository } from "./ticket-type.repository";

/**
 * A tier id that does not belong to the event in the path.
 *
 * `404`, not `403`, and not a "no such tier" message that would confirm the id
 * exists: R-3 resolves a child of the wrong parent as a miss, for the same
 * anti-enumeration reason an unknown event id is one. The caller is not being told
 * "that tier is real, it is just not yours".
 */
const TICKET_TYPE_NOT_ON_EVENT_MESSAGE = "No such ticket tier exists on this event.";

/**
 * @param eventRepository only its `findEventById` is used, but the whole port is
 *   taken so this service can be handed a *transaction* handle and keep the
 *   ownership read inside the same unit of work as the write.
 */
export class TicketTypeService {
  constructor(
    private readonly eventRepository: EventRepository,
    private readonly repository: TicketTypeRepository,
  ) {}

  /**
   * Create a tier on an event the caller owns (PRD v2 §12).
   *
   * The organiser identity is a *parameter derived from the server-side auth
   * context* — never from the body — so one organiser can never add a tier to
   * another's event (PRD §3, rule 05).
   *
   * Counters start at zero because the column default says so (PRD §7.2); the
   * service has no opinion about inventory state on a tier nobody has bought.
   *
   * R-6's price gate is here, and here is where the decision puts it: a tier whose
   * price cannot be charged exactly — an unsupported currency, or a minor-unit
   * amount with no whole-major-unit form — is refused *before the row exists*.
   * Catching it only at purchase time would mean a tier an organiser believes is on
   * sale cannot actually be sold, which is a worse failure than a `400` at creation.
   */
  async createTicketType(
    organiserId: string,
    eventId: string,
    command: CreateTicketTypeCommand,
  ): Promise<OrganiserTicketTypeDTO> {
    requireOrganiserId(organiserId);

    // Ownership first, before any write is attempted: a foreign event must not
    // even reach the insert, so a caller cannot use a 409/400 from the insert to
    // probe for a tier name on somebody else's event.
    await requireOwnedEvent(this.eventRepository, organiserId, eventId);

    requireChargeableTierPricing(command.currency, command.priceMinorUnits);

    return toOrganiserTicketTypeDTO(
      await this.repository.createTicketType({ eventId, command }),
    );
  }

  /**
   * The caller's own tiers for one owned event, paginated (rule 06's envelope).
   *
   * The event is resolved and ownership-checked first, so the collection is
   * scoped to an event the caller owns. An event with no tiers is a `200` with
   * `data: []`, never a `404` — same rule as the event list.
   */
  async listTicketTypes(
    organiserId: string,
    eventId: string,
    request: PageRequest,
  ): Promise<PaginatedResponse<OrganiserTicketTypeDTO>> {
    requireOrganiserId(organiserId);

    await requireOwnedEvent(this.eventRepository, organiserId, eventId);

    const result = await this.repository.listTicketTypes({ ...request, eventId });

    return {
      data: result.items.map(toOrganiserTicketTypeDTO),
      page: request.page,
      page_size: request.pageSize,
      total: result.total,
    };
  }

  /**
   * Merge a sparse edit into one tier (the skill's "editing tier
   * name/description/price/quantity", and the endpoint FR-5/FR-6 need).
   *
   * The tier is resolved *through the owned event* rather than by id alone, so a
   * valid tier id belonging to a different event is a miss rather than a
   * cross-event write.
   *
   * Two properties are worth stating:
   *
   *   1. A field absent from the patch is left alone, and one present but equal
   *      to the stored value is also left alone — a no-op PATCH writes nothing and
   *      does not bump `updated_at`.
   *   2. A `quantity_total` reduction below committed inventory is **not** checked
   *      here. The database CHECK decides, and the adapter turns the rejection into
   *      a `400` naming `quantity_total` (skill step 9). Checking first here would
   *      be the read-then-write shape rule 07 rules out, and would duplicate a
   *      rule that already exists in the schema.
   */
  async updateTicketType(
    organiserId: string,
    eventId: string,
    ticketTypeId: string,
    patch: TicketTypePatch,
  ): Promise<OrganiserTicketTypeDTO> {
    requireOrganiserId(organiserId);

    const existing = await this.requireOwnedTicketType(organiserId, eventId, ticketTypeId);

    const changes = this.diffForWrite(existing, patch);

    if (Object.keys(changes).length === 0) {
      return toOrganiserTicketTypeDTO(existing);
    }

    // R-6 on the *merged* result, not on whichever field happened to be sent. A
    // patch carrying only a price has to be judged against the stored currency, and
    // a patch carrying only a currency against the stored price — so checking the
    // patch in isolation would pass a change that makes the tier unsellable. The
    // rule is applied to the tier as it would be after the write, which is the only
    // form of the question that has an answer.
    requireChargeableTierPricing(
      changes.currency ?? existing.currency,
      changes.priceMinorUnits ?? existing.priceMinorUnits,
    );

    return toOrganiserTicketTypeDTO(
      await this.repository.updateTicketType({ id: existing.id, changes }),
    );
  }

  /**
   * Remove a tier from an event the caller owns.
   *
   * A hard delete, unlike an event's soft delete, and that difference is
   * deliberate: PRD §14's retention rule is about audit and payment evidence, and a
   * ticket tier is configuration. The database still has a veto — a tier a
   * registration references is refused (`Registration.ticket_type_id` is
   * `RESTRICT`, PRD §7.2), which the adapter reports as `409`. Sales history
   * therefore cannot be orphaned by this route; the tier simply cannot be removed
   * while it has any.
   */
  async deleteTicketType(
    organiserId: string,
    eventId: string,
    ticketTypeId: string,
  ): Promise<void> {
    requireOrganiserId(organiserId);

    const existing = await this.requireOwnedTicketType(organiserId, eventId, ticketTypeId);

    await this.repository.deleteTicketType(existing.id);
  }

  /**
   * §9.3 `AVAILABLE → HELD` (BR-3, skill step 5, PRD §15's `409`).
   *
   * This is the operation the registration slice calls when routing an attendee
   * to payment, and it is deliberately reachable without an organiser: a public
   * attendee causes a hold, so taking an organiser here would make the rule
   * unimplementable. What authorises the hold is the *conditional update*, not an
   * identity check.
   *
   * Answers `409` when the tier cannot supply the units, which is the same code
   * PRD §12 and §15 assign to an unavailable tier.
   */
  async holdInventory(ticketTypeId: string, quantity: number): Promise<TicketTypeRecord> {
    this.assertPositiveQuantity(quantity);

    const updated = await this.repository.holdInventory(ticketTypeId, quantity);

    if (updated === null) {
      throw new ConflictError("This ticket tier does not have enough availability.");
    }

    return updated;
  }

  /**
   * §9.3 `HELD → AVAILABLE`: release a hold (skill step 6).
   *
   * Called on payment failure and, from the registration slice, on hold expiry.
   * The service does not need to know which: both are the same counter move, and
   * BR-3 requires both to happen inside the registration's transaction — which is
   * the caller's transaction, not this method's.
   */
  async releaseInventory(ticketTypeId: string, quantity: number): Promise<TicketTypeRecord> {
    this.assertPositiveQuantity(quantity);

    const updated = await this.repository.releaseInventory(ticketTypeId, quantity);

    if (updated === null) {
      throw new ConflictError("This ticket tier has no matching hold to release.");
    }

    return updated;
  }

  /**
   * §9.3 `HELD → CONFIRMED`, the tier half of §8.5's confirmation transaction.
   *
   * Only a verified payment may call this (BR-1, PRD §9.3). Enforcing *that* is
   * the payment slice's job — this method has no way to know whether a payment
   * verified, and pretending otherwise would be a comment, not a control. What this
   * method does guarantee is that the two counters move together in one statement,
   * so the units are never counted as neither held nor confirmed.
   */
  async confirmInventory(ticketTypeId: string, quantity: number): Promise<TicketTypeRecord> {
    this.assertPositiveQuantity(quantity);

    const updated = await this.repository.confirmInventory(ticketTypeId, quantity);

    if (updated === null) {
      throw new ConflictError("This ticket tier has no matching hold to confirm.");
    }

    return updated;
  }

  /**
   * Resolve a tier that belongs to an event the caller owns, or fail.
   *
   * Reads the event (ownership) and the tier's event id, so all three outcomes are
   * distinguishable and each gets the code R-3 assigns it:
   *
   *   - unknown event -> `404`
   *   - another organiser's event -> `403`
   *   - unknown tier, or a tier of a *different* event -> `404`
   */
  private async requireOwnedTicketType(
    organiserId: string,
    eventId: string,
    ticketTypeId: string,
  ): Promise<TicketTypeRecord> {
    await requireOwnedEvent(this.eventRepository, organiserId, eventId);

    const tier = await this.repository.findTicketTypeById(ticketTypeId);

    if (tier === null || tier.eventId !== eventId) {
      throw new NotFoundError(TICKET_TYPE_NOT_ON_EVENT_MESSAGE);
    }

    return tier;
  }

  /**
   * The write set for a PATCH: only fields the caller supplied *and* that differ
   * from the stored row.
   *
   * Filtering no-ops out is what keeps `updated_at` meaningful — it should say
   * when the tier last actually changed.
   */
  private diffForWrite(
    existing: TicketTypeRecord,
    patch: TicketTypePatch,
  ): TicketTypeWriteSet {
    const changes: TicketTypeWriteSet = {};

    if (patch.name !== undefined && patch.name !== existing.name) {
      changes.name = patch.name;
    }
    if (patch.description !== undefined && patch.description !== existing.description) {
      changes.description = patch.description;
    }
    if (
      patch.priceMinorUnits !== undefined &&
      patch.priceMinorUnits !== existing.priceMinorUnits
    ) {
      changes.priceMinorUnits = patch.priceMinorUnits;
    }
    if (patch.currency !== undefined && patch.currency !== existing.currency) {
      changes.currency = patch.currency;
    }
    if (patch.quantityTotal !== undefined && patch.quantityTotal !== existing.quantityTotal) {
      changes.quantityTotal = patch.quantityTotal;
    }

    return changes;
  }

  /**
   * A counter move of zero or fewer units is a caller bug, not a no-op.
   *
   * Left to the database it would be harmless-ish (`held - 0` passes every CHECK),
   * which is precisely the problem: a silent no-op that looks successful is how a
   * registration ends up marked as holding stock that it does not hold. Rejected
   * here, before any write.
   */
  private assertPositiveQuantity(quantity: number): void {
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new ValidationError("A counter change must move a positive whole number of units.", {
        quantity: ["Must be an integer of 1 or greater."],
      });
    }
  }
}

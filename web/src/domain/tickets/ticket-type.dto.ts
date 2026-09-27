/**
 * Organiser-facing TicketType DTOs.
 *
 * The public projection is NOT here and is NOT changed by this slice:
 * `TicketTypeSummaryDTO` in `../events/event.dto.ts` is PRD §13's contract
 * (`{ name, price_minor_units, currency, available }`) and already serves
 * `GET /api/v1/events/{slug}`. It exposes no counters and must keep doing so
 * (PRD §13, rule 06).
 *
 * Why the organiser needs *more* is a business requirement, not convenience:
 *
 *   - The counters are what make `quantity_total` editable. The skill's step 9
 *     requires a reduction below `confirmed + held` to be rejected, so the
 *     organiser has to be able to see committed and held stock to know which
 *     reductions are legal.
 *   - PRD §20's dashboard Must-Have is "tier sales/availability", organiser-only.
 *   - The skill's step 3 requires availability to be *exposed* somewhere the
 *     organiser can act on it.
 *
 * `available` is a *number* here and a *boolean* in the public DTO. That is
 * deliberate: remaining sellable units are commercially sensitive (they reveal how
 * well an event is selling), and PRD §13 reduces the public value to a
 * sold-out-or-not label on purpose.
 */

import { availableQuantity, type TicketTypeRecord } from "./ticket-type";

export interface OrganiserTicketTypeDTO {
  readonly id: string;
  readonly name: string;
  /** `null` for a tier with no blurb. */
  readonly description: string | null;
  readonly price_minor_units: number;
  readonly currency: string;
  readonly quantity_total: number;
  readonly quantity_confirmed: number;
  readonly quantity_held: number;
  /** Remaining sellable units: `total - confirmed - held` (BR-3). Derived. */
  readonly available: number;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * Project a tier for its owning organiser.
 *
 * An allow-list, like every other DTO in the codebase (rule 06). Note what is
 * absent: `event_id`, even though the record carries it. The path already names
 * the event, so returning it would be a field with no reader — and `OrganiserEventDTO`
 * omits `organiser_id` for the same reason.
 */
export function toOrganiserTicketTypeDTO(tier: TicketTypeRecord): OrganiserTicketTypeDTO {
  return {
    id: tier.id,
    name: tier.name,
    description: tier.description,
    price_minor_units: tier.priceMinorUnits,
    currency: tier.currency,
    quantity_total: tier.quantityTotal,
    quantity_confirmed: tier.quantityConfirmed,
    quantity_held: tier.quantityHeld,
    available: availableQuantity(tier),
    created_at: tier.createdAt.toISOString(),
    updated_at: tier.updatedAt.toISOString(),
  };
}

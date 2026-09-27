/**
 * Wire-format DTOs (PRD v2 §13).
 *
 * Two rules drive everything in this file:
 *  1. Field names are **snake_case on the wire** (`starts_at`, `price_minor_units`)
 *     to match the PRD exactly, even though the domain uses camelCase.
 *  2. Public DTOs are an *allowlist*. `.agents/rules/06-api-contract-and-validation.md`
 *     forbids "response fields 'just in case'": the public projection must
 *     exclude `organiser_id`, raw internal ids, soft-delete bookkeeping, and the
 *     ticket quantity counters — availability is derived, never leaked.
 */

import type {
  EventRecord,
  ProgrammeItemRecord,
  TicketTypeRecord,
} from "./event";

/** A programme line on the public event page. */
export interface PublicProgrammeItemDTO {
  readonly sort_order: number;
  /** ISO 8601 with offset, or `null` when the item has no fixed time. */
  readonly time: string | null;
  readonly title: string;
  readonly description: string | null;
}

/**
 * Ticket tier as shown publicly (PRD v2 §13 TicketTypeSummaryDTO): name, price,
 * and a derived boolean — never the underlying counters.
 */
export interface TicketTypeSummaryDTO {
  readonly name: string;
  readonly price_minor_units: number;
  readonly currency: string;
  readonly available: boolean;
}

/** The public event projection served by `GET /api/v1/events/{slug}`. */
export interface PublicEventDTO {
  readonly name: string;
  readonly slug: string;
  /** `null` for an event with no blurb (decision 4 made it optional). */
  readonly description: string | null;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly venue: string;
  readonly programme: readonly PublicProgrammeItemDTO[];
  readonly ticket_types: readonly TicketTypeSummaryDTO[];
}

/**
 * The organiser's own view of an event, returned by `POST /api/v1/events`.
 *
 * An organiser is the owner, so ids and timestamps are legitimately visible
 * here — but note the asymmetry with `PublicEventDTO`, which is what makes the
 * public leak risk obvious during review.
 */
export interface OrganiserEventDTO {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  /** `null` for an event with no blurb (decision 4 made it optional). */
  readonly description: string | null;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly venue: string;
  readonly status: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * A programme line as the owning organiser sees it.
 *
 * Carries `id`, unlike `PublicProgrammeItemDTO`, because the approved
 * `PATCH`/`DELETE .../programme/{item_id}` routes have to be addressable. A
 * public item is deliberately not addressable — nothing on the public page
 * mutates.
 */
export interface OrganiserProgrammeItemDTO {
  readonly id: string;
  readonly sort_order: number;
  readonly time: string | null;
  readonly title: string;
  readonly description: string | null;
}

/**
 * The list envelope mandated by `.agents/rules/06` ("applies to *every* list
 * endpoint"). `total` counts the *filtered* set, not the table, and an empty
 * result is a `200` with `data: []` — never a `404`.
 */
export interface PaginatedResponse<T> {
  readonly data: readonly T[];
  readonly page: number;
  readonly page_size: number;
  readonly total: number;
}

function toIso(value: Date): string {
  return value.toISOString();
}

/** The subset of a tier that determines availability. */
export type TierAvailability = Pick<
  TicketTypeRecord,
  "quantityTotal" | "quantityConfirmed" | "quantityHeld"
>;

/**
 * Remaining sellable inventory for a tier.
 *
 * `confirmed` stock is sold, `held` stock is provisionally reserved for
 * in-flight registrations; neither is available to a new registration
 * (PRD v2 §4.2, §11).
 */
export function isTierAvailable(tier: TierAvailability): boolean {
  return tier.quantityTotal - tier.quantityConfirmed - tier.quantityHeld > 0;
}

export function toPublicProgrammeItemDTO(item: ProgrammeItemRecord): PublicProgrammeItemDTO {
  return {
    sort_order: item.sortOrder,
    time: item.time === null ? null : toIso(item.time),
    title: item.title,
    description: item.description,
  };
}

export function toTicketTypeSummaryDTO(tier: TicketTypeRecord): TicketTypeSummaryDTO {
  return {
    name: tier.name,
    price_minor_units: tier.priceMinorUnits,
    currency: tier.currency,
    available: isTierAvailable(tier),
  };
}

export function toOrganiserEventDTO(event: EventRecord): OrganiserEventDTO {
  return {
    id: event.id,
    name: event.name,
    slug: event.slug,
    description: event.description,
    starts_at: toIso(event.startsAt),
    ends_at: toIso(event.endsAt),
    venue: event.venue,
    status: event.status,
    created_at: toIso(event.createdAt),
    updated_at: toIso(event.updatedAt),
  };
}

export function toOrganiserProgrammeItemDTO(
  item: ProgrammeItemRecord,
): OrganiserProgrammeItemDTO {
  return {
    id: item.id,
    sort_order: item.sortOrder,
    time: item.time === null ? null : toIso(item.time),
    title: item.title,
    description: item.description,
  };
}

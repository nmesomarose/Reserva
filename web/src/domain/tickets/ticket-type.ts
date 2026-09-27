/**
 * TicketType domain types (PRD v2 §7.2, BR-3, §9.3, FR-5/6/7).
 *
 * Framework- and database-agnostic, like `events/event.ts`: plain shapes, never
 * Prisma models. The persistence adapter maps onto these.
 *
 * The record itself (`TicketTypeRecord`) lives in `events/event.ts` because the
 * public event aggregate is what first needed it, and moving it would churn the
 * Event slice for no gain. What lives here is everything *this* slice adds: the
 * create command, the sparse patch, the writable column set, and the inventory
 * transitions of §9.3.
 */

import type { TicketTypeRecord } from "../events/event";

/**
 * The two-counter availability model (PRD v2 BR-3, §9.3).
 *
 * `available` is **derived** and never stored: the skill's step 3 and rule 02
 * both require that, and a stored `available` column could disagree with the
 * counters the moment either moved. The `CHECK` constraint makes a negative value
 * a *rejected write* rather than a bug the application has to catch.
 */
export interface TierAvailability {
  readonly quantityTotal: number;
  readonly quantityConfirmed: number;
  readonly quantityHeld: number;
}

/**
 * Units still sellable on a tier: `total - confirmed - held` (BR-3).
 *
 * Conceptual per unit — PRD §9.3 states there is **no stored per-unit row**, so
 * this is arithmetic over the counters, never a count of child records. The
 * result is `0` at most, never negative, because the database refuses to store
 * the counter combination that would make it so.
 */
export function availableQuantity(tier: TierAvailability): number {
  return tier.quantityTotal - tier.quantityConfirmed - tier.quantityHeld;
}

/**
 * The hold window (PRD v2 BR-3, §9.3, §10).
 *
 * A hold created now has expired once this much time has passed. Held in the
 * domain — not in a route handler — because the number is a product decision
 * (PRD §21 open item 7 lists it as a working default awaiting confirmation on
 * real usage) and must have exactly one definition.
 *
 * NOTE ON SCOPE: this slice implements the *counter* transitions, not the clock
 * that fires them. Which individual hold is "older than 15 minutes" is a question
 * about a specific in-flight registration, and the two-counter model stores no
 * per-hold row or timestamp (PRD §7.2 fixes the columns; §9.3 states there is no
 * per-unit row). The expiry sweep therefore belongs to the registration slice,
 * which owns the `Registration` row and the transaction that releases the hold.
 * Inventing a `hold_expires_at` column or a hold table here would be exactly the
 * "per-unit inventory rows" the skill's stop conditions rule out.
 */
export const HOLD_WINDOW_MINUTES = 15;

const MILLISECONDS_PER_MINUTE = 60_000;

/** The instant a hold taken at `heldAt` runs out (PRD BR-3's 15-minute window). */
export function holdExpiresAt(heldAt: Date): Date {
  return new Date(heldAt.getTime() + HOLD_WINDOW_MINUTES * MILLISECONDS_PER_MINUTE);
}

/** Validated, domain-level input for creating a tier (PRD v2 §12, skill step 2). */
export interface CreateTicketTypeCommand {
  readonly name: string;
  /** Optional. `null` and absent both mean "no description". */
  readonly description: string | null;
  /** Integer minor units, never a float (AGENTS.md §5, FR-11). */
  readonly priceMinorUnits: number;
  /** ISO 4217 alphabetic code, uppercase. */
  readonly currency: string;
  /** Total capacity; the skill requires an integer > 0. */
  readonly quantityTotal: number;
}

/**
 * The columns a PATCH is allowed to write.
 *
 * Deliberately sparse and deliberately mutable, exactly like `EventWriteSet`: a
 * set of *proposed* values, not a record. The merge against the stored row happens
 * in the service.
 *
 * `quantityConfirmed` and `quantityHeld` are **absent by design**. They move only
 * through the §9.3 inventory transitions, which are reached through
 * `TicketTypeRepository.holdInventory` / `releaseInventory` / `confirmInventory`
 * and are conditional on the CHECK constraint. A PATCH that could write them
 * directly would be an unguarded path to the same columns — the read-then-write
 * shape rule 07 forbids.
 */
export interface TicketTypeWriteSet {
  name?: string;
  description?: string | null;
  priceMinorUnits?: number;
  currency?: string;
  quantityTotal?: number;
}

/**
 * A sparse edit to an existing tier.
 *
 * Absent leaves a column alone; an explicit `null` clears `description`. The
 * service merges this onto the stored row, so a partial body never blanks a field
 * the caller did not mention.
 */
export interface TicketTypePatch {
  readonly name?: string;
  readonly description?: string | null;
  readonly priceMinorUnits?: number;
  readonly currency?: string;
  readonly quantityTotal?: number;
}

/** Re-exported so consumers need one import for a tier and its arithmetic. */
export type { TicketTypeRecord };

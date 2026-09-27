/**
 * Persistence port for ticket tiers.
 *
 * The domain declares what it needs; `src/server/db` supplies the Prisma
 * implementation. Every counter method here is specified in terms of *atomicity*,
 * not just its result, because that is the part a fake repository cannot prove and
 * the part that is load-bearing (rule 07, PRD §10's last-unit race).
 */

import type { PagedResult, PageRequest, TicketTypeRecord } from "../events/event";
import type {
  CreateTicketTypeCommand,
  TicketTypeWriteSet,
} from "./ticket-type";

export interface CreateTicketTypeRecord {
  readonly eventId: string;
  readonly command: CreateTicketTypeCommand;
}

export interface UpdateTicketTypeRecord {
  readonly id: string;
  readonly changes: TicketTypeWriteSet;
}

export interface ListTicketTypesQuery extends PageRequest {
  readonly eventId: string;
}

export interface TicketTypeRepository {
  /**
   * Run `work` against a handle bound to a single transaction, returning its
   * result; a throw rolls every write back. Same shape as `EventRepository.transact`
   * so both ports read alike.
   */
  transact<T>(work: (repository: TicketTypeRepository) => Promise<T>): Promise<T>;

  /**
   * Insert a tier, with `quantity_confirmed` and `quantity_held` left at `0`.
   *
   * Initialisation is the column default, not an application-supplied value: the
   * service has no business choosing inventory state, and PRD §7.2 states the
   * default.
   *
   * Implementations MUST surface a `UNIQUE(event_id, name)` violation as a domain
   * `ConflictError` so the client gets `409` rather than a `500`. The unique index
   * is the real arbiter — a pre-flight existence check would be a check-then-act
   * race (rule 07).
   */
  createTicketType(input: CreateTicketTypeRecord): Promise<TicketTypeRecord>;

  /**
   * Load one tier by id, regardless of owner or event.
   *
   * Unscoped on purpose: the service must distinguish "no such tier" (`404`) from
   * "not on this event / not yours" (`403`) and "a tier of another event" (`404`,
   * per R-3's anti-enumeration rule), which a scoped query cannot express.
   */
  findTicketTypeById(id: string): Promise<TicketTypeRecord | null>;

  /**
   * Apply a partial update and return the stored row.
   *
   * `updated_at` is advanced by the implementation.
   *
   * Implementations MUST let a `quantity_total` reduction below
   * `quantity_confirmed + quantity_held` be refused **by the database** and surface
   * the constraint violation as a `ValidationError` naming `quantity_total`. The
   * skill's step 9 requires the CHECK to do the refusing, not a pre-check in code;
   * a pre-check would be a second rule that can drift from the first.
   */
  updateTicketType(input: UpdateTicketTypeRecord): Promise<TicketTypeRecord>;

  /**
   * Remove a tier.
   *
   * `Registration.ticket_type_id` is `RESTRICT` (PRD §7.2), so a tier that a
   * registration still references cannot be deleted — that is the documented
   * "RESTRICT on delete if Registrations exist". Implementations MUST surface the
   * foreign-key violation as a `ConflictError` (`409`, rule 06's state conflict)
   * rather than a `500`.
   */
  deleteTicketType(id: string): Promise<void>;

  /** One page of an event's tiers plus the count of the whole set, not the table. */
  listTicketTypes(query: ListTicketTypesQuery): Promise<PagedResult<TicketTypeRecord>>;

  /**
   * §9.3 `AVAILABLE → HELD`: increment `quantity_held` by `quantity`.
   *
   * MUST be a single conditional `UPDATE ... WHERE quantity_confirmed +
   * quantity_held + $quantity <= quantity_total RETURNING *`, never a read
   * followed by a write. Two callers racing the last unit both pass a read, and the
   * loser must be turned away by the *statement* — which is what makes "exactly one
   * of two concurrent attempts succeeds" (PRD §10, rule 07) a property of the
   * database rather than of timing.
   *
   * Returns `null` when the condition does not hold, so the service can answer
   * `409` (PRD §15: an unavailable tier is a state conflict).
   */
  holdInventory(ticketTypeId: string, quantity: number): Promise<TicketTypeRecord | null>;

  /**
   * §9.3 `HELD → AVAILABLE`: decrement `quantity_held` by `quantity`.
   *
   * MUST be a single conditional statement guarded so `quantity_held` cannot go
   * negative — the non-negative CHECK is the arbiter, and a release larger than the
   * hold must be a rejected write, not a silently clamped one.
   *
   * Returns `null` when the guard does not hold, so the caller can treat a
   * double-release as a lost race rather than corrupting stock.
   */
  releaseInventory(ticketTypeId: string, quantity: number): Promise<TicketTypeRecord | null>;

  /**
   * §9.3 `HELD → CONFIRMED`, the tier half of PRD §8.5's atomic confirmation
   * transaction: `quantity_confirmed` up, `quantity_held` down.
   *
   * MUST be ONE statement doing both, not two. Interleaving them would expose a
   * window in which the units are counted as neither held nor confirmed, i.e.
   * double-sellable. The total of the two counters is unchanged, so the sum CHECK
   * is satisfied throughout and cannot catch such a bug — that is exactly why the
   * pairing has to be atomic in the statement itself.
   */
  confirmInventory(ticketTypeId: string, quantity: number): Promise<TicketTypeRecord | null>;
}

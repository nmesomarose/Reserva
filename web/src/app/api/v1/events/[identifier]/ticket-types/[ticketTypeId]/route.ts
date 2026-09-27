import { NextResponse } from "next/server";

import { organiserContextResolver } from "@/server/auth/organiser-context";
import { getTicketTypeService } from "@/server/db/container";
import { toErrorResponse } from "@/server/http/error-response";
import {
  parseUpdateTicketTypeRequest,
  readJsonObject,
} from "@/server/validation/validation";

/**
 * `PATCH` / `DELETE /api/v1/events/{id}/ticket-types/{ticket_type_id}`
 * (auth: Organiser who owns the event).
 *
 * Approved 2026-09-26 (product-owner decision R-4) — the counterpart to
 * `GET /api/v1/events/{id}/ticket-types`. PRD v2 §12 lists only the collection
 * `POST`, so both routes here are additions and are recorded as such; the skill's
 * "When to use" needs both, since a tier's name, description, price, and
 * `quantity_total` are all editable (FR-5/FR-6) with no documented way to do it.
 *
 * The tier is resolved *through the owned event* rather than by `ticket_type_id`
 * alone, so a valid id belonging to a different event is a `404` rather than a
 * cross-event mutation. That check lives in `TicketTypeService`, not here, because
 * it is a business rule (AGENTS.md §4, rule 05).
 *
 * `PATCH` is a merge, not a replace: a key that is absent leaves the column alone,
 * an explicit `null` clears `description`. The inventory counters are not
 * patchable at all — they move only through the §9.3 conditional transitions, so a
 * body naming them is a `400` from the field allowlist rather than a silently
 * ignored key.
 *
 * `quantity_total` cannot be reduced below `quantity_confirmed + quantity_held`.
 * The database CHECK decides that (skill step 9) and the adapter reports it as a
 * `400` naming the field; this handler adds no pre-check of its own, because a
 * pre-check would be a second rule that can disagree with the first.
 */

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ identifier: string; ticketTypeId: string }>;
}

export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const organiser = await organiserContextResolver.resolve(request);
    const { identifier, ticketTypeId } = await context.params;

    const patch = parseUpdateTicketTypeRequest(await readJsonObject(request));

    const tier = await getTicketTypeService().updateTicketType(
      organiser.organiserId,
      identifier,
      ticketTypeId,
      patch,
    );

    return NextResponse.json(tier, { status: 200 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * `DELETE` returns `204` with no body.
 *
 * A hard delete, not a soft one: PRD §14's retention rule governs audit and payment
 * evidence, and a tier is configuration. The database still holds the veto — a tier
 * a registration references cannot be removed (`Registration.ticket_type_id` is
 * `RESTRICT`, PRD §7.2), which surfaces as a `409`. So sales history cannot be
 * orphaned through this route; the tier simply cannot be deleted while it has any.
 */
export async function DELETE(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const organiser = await organiserContextResolver.resolve(request);
    const { identifier, ticketTypeId } = await context.params;

    await getTicketTypeService().deleteTicketType(
      organiser.organiserId,
      identifier,
      ticketTypeId,
    );

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

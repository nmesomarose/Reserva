import { NextResponse } from "next/server";

import { organiserContextResolver } from "@/server/auth/organiser-context";
import { getTicketTypeService } from "@/server/db/container";
import { toErrorResponse } from "@/server/http/error-response";
import {
  parseCreateTicketTypeRequest,
  parseListTicketTypesQuery,
  readJsonObject,
} from "@/server/validation/validation";

/**
 * `POST /api/v1/events/{id}/ticket-types` — create a ticket tier
 * (PRD v2 §12, auth: Organiser who owns the event).
 *
 * This is PRD §12's own row for ticket types: request fields name,
 * price_minor_units, currency, quantity_total; response the created TicketType;
 * `400` on invalid pricing or quantity. The optional `description` comes from the
 * skill's step 2 and from §7.2's nullable column.
 *
 * `identifier` is the **event id**. Ownership is verified server-side against the
 * authenticated session (PRD §3, rule 05), never from the body, so a tier can
 * never be attached to somebody else's event.
 *
 * Intentionally thin (AGENTS.md §4): parse, delegate, translate. The duplicate-name
 * `409`, the `403` on a foreign event, and the `400` on an illegal `quantity_total`
 * reduction all live in the service or the adapter, not here.
 *
 * The response is the *organiser* projection, which includes the inventory
 * counters. That is a deliberate asymmetry with the public `TicketTypeSummaryDTO`
 * (PRD §13): an organiser must be able to see committed and held stock to know
 * which `quantity_total` changes are legal, while those counters must never reach
 * an attendee.
 */

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ identifier: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    // Authenticate before parsing, so an unauthorised caller cannot make the
    // server do work on their behalf.
    const organiser = await organiserContextResolver.resolve(request);
    const { identifier } = await context.params;

    const command = parseCreateTicketTypeRequest(await readJsonObject(request));

    const tier = await getTicketTypeService().createTicketType(
      organiser.organiserId,
      identifier,
      command,
    );

    return NextResponse.json(tier, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * `GET /api/v1/events/{id}/ticket-types` — the caller's own tiers for one event
 * (auth: Organiser who owns the event).
 *
 * Approved 2026-09-26 (product-owner decision R-4). PRD §12's table has only the
 * `POST` above, so this route is an addition and is recorded as one — but without
 * it FR-5/FR-6 are only half deliverable: tiers could be written and shown to the
 * public with no way for the organiser to see or edit the ones they created. The
 * precedent is `GET /api/v1/events`, added the same way for the same reason.
 *
 * Response is the pagination envelope rule 06 mandates for every list endpoint:
 * `{ data, page, page_size, total }`, with `total` counting the tiers on this
 * event. An event with no tiers is a `200` with `data: []`, never a `404`.
 *
 * Ordering is deterministic (`name`, then `id`) and index-backed by
 * `ticket_types_event_id_name_key`; without a pinned order, paging would silently
 * repeat and drop rows.
 *
 * There is deliberately no filter parameter. PRD §12 scopes the extra list
 * parameters to two endpoints — "Search additionally supports `query`; requests
 * additionally supports `status`" — and this is neither. Scoping is by ownership of
 * the event in the path, which is enforced server-side and cannot be widened by a
 * query parameter.
 */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const organiser = await organiserContextResolver.resolve(request);
    const { identifier } = await context.params;

    const query = parseListTicketTypesQuery(new URL(request.url).searchParams);

    return NextResponse.json(
      await getTicketTypeService().listTicketTypes(organiser.organiserId, identifier, query),
      { status: 200 },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

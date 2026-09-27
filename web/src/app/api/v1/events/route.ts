import { NextResponse } from "next/server";

import { organiserContextResolver } from "@/server/auth/organiser-context";
import { getEventService } from "@/server/db/container";
import { toErrorResponse } from "@/server/http/error-response";
import { parseListEventsQuery, parseCreateEventRequest, readJsonObject } from "@/server/validation/validation";

/**
 * `POST /api/v1/events` — create an event (PRD v2 §12, auth: Organiser).
 *
 * Request fields, verbatim from §12: name, description, starts_at, ends_at,
 * venue. Response: the created Event. Errors: `400` on invalid fields.
 *
 * This handler is intentionally thin (AGENTS.md §4): parse, delegate, translate.
 * It contains no business rule — the slug, the `draft` default, and the
 * organiser-ownership guarantee all live in `EventService`.
 *
 * On the organiser identity: §12 annotates this endpoint "auth: Organiser", but
 * §3/§19 defer the mechanism. It was decided on 2026-09-26 as email + password
 * with a server-side session, so the request is routed through
 * `src/server/auth/organiser-context.ts`, which resolves the
 * `organiser_session` cookie and fails closed with `403 unauthenticated` when
 * there is no valid session. The identity comes from that session and never from
 * the body, so a caller cannot create an event owned by someone else.
 */

export async function POST(request: Request): Promise<NextResponse> {
  try {
    // Order matters: authenticate before reading the body, so an unauthorised
    // caller cannot make the server do parsing work on their behalf.
    const organiser = await organiserContextResolver.resolve(request);

    const command = parseCreateEventRequest(await readJsonObject(request));

    const event = await getEventService().createEvent(organiser.organiserId, command);

    return NextResponse.json(event, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * `GET /api/v1/events` — the caller's own event list (auth: Organiser).
 *
 * Approved 2026-09-26; PRD v2 §12 previously had no list route even though §7.2
 * L190 specifies an `(organiser_id, status)` index specifically "for organiser's
 * event list".
 *
 * Response is the pagination envelope `.agents/rules/06` mandates for *every*
 * list endpoint: `{ data, page, page_size, total }`, with `total` counting the
 * filtered set. An organiser with no events gets `200` and `data: []` — never a
 * `404`. `page_size` above the 50 hard cap is rejected rather than clamped.
 *
 * Soft-deleted events are excluded server-side: a deleted event is no longer part
 * of the organiser's working set.
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const organiser = await organiserContextResolver.resolve(request);

    const query = parseListEventsQuery(new URL(request.url).searchParams);

    return NextResponse.json(
      await getEventService().listEvents(organiser.organiserId, query),
      { status: 200 },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

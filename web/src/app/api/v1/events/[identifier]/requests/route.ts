import { NextResponse } from "next/server";

import { getRequestService } from "@/server/db/container";
import { organiserContextResolver } from "@/server/auth/organiser-context";
import { toErrorResponse } from "@/server/http/error-response";
import { parseListAttendeeRequestsQuery, requirePathUuid } from "@/server/validation/validation";

/**
 * `GET /api/v1/events/{id}/requests` — the organiser's queue of attendee questions
 * (PRD v2 §12 row 12, auth: **Organiser, event owner**; FR-24, §5.8, §13).
 *
 * The identity is resolved *before* the path is read, and the path's `{identifier}` is
 * then compared against the session's own organiser id inside the service
 * (`requireOwnedEvent`). The id in the path is never the scope: it selects which event
 * to *check*. A session for organiser A asking for event B's queue is refused, and the
 * adapter additionally scopes the query by `event_id`, so even a bug past the ownership
 * check could not return another event's rows.
 *
 * Contact details are **masked** in every row (`attendee_email_masked`,
 * `attendee_phone_masked`). A queue is a working list, not a contact export: §13's
 * allow-list for this view does not include the unmasked address, and the full value is
 * reachable only through the registration record, where an organiser has gone looking
 * for one specific attendee. The attendee's **name** is present because a queue is
 * unusable without knowing who is asking.
 *
 * The response is a normal paginated envelope — `data`, `page`, `page_size`, `total` —
 * where `total` is the count of the *filtered* set (rule 06), so a `status=open` filter
 * reports how many open requests there are rather than how many there have ever been.
 * Zero matches is a `200` with `data: []`, never a `404`: an empty queue is the expected
 * state of a quiet event, and §4.4.1 asks for an explicit empty state rather than an
 * error.
 *
 * Ordering is newest-first with `id` as the tiebreak, so two requests created in the same
 * millisecond cannot swap places between pages.
 */

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ identifier: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const organiser = await organiserContextResolver.resolve(request);
    const { identifier } = await context.params;

    const { status, ...page } = parseListAttendeeRequestsQuery(
      new URL(request.url).searchParams,
    );

    return NextResponse.json(
      await getRequestService().listRequests(
        organiser.organiserId,
        // Unvalidated client input, and the ownership read casts it to `uuid`: a typo
        // would come back as a `500` from the cast rather than the `400` it is.
        requirePathUuid(identifier, "identifier"),
        page,
        status,
      ),
      { status: 200 },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

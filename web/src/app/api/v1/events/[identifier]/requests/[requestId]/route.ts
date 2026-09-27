import { NextResponse } from "next/server";

import { getRequestService } from "@/server/db/container";
import { organiserContextResolver } from "@/server/auth/organiser-context";
import { toErrorResponse } from "@/server/http/error-response";
import {
  parseResolveAttendeeRequestRequest,
  readJsonObject,
  requirePathUuid,
} from "@/server/validation/validation";

/**
 * `PATCH /api/v1/events/{id}/requests/{request_id}` — answer or resolve an attendee
 * request (PRD v2 §12 row 12, R-5 G-3; auth: **Organiser, event owner**; FR-24, §5.8,
 * §14).
 *
 * This is the `PATCH` §12's own table specifies, on the path §12 specifies. The product
 * owner approved it explicitly (R-5 G-3) rather than leaving the request lifecycle without
 * a write, and it is a `PATCH` rather than a `POST` because the *stored row* is being
 * updated: §14 retains the request and its resolution, and never deletes either.
 *
 * The identity is resolved before the path, and ownership is checked before the request is
 * read, so an organiser cannot learn that a request id exists on another event's queue.
 * A request that is not on this event is a `404` — the same answer an id that does not
 * exist gets, which is what keeps the route from being an oracle across tenants.
 *
 * Three outcomes are worth distinguishing on the door between them, because a volunteer
 * cannot act on a message that does not say which happened:
 *
 *   - `200` — the response was recorded. A notes-only write is *not* a resolution: the
 *     request stays `open`, so "I've told them" and "this is finished" remain
 *     distinguishable in the queue.
 *   - `400` — the body could not be a resolution. An empty patch, or `status:
 *     "resolved"` with no `resolution_notes`, is refused by name: a resolution nobody can
 *     read is not a resolution.
 *   - `409` — the request was already resolved. The message names the instant it was
 *     resolved and states that the retained resolution is not changed, because §14's
 *     retention rule means the first resolution stands and this one is refused rather
 *     than merged. This is also the answer to a **reopen**: `resolved` is terminal, so
 *     `status: "open"` on a resolved request is a `409` and not a `400` — the request was
 *     well-formed, it collided with state.
 *
 * The same `409` is returned when a second organiser resolves the request between this
 * one's read and its write, because the terminal-state rule is enforced in the database
 * statement rather than only in this check.
 */

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ identifier: string; requestId: string }>;
}

export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const organiser = await organiserContextResolver.resolve(request);
    const { identifier, requestId } = await context.params;

    const command = parseResolveAttendeeRequestRequest(await readJsonObject(request));

    return NextResponse.json(
      await getRequestService().respondToRequest(
        organiser.organiserId,
        // Both path segments are unvalidated client input, and the adapter's first
        // statement casts each to `uuid`, so a typo would come back as a `500` from the
        // cast rather than the `400` it is. Validated here for that reason alone.
        requirePathUuid(identifier, "identifier"),
        requirePathUuid(requestId, "request_id"),
        command,
      ),
      { status: 200 },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

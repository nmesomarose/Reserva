import { NextResponse } from "next/server";

import { organiserContextResolver } from "@/server/auth/organiser-context";
import { getEventService } from "@/server/db/container";
import { toErrorResponse } from "@/server/http/error-response";
import {
  parseUpdateEventRequest,
  readJsonObject,
} from "@/server/validation/validation";

/**
 * The single dynamic segment under `/api/v1/events`.
 *
 * It is addressed by **slug** for the public `GET` (PRD v2 §12) and by **id** for
 * the organiser `PATCH`/`DELETE` (approved 2026-09-26). Both are the same URL, so
 * they must share one folder: Next.js rejects two different dynamic names at the
 * same level. The parameter is therefore called `identifier` and each handler
 * documents which meaning it is reading.
 *
 * `GET` is unauthenticated and the other two are organiser-only. They coexist
 * here because the methods do not overlap, so no handler can leak the other's
 * scope.
 */

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ identifier: string }>;
}

/**
 * `GET /api/v1/events/{slug}` — public event page (PRD v2 §12, auth: none).
 *
 * Here `identifier` is a **slug**. Response: the Event plus its ticket tiers and
 * programme as a public-safe DTO (§13). Errors: `404` when the slug does not
 * resolve to a published event.
 *
 * `404` deliberately covers "no such slug", "still a draft", "closed", and
 * "soft-deleted" alike. A public endpoint that answered differently for each
 * would confirm the existence of unpublished events, so
 * `EventService.getPublicEvent` raises the same `not_found` for all four.
 *
 * Next.js 15+ delivers `params` as a promise; it is awaited before use.
 */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const { identifier } = await context.params;

    return NextResponse.json(await getEventService().getPublicEvent(identifier), {
      status: 200,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * `PATCH /api/v1/events/{id}` — organiser edits their own event (auth: Organiser).
 *
 * Approved 2026-09-26; PRD v2 §12 previously listed no update route. FR-4 (L103)
 * requires edits both before and after publication, and the lifecycle transition
 * rides on this method (decision D2) rather than on separate publish/close
 * routes. Request fields: any subset of name, description, starts_at, ends_at,
 * venue, status.
 *
 * `identifier` is an **id** here. Ownership is re-checked server-side on every
 * call inside `EventService` — the id in the path is never treated as proof.
 * Whether the requested `status` change is legal is a state question the service
 * answers (`409` when it is not), not something the body can declare.
 */
export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    // Authenticate before reading the body, so an unauthorised caller cannot make
    // the server do parsing work on their behalf.
    const organiser = await organiserContextResolver.resolve(request);
    const { identifier } = await context.params;

    const command = parseUpdateEventRequest(await readJsonObject(request));

    const event = await getEventService().updateEvent(
      organiser.organiserId,
      identifier,
      command,
    );

    return NextResponse.json(event, { status: 200 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * `DELETE /api/v1/events/{id}` — soft-delete an event (auth: Organiser).
 *
 * Approved 2026-09-26. Sets `deleted_at` and never removes the row (PRD v2 §14
 * L421: the audit trail outranks the deletion request). The event stops appearing
 * on the public route immediately.
 *
 * `204` rather than a body: a soft-deleted event still exists, so a `200` would
 * imply a resource payload — and the organiser projection deliberately has no
 * `deleted_at` field, so such a body could not show the caller the one thing the
 * response was about. The organiser refetches the list instead.
 */
export async function DELETE(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const organiser = await organiserContextResolver.resolve(request);
    const { identifier } = await context.params;

    await getEventService().softDeleteEvent(organiser.organiserId, identifier);

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

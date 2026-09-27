import { NextResponse } from "next/server";

import { organiserContextResolver } from "@/server/auth/organiser-context";
import { getEventService } from "@/server/db/container";
import { toErrorResponse } from "@/server/http/error-response";
import {
  parseUpdateProgrammeItemRequest,
  readJsonObject,
} from "@/server/validation/validation";

/**
 * `PATCH` / `DELETE /api/v1/events/{id}/programme/{item_id}` (auth: Organiser).
 *
 * Approved 2026-09-26.
 *
 * The line is resolved *through the owned event* rather than by `item_id` alone,
 * so an `item_id` that belongs to a different event is a `404` rather than a
 * cross-event mutation. That check lives in `EventService`, not here, because it
 * is a business rule (AGENTS.md §4).
 *
 * `PATCH` is a merge, not a replace: a key that is absent leaves the column
 * alone, while an explicit `null` clears it. That distinction is what lets
 * `time` and `description` be emptied without resending the whole line.
 */

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ identifier: string; itemId: string }>;
}

export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const organiser = await organiserContextResolver.resolve(request);
    const { identifier, itemId } = await context.params;

    const patch = parseUpdateProgrammeItemRequest(await readJsonObject(request));

    const item = await getEventService().patchProgrammeItem(
      organiser.organiserId,
      identifier,
      itemId,
      patch,
    );

    return NextResponse.json(item, { status: 200 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const organiser = await organiserContextResolver.resolve(request);
    const { identifier, itemId } = await context.params;

    await getEventService().removeProgrammeItem(organiser.organiserId, identifier, itemId);

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

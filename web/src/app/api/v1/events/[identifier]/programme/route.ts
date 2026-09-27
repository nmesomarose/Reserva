import { NextResponse } from "next/server";

import { organiserContextResolver } from "@/server/auth/organiser-context";
import { getEventService } from "@/server/db/container";
import { toErrorResponse } from "@/server/http/error-response";
import {
  parseCreateProgrammeItemRequest,
  readJsonObject,
} from "@/server/validation/validation";

/**
 * `POST /api/v1/events/{id}/programme` — add a programme line (auth: Organiser).
 *
 * Approved 2026-09-26. PRD v2 §12 previously defined **no** route able to author a
 * `ProgrammeItem`, which left FR-2 (L101) and §20 L491 ("Event creation with
 * ordered programme") only half-deliverable: the order could be stored and served
 * but nothing could write it.
 *
 * `identifier` is the **event id**. Ownership of the parent event is verified
 * server-side, so a programme line can never be attached to somebody else's
 * event.
 *
 * `sort_order` is supplied by the caller because FR-2 requires the order to be
 * stored rather than inferred. The service does not renumber anything — the
 * `(event_id, sort_order)` index is deliberately non-unique so an organiser
 * reorders by rewriting the integers.
 *
 * `201` returns the organiser-facing programme line, which carries `id` so the
 * caller can address `PATCH`/`DELETE` on it.
 */

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ identifier: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const organiser = await organiserContextResolver.resolve(request);
    const { identifier } = await context.params;

    const input = parseCreateProgrammeItemRequest(await readJsonObject(request));

    const item = await getEventService().addProgrammeItem(
      organiser.organiserId,
      identifier,
      input,
    );

    return NextResponse.json(item, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

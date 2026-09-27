import { NextResponse } from "next/server";

import { getStaffService } from "@/server/db/container";
import { toErrorResponse } from "@/server/http/error-response";
import { staffContextResolver } from "@/server/staff/staff-context";
import {
  parseCheckInRequest,
  readOptionalJsonObject,
  requirePathUuid,
} from "@/server/validation/validation";

/**
 * `POST /api/v1/registrations/{id}/check-in` — check an attendee in
 * (PRD v2 §12, auth: **Staff, event-scoped**; FR-20, FR-21, §4.3, §4.4, §9.4).
 *
 * THE ENDPOINT IS THE SECURITY BOUNDARY, which is the single most important sentence
 * in this file. AGENTS.md §7: "a hidden button is not a security boundary". So
 * FR-21's rule — a non-confirmed registration must not be checkable — is enforced by
 * this route's own service call returning `409`, and the eligibility guard runs
 * *inside the write transaction* (skill step 5) rather than in a read that could
 * race. A `200` here means a confirmed registration gained an append-only check-in
 * row and a `checked_in` projection, together.
 *
 * There is no event id in this path, and that asymmetry with the search route is
 * deliberate. The scope check is the registration's own `event_id` compared against
 * the token's, inside the guarded write — so a token for event A pointed at event B's
 * registration gets a `404`, indistinguishable from an id that does not exist. That
 * is the anti-enumeration half of PRD §15/§18, and it is why the two routes use
 * different codes for a scope failure: the search route answers `403` because the
 * client contradicted its own token about a *claimed* scope, and this one answers
 * `404` because no scope was claimed at all and the answer must not become an oracle
 * for other events' registration ids.
 *
 * The `409` cases are kept distinct, because AGENTS.md §11.2 requires the door to be
 * able to act on the difference and because a volunteer cannot act on a message that
 * does not say which it was:
 *
 *   - already checked in, no `override` — names the ORIGINAL check-in timestamp, so
 *     staff can find out who let them in (§4.4.4);
 *   - not eligible (pending, cancelled, refunded) — says the payment is not
 *     confirmed and points at the organiser (§4.4.3), which is the escalation path.
 *
 * `201` on success: a Check-in row is a created resource. An override is a *second*
 * distinct row, not an edit, and the response says `is_override: true` so the client
 * can present it as the deliberate action it is (BR-4).
 */

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const staff = await staffContextResolver.resolve(request);
    const { id } = await context.params;

    // A body is optional here: a first check-in carries no fields, and several
    // clients send `POST` with none at all. `{}` is a valid request.
    const command = parseCheckInRequest(await readOptionalJsonObject(request));

    // The id is a path segment, so it arrives unvalidated. The guarded write casts it
    // to `uuid`, so a malformed value would come back as a `500` from the cast rather
    // than the `400` a typo deserves.
    return NextResponse.json(await getStaffService().checkIn(staff, requirePathUuid(id, "id"), command), {
      status: 201,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

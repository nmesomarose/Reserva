import { NextResponse } from "next/server";

import { getOperationsService } from "@/server/db/container";
import { organiserContextResolver } from "@/server/auth/organiser-context";
import { toErrorResponse } from "@/server/http/error-response";
import { NO_STORE_HEADERS } from "@/server/http/no-store";
import { requirePathUuid } from "@/server/validation/validation";

/**
 * `GET /api/v1/events/{id}/registrations/{registration_id}` — the full record behind one
 * of the dashboard's numbers (PRD v2 §5.9, auth: **Organiser, event owner**; FR-26;
 * R-5 G-1).
 *
 * §5.9 asks for "**all** payment attempts" and "**all** check-in records", and repeats
 * that it is not "just the latest" and not "just current status". That phrasing is the
 * reason this exists separately from the staff search, which returns one summary row per
 * attendee: a search row answers neither question, and §5.9's operator genuinely needs the
 * attempt history to answer "why is this one flagged?".
 *
 * The `payments` array is **newest first**, so element zero is the attempt a dispute is
 * about, and `check_ins` is **oldest first**, so element zero is the original entry
 * (§4.4.4) with any BR-4 override following it. The order is fixed in the adapter rather
 * than left to a client, because a different order would answer a different question.
 *
 * `raw_provider_payload` appears here and nowhere else. Rule 08 permits full provider
 * payloads to organiser/audit surfaces, and this is that surface: §14 retains the payload
 * for dispute resolution, and a summarised version would be a second thing to keep
 * faithful. It is never projected into an attendee response (the evidence endpoint) or a
 * staff response, and the tests assert the absence by field name rather than trusting the
 * mapper.
 *
 * Ownership of the event is checked first, and the adapter scopes the registration read by
 * `event_id` as well, so a registration id from another event is a `404` — the same answer
 * an id that does not exist gets. One answer is what stops this route confirming that an
 * id exists on somebody else's event (rule 08).
 *
 * The event is included, read **live** (BR-6): a reschedule after the sale reaches the
 * record rather than being frozen at purchase time.
 *
 * R-5 G-1 records the one place this endpoint adds to §12's table; the product owner
 * approved it, and it is listed in `docs/evidence/requirements-matrix.md` rather than
 * presented as a §12 endpoint.
 */

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ identifier: string; registrationId: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const organiser = await organiserContextResolver.resolve(request);
    const { identifier, registrationId } = await context.params;

    return NextResponse.json(
      await getOperationsService().getRegistrationRecord(
        organiser.organiserId,
        // Both path segments are unvalidated client input, and the adapter's first
        // statement casts each to `uuid`, so a typo would come back as a `500` from the
        // cast rather than the `400` it is. Validated here for that reason alone.
        requirePathUuid(identifier, "identifier"),
        requirePathUuid(registrationId, "registration_id"),
      ),
      // Unmasked attendee contact plus the raw provider payload, organiser-only: caching
      // this is caching PII, so the response is never stored.
      { status: 200, headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

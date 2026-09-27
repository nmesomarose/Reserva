import { NextResponse } from "next/server";

import { getOperationsService } from "@/server/db/container";
import { organiserContextResolver } from "@/server/auth/organiser-context";
import { toErrorResponse } from "@/server/http/error-response";
import { NO_STORE_HEADERS } from "@/server/http/no-store";
import { requirePathUuid } from "@/server/validation/validation";

/**
 * `GET /api/v1/events/{id}/dashboard` — the organiser's per-event picture
 * (PRD v2 §12 row 13, auth: **Organiser, event owner**; FR-25, §5.9, §13, §17).
 *
 * The session is resolved before the path, and ownership of `{identifier}` is checked in
 * the service before a single aggregate statement runs. The path id selects which event
 * to check; it is never the authority for the scope (rule 05).
 *
 * What the response contains is four aggregates and nothing else — registrations,
 * payments, per-tier sales, check-ins — plus the event's identity and the instant the
 * snapshot was taken. There is no revenue figure, no refund total, and no per-attendee
 * row: FR-25 names four aggregates, and the dashboard skill's stop condition requires a
 * new one to be raised rather than added silently. A dashboard that grows a number nobody
 * asked for is how a product acquires metrics it cannot keep truthful.
 *
 * `generated_at` is not decoration. A dashboard is a *reading*, and on a busy event the
 * numbers move while the organiser looks at them; without a timestamp two reads of the
 * same page are indistinguishable from a dashboard that is lying.
 *
 * The counts come from a `REPEATABLE READ` snapshot, so the registration total and the
 * check-in count describe the same instant. §17 promises zero discrepancy, and under the
 * default isolation a concurrent check-in could make those two disagree by timing alone.
 *
 * This is the *snapshot* endpoint. For live updates the product uses
 * `GET /api/v1/events/{id}/dashboard/stream` (R-5 G-2, FR-22); the two share the same
 * service, so a stream's first event and this response are the same shape built by the
 * same arithmetic.
 */

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ identifier: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const organiser = await organiserContextResolver.resolve(request);
    const { identifier } = await context.params;

    return NextResponse.json(
      await getOperationsService().getDashboard(
        organiser.organiserId,
        // Unvalidated client input, and the ownership read casts it to `uuid`: a typo
        // would come back as a `500` from the cast rather than the `400` it is.
        requirePathUuid(identifier, "identifier"),
      ),
      // Organiser-only aggregate: a shared cache replaying one organiser's dashboard to
      // another would disclose live revenue and attendance, so the response is never
      // stored (the same policy `GET /payments/verify` already applies to payment state).
      { status: 200, headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

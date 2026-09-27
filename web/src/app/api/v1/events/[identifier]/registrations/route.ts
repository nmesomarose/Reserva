import { NextResponse } from "next/server";

import { getRegistrationService } from "@/server/db/container";
import { toErrorResponse } from "@/server/http/error-response";
import {
  parseCreateRegistrationRequest,
  readJsonObject,
} from "@/server/validation/validation";

/**
 * `POST /api/v1/events/{id}/registrations` — submit a registration and start its
 * payment (PRD v2 §12, auth: **Public**; FR-8, FR-9, FR-10, FR-10a, FR-11, §5.3).
 *
 * Request fields, exactly as §12 lists them: `attendee_name`, `email`, `phone`,
 * `ticket_type_id`, `idempotency_key`. Response: "draft registration + payment
 * redirect URL" — this product's {@link RegistrationCheckoutDTO}, which carries the
 * attendee's reference, the tier, the amounts, the state, and the hosted link.
 *
 * `identifier` is the event **id**. Note the tension with the public event page,
 * which is addressed by slug: this endpoint is not a browsable resource, it is the
 * submission target of a form rendered from that page, and §12's row for it says
 * `{id}`.
 *
 * **No session is read here, deliberately.** §12 marks the endpoint Public, and an
 * attendee has no platform account (PRD §3). Auth exists on this route only in the
 * sense that nothing about the event is trusted: the service re-reads the event and
 * requires it to be `published` and not soft-deleted, and the tier must belong to it
 * and have availability. A draft or soft-deleted event is reported as `404` with one
 * message, so an anonymous caller cannot map unpublished events by status code.
 *
 * Deliberately thin (AGENTS.md §4): parse, delegate, translate. Everything with a
 * product meaning lives in `RegistrationService.createRegistration` and its
 * repository transaction:
 *
 *   - the `409` for a sold-out tier and the `409` for a reused `idempotency_key` on
 *     a materially different body (rule 06: one condition, one message, wherever the
 *     fact is detected);
 *   - replaying the same key returning the original result — including its original
 *     redirect, read from the stored provider payload, with no second provider call;
 *   - the amount, which is computed from the stored tier (FR-11) and never read from
 *     this body.
 *
 * ## `201` versus `200`
 *
 * `201` when this call created the registration; `200` when it returned an existing
 * one. That distinction is not cosmetic: §12 requires a replay to return "the original
 * result, not a new row", and a `201` on a replay tells a client that something was
 * created that it already had — enough, for an idempotent client that keys on the
 * status, to count a retry as a second purchase. The fact itself comes from the
 * service, not from a guess made here.
 *
 * ## A `null` redirect is a real answer
 *
 * When the provider could not be reached, or rate-limited us, the registration and
 * its attempt are returned with `redirect_url: null` and a still-`initiated` payment.
 * That is not an error response: §4's provider contract says the payment may still be
 * processing and must not be retried blindly, so the durable `Payment` row is what
 * makes a later `/payments/verify` able to resolve it. Reporting a failure here would
 * strand a payment that may have succeeded.
 */

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ identifier: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const { identifier } = await context.params;

    const command = parseCreateRegistrationRequest(await readJsonObject(request));

    const { checkout, created } = await getRegistrationService().createRegistration(
      identifier,
      command,
    );

    return NextResponse.json(checkout, { status: created ? 201 : 200 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

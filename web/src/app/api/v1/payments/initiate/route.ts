import { NextResponse } from "next/server";

import { getRegistrationService } from "@/server/db/container";
import { toErrorResponse } from "@/server/http/error-response";
import { parseInitiatePaymentRequest, readJsonObject } from "@/server/validation/validation";

/**
 * `POST /api/v1/payments/initiate` — prepare (or re-prepare) the payment for an
 * existing registration (PRD v2 §12, auth: Public, tied to a registration; FR-11).
 *
 * Request field: `registration_id` — **our** row id, which the registration response
 * is the only place an attendee gets. Not `unique_reference`: that is FR-15's
 * evidence-retrieval first factor, and turning the door reference into something an
 * unauthenticated caller can pay through would widen who can act on a registration.
 *
 * The amount is never in this body and never in the response the client trusts: it
 * is re-computed from the stored tier (FR-11), which is the "amount always
 * server-computed" note in §12's row.
 *
 * ## What this endpoint is for, given registration already returns a link
 *
 * `POST /events/{id}/registrations` returns a redirect for a *new* attempt. This one
 * covers the three cases that need a payment prepared for a registration that
 * already exists:
 *
 *   1. **Retry after a failure.** §9.1 forbids `failed → success` on one Payment row,
 *      so a genuinely failed attempt is terminal and this opens a *new* attempt row.
 *      That is the 1:N cardinality of PRD §7.3 made real.
 *   2. **Re-serve a live link.** An unresolved attempt that still has its hosted link
 *      gets the *same* link back — no new provider transaction, no new row, and
 *      therefore `200` rather than `201`. Minting a second hosted link for a live
 *      attempt would leave the first one payable, and §8.5's retry is only safe
 *      because it is keyed on one `provider_reference`.
 *   3. **A lost redirect.** The attendee lost the link and needs it again, which case
 *      2 covers.
 *
 * ## `409` for a registration that is already resolved
 *
 * A `confirmed`, `checked_in`, `cancelled`, or `refunded` registration cannot take
 * another payment, and that is a state conflict (PRD §15), not a validation failure.
 * A lapsed hold is a `409` too, and says so distinctly: the fix is to pick a tier
 * again, whereas a sold-out tier means trying later.
 *
 * Deliberately thin (AGENTS.md §4): the state rules, the R-6 price check, the
 * self-healing hold release, and the "one live link" rule all live in the service.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const { registrationId } = parseInitiatePaymentRequest(await readJsonObject(request));

    const { checkout, created } = await getRegistrationService().initiatePayment(registrationId);

    return NextResponse.json(checkout, { status: created ? 201 : 200 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

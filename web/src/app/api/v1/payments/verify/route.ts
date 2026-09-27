import { NextResponse } from "next/server";

import {
  toAttendeePaymentResolutionDTO,
  type AttendeePaymentResolutionDTO,
} from "@/domain/registrations/registration.dto";
import { getPaymentService } from "@/server/db/container";
import { toErrorResponse } from "@/server/http/error-response";
import { NO_STORE_HEADERS } from "@/server/http/no-store";
import {
  parseVerifyPaymentBodyRequest,
  parseVerifyPaymentQuery,
  readJsonObject,
} from "@/server/validation/validation";

/**
 * `POST`/`GET /api/v1/payments/verify` — resolve one payment attempt against the
 * provider (PRD v2 §12, auth: System, the redirect callback; FR-12, §8, §8.5).
 *
 * Request field: `provider_reference` — **our** `tx_ref`, the value stored in
 * `payments.provider_reference`. §12 allows `POST` **or** `GET` for this endpoint, and
 * both are implemented because they are two different callers: the `GET` is the
 * provider redirecting the attendee's browser back to
 * `<origin>/api/v1/payments/verify` (see `src/server/flutterwave/redirect-url.ts`),
 * where the reference arrives as the `tx_ref` parameter Flutterwave appends, and the
 * `POST` is a client asking about a reference it holds. The parsers accept either
 * name for the same reason, and require the two to agree when both are sent.
 *
 * Response: §12's "Confirmed/failed/pending" — one state report derived from the
 * **stored attempt**, so the answer is the same whoever asks and however often
 * (§12: "Idempotent — safe to call repeatedly").
 *
 * ## Why this route may not confirm anything by itself
 *
 * The redirect is never proof of payment. The service calls the provider's
 * server-side verification before any write, and the whole confirmation sequence is
 * one transaction that either lands completely or not at all (§8.5). The route's only
 * remaining job is to translate the outcome — see {@link renderResolution}.
 *
 * ## Status codes, and why a `failed` payment is a `200`
 *
 * §12 asks for a *report* of the state, so every reportable state is `200`:
 * `confirmed`, `pending`, `failed`, and `requires_reconciliation`. A failed payment is
 * not a failed *request*; the caller asked a question and got a true answer. §10's
 * next step for a failed payment is a new attempt through `/payments/initiate`, not an
 * error page.
 *
 * `requires_reconciliation` is likewise `200` and never a `4xx`/`5xx`: the money moved
 * and the platform has not granted value, which §17 requires to be reported as
 * needing review rather than as a failure.
 *
 * The one non-`2xx` is `not_found` — a `provider_reference` this platform never
 * issued, or whose `Payment` row no longer exists. That is §15's genuine
 * "resource does not exist", and it is a `404` rather than a `403` because nothing
 * about it needs authorising: possession of a reference is not authority over
 * anything, and the body reveals no payment detail.
 *
 * ## `no-store`
 *
 * The body is per-attendee payment state, and a `200` is cacheable by default. A
 * shared cache replaying one attendee's `confirmed` to the next person at the URL
 * would be a disclosure of exactly the kind this product's premise forbids, so the
 * response is explicitly uncacheable rather than relying on `POST` semantics — the
 * `GET` half has no such protection by default.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const { providerReference } = parseVerifyPaymentBodyRequest(await readJsonObject(request));

    return await verifyOverRedirect(providerReference);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const { providerReference } = parseVerifyPaymentQuery(new URL(request.url).searchParams);

    return await verifyOverRedirect(providerReference);
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * Run one verification and render the result.
 *
 * `verified: null` is the signal that this is the redirect channel: the service must
 * fetch the facts from the provider itself rather than being handed them (FR-12).
 */
async function verifyOverRedirect(providerReference: string): Promise<NextResponse> {
  const outcome = await getPaymentService().resolve({
    providerReference,
    channel: "redirect",
    verified: null,
  });

  return renderResolution(toAttendeePaymentResolutionDTO(outcome));
}

/**
 * Outcome to HTTP.
 *
 * The only rule is the `not_found` case, and the reason it is the only one is that
 * every other value is a true statement about a payment that exists. Documented on the
 * route above; kept as its own function so the `GET` and `POST` halves cannot drift.
 */
function renderResolution(dto: AttendeePaymentResolutionDTO): NextResponse {
  return NextResponse.json(dto, {
    status: dto.outcome === "not_found" ? 404 : 200,
    headers: NO_STORE_HEADERS,
  });
}

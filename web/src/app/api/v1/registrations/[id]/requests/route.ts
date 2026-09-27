import { NextResponse } from "next/server";

import { getRequestService } from "@/server/db/container";
import { toErrorResponse } from "@/server/http/error-response";
import {
  parseSubmitAttendeeRequestRequest,
  readJsonObject,
  requirePathUuid,
} from "@/server/validation/validation";

/**
 * `POST /api/v1/registrations/{id}/requests` — an attendee asks the organiser something
 * (PRD v2 §12 row 11, auth: **none, possession of the ticket**; FR-23, FR-23a, §5.8).
 *
 * ## Why the body re-states what the path already says
 *
 * The path names the registration, and the body carries `unique_reference` and `email`.
 * That redundancy is the contract, not a mistake: the attendee has no session, so the
 * request has to *prove* the registration is theirs on every call, and rule 05 requires
 * ownership to be re-verified rather than remembered from an earlier lookup. The path id
 * is compared against the resolved registration server-side, so a client cannot use one
 * registration's proof to file a request against another's id.
 *
 * A disagreement — a valid pair naming a different registration than the path — is a
 * field-level `400`, as §12 specifies for this endpoint. It is deliberately **not** a
 * `403`: the evidence endpoint's `403` is a refusal to disclose an existing ticket, while
 * here the two inputs simply contradict each other, and §12 assigns each endpoint its own
 * code. The message is the same single string in every failing case, so the response
 * still discloses nothing about which reference exists.
 *
 * ## `201` versus `200`, and why the route is the one that decides
 *
 * FR-23a requires a debounced submission to produce **one** request. The service returns
 * `created: false` for a replay of an `idempotency_key`, and only this route knows that
 * `201` means "created" and `200` means "here is the one you already had" — telling a
 * double-clicking client it created a second request would be a lie the organiser's queue
 * would eventually expose.
 *
 * The same key with a **materially different** body is a `409` from the service, not a
 * silent return of the old row: silently succeeding would file the new message nowhere
 * and report success, which is worse than an error.
 *
 * `idempotency_key` is a client-generated UUID for the same reason registration's is
 * (FR-10a): only a client-stable key can deduplicate two requests that left the browser
 * together.
 */

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const { id } = await context.params;

    // A path segment is unvalidated input, and the query below casts it to `uuid`; a
    // typo must be a `400` naming the field, not a `500` from the cast.
    const registrationId = requirePathUuid(id, "id");
    const command = parseSubmitAttendeeRequestRequest(
      await readJsonObject(request),
      registrationId,
    );

    const { request: body, created } = await getRequestService().submitRequest(command);

    return NextResponse.json(body, { status: created ? 201 : 200 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

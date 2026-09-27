import { NextResponse } from "next/server";

import { getEvidenceService } from "@/server/db/container";
import { toErrorResponse } from "@/server/http/error-response";
import { NO_STORE_HEADERS } from "@/server/http/no-store";
import { parseEvidenceQuery } from "@/server/validation/validation";

/**
 * `GET /api/v1/registrations/evidence?unique_reference=…&email=…` — the attendee's own
 * ticket (PRD v2 §12 row 8, auth: **none**; FR-15, FR-19, §5.5, §6.3, §8.6).
 *
 * ## Why there is no authentication here, and what replaces it
 *
 * The attendee has no account (PRD §3), so possession of the ticket PDF is the
 * credential: the printed `unique_reference` plus the email the registration was made
 * with. §12 records this design explicitly — the magic-link alternative is marked `N/A`
 * with that reason — and rule 05 permits a capability check where there is no identity to
 * check.
 *
 * Two factors, and both are load-bearing. The reference is 256 bits of base64url and so
 * is not guessable, but it *is* printed on a PDF that can be forwarded; the email is not
 * secret at all, but nobody else has it. Together they answer "do you hold this ticket?"
 * without an account, which is the whole reason the product works this way.
 *
 * ## The one rule that shapes this route
 *
 * A reference that does not exist, a reference whose email does not match, and a
 * reference belonging to somebody else all produce the **same `403` with the same
 * message** (rule 08's anti-enumeration requirement: the refusal must not differ "in
 * shape, timing, or wording"). Distinguishing them would turn this endpoint into an oracle
 * for "does this reference exist" — and the reference is on a PDF, so it is exactly the
 * kind of value that leaks.
 *
 * The `403` status rather than `404` is the same decision, in code: a `404` would say
 * "this reference is real but you may not see it", which is one bit more than the caller
 * is entitled to.
 *
 * ## What comes back
 *
 * The attendee's ticket and nothing else. No payment history, no check-in log, no
 * attendee requests, no provider payload (rule 08, `evidence.dto.ts`'s field table). The
 * stored `status` is returned verbatim so FR-19 can be honoured by the *client* — a
 * `pending_payment` registration is labelled `pending_payment`, never dressed up as a
 * valid ticket.
 *
 * `200` on success, and never a `404`: the answer to "no ticket matches" is a refusal to
 * disclose, not a statement that the resource is absent.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    // Both parameters are required and shape-checked before any query runs: a malformed
    // reference would otherwise become a lookup that could never match, dressed up as
    // the same `403` a wrong email gets — which is anti-enumeration applied so far that
    // a client bug looks like a security refusal.
    const { uniqueReference, email } = parseEvidenceQuery(new URL(request.url).searchParams);

    return NextResponse.json(
      await getEvidenceService().retrieveEvidence(uniqueReference, email),
      // The body is a live ticket, and a cached copy is a ticket that may no longer be
      // valid: a refund would leave a forwarded link serving a ticket for a seat that has
      // been sold again.
      { status: 200, headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

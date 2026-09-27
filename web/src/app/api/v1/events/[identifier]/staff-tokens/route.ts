import { NextResponse } from "next/server";

import { organiserContextResolver } from "@/server/auth/organiser-context";
import { getStaffService } from "@/server/db/container";
import { toErrorResponse } from "@/server/http/error-response";
import {
  parseCreateStaffTokenRequest,
  parseListStaffTokensQuery,
  parseRevokeStaffTokenQuery,
  readJsonObject,
} from "@/server/validation/validation";

/**
 * Organiser staff-access management on one event (PRD v2 §4.6, §12's last row:
 * `POST/GET/DELETE /api/v1/events/{id}/staff-tokens`, auth: Organiser).
 *
 * Three methods on one collection path, which is what §12 specifies — the row has no
 * `{tokenId}` segment, so `DELETE` names its target with a `token_id` query parameter
 * and the reasoning for that is recorded on `parseRevokeStaffTokenQuery` and as
 * design position P-11 in the requirements matrix.
 *
 * These are *organiser* routes, not staff routes. Staff cannot issue, list, or
 * revoke tokens (rule 05), and that is structural rather than a field check: the
 * staff bearer token is a different credential resolving to a different identity, and
 * the service methods behind these handlers take an organiser id, not a
 * `StaffContext`. A staff member calling any of the three is refused at the auth
 * boundary because they hold no organiser session.
 *
 * Thin by design (AGENTS.md §4): parse, delegate, translate. Ownership (`403` on
 * another organiser's event, `404` on an unknown one), the default expiry, and the
 * `404` for a token that belongs to a different event all live in the service.
 */

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ identifier: string }>;
}

/**
 * `POST` — issue a token, and return the plaintext exactly once.
 *
 * `201`, because a token is a created resource. The response is the only place in
 * the product where a usable credential appears: only the hash is stored, so this
 * is the sole opportunity to copy it (rule 06, AGENTS.md §14).
 */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const organiser = await organiserContextResolver.resolve(request);
    const { identifier } = await context.params;

    const command = parseCreateStaffTokenRequest(await readJsonObject(request));

    const issued = await getStaffService().issueStaffToken(
      organiser.organiserId,
      identifier,
      command,
    );

    return NextResponse.json(issued, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * `GET` — the caller's own tokens for one event, with status.
 *
 * §4.6.2 asks for "active tokens"; the listing returns every token with a computed
 * `status` of `active`/`revoked`/`expired` instead. That is a superset of what was
 * asked for, and deliberately so: a token that silently vanished from the list is
 * indistinguishable from one that never existed, and the organiser's actual question
 * at the door is "is this token still working". The `token_hash` is in no response
 * (rule 05).
 *
 * The pagination envelope is the one rule 06 mandates, and an event with no tokens
 * is a `200` with `data: []`.
 */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const organiser = await organiserContextResolver.resolve(request);
    const { identifier } = await context.params;

    const page = parseListStaffTokensQuery(new URL(request.url).searchParams);

    return NextResponse.json(
      await getStaffService().listStaffTokens(organiser.organiserId, identifier, page),
      { status: 200 },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * `DELETE` — revoke a token immediately (§4.6.2: "revocation, not row deletion").
 *
 * `200` with the token's post-revocation state rather than `204`, because the useful
 * answer to a revoke is when it took effect, and because the same shape is what a
 * repeat revoke returns — a retried request is indistinguishable from a
 * double-clicked button, and both are already satisfied.
 *
 * The row survives, and that is the point: `check_ins.staff_token_id` is `RESTRICT`
 * (PRD §7.2), so a deleted token would either orphan the audit log or cascade it, and
 * "this access existed and was pulled on this date" is itself audit information.
 */
export async function DELETE(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const organiser = await organiserContextResolver.resolve(request);
    const { identifier } = await context.params;

    const { staffTokenId } = parseRevokeStaffTokenQuery(new URL(request.url).searchParams);

    return NextResponse.json(
      await getStaffService().revokeStaffToken(
        organiser.organiserId,
        identifier,
        staffTokenId,
      ),
      { status: 200 },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

import { NextResponse } from "next/server";

import { getStaffService } from "@/server/db/container";
import { toErrorResponse } from "@/server/http/error-response";
import { staffContextResolver } from "@/server/staff/staff-context";
import { parseStaffSearchQuery } from "@/server/validation/validation";

/**
 * `GET /api/v1/events/{id}/registrations/search` — event-day search
 * (PRD v2 §12, auth: **Staff, event-scoped**; FR-17, FR-18, FR-19, §4.3, §4.4).
 *
 * The order of the first two lines is the security property of this endpoint, and it
 * is why the staff identity is resolved *before* the path is read:
 *
 *   `staffContextResolver.resolve` hashes the presented bearer token, looks the row
 *   up, and re-checks revocation and expiry. Only then does the path's `{identifier}`
 *   exist as a value — and it is compared against the token's own `event_id`, never
 *   used as the scope. A staff token for event A asking for event B's search is
 *   refused, which is what rule 05 and the staff skill's step 2 mean by "a
 *   client-supplied `event_id` that disagrees is a rejected request, not a scope
 *   override".
 *
 * Consequences worth stating, because they are what the skill's integrity checks ask
 * for:
 *
 *   - A forged or expired credential never reaches the database at all, so it cannot
 *     learn whether an event or a registration exists (§4.6.3).
 *   - A valid token for another event gets a `403` that says nothing about that
 *     event, and never widens to it.
 *   - Zero matches is a `200` with `data: []` and `total: 0` — never a `404`, and
 *     never a bare screen. §4.4.1 wants an explicit empty state with an escalation
 *     path, which is a client concern this response enables by answering normally.
 *   - Multiple matches are several rows with masked contact details (§4.4.2). The
 *     server never picks one: there is no "best match" field in the contract, and
 *     inventing one is how the wrong person gets checked in.
 *   - `check_in_eligible` is `false` for anything not `confirmed`, so a client leaves
 *     the control out rather than disabling it (FR-21, AGENTS.md §11.2).
 *
 * Deliberately absent: any `event_id` parameter, and any way to search another event.
 * There is no parameter through which a wider scope could arrive.
 */

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ identifier: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const staff = await staffContextResolver.resolve(request);
    const { identifier } = await context.params;

    const search = parseStaffSearchQuery(new URL(request.url).searchParams);

    return NextResponse.json(
      await getStaffService().searchRegistrations(staff, identifier, search.query, {
        page: search.page,
        pageSize: search.pageSize,
      }),
      { status: 200 },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

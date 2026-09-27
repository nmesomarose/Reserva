/**
 * Organiser authentication boundary (PRD v2 §3, §12).
 *
 * PRD v2 §3 fixes the *authorization model* — organiser-scoped resources are
 * authorized by `event.organiser_id == current_user.id` — while deferring the
 * *mechanism* to implementation ("Session/token mechanism (JWT vs. server
 * session …) is an implementation choice deferred to the engineering phase",
 * marked `[VERIFY / decide at implementation time]`, and repeated in §19 and
 * AGENTS.md §21.4–§21.5).
 *
 * That decision has been made — email + password with a server-side session
 * (product-owner decision 1, 2026-09-26) — so the seam below is no longer a
 * placeholder. The *shape* is unchanged, which is the point of having declared it
 * first: `OrganiserContext` and `OrganiserContextResolver` are exactly what the
 * undecided design had, and every route that codes against them needed no edit.
 *
 * What did change is the last member. The old resolver failed closed with a `501`,
 * on the reasoning that no mechanism existed to authenticate with. The new one
 * fails closed with `403` because a mechanism now exists and the caller simply
 * did not present a valid session for it.
 *
 * SECURITY PROPERTIES THIS BOUNDARY OWNS:
 *
 *   - The organiser id is resolved only from a server-verified session. There is
 *     no code path from a request body, query parameter, or unverified header to
 *     `OrganiserContext.organiserId`. That is the PRD §3 rule, and it is why this
 *     function is the single entry point rather than something routes do inline.
 *   - Any failure throws `UnauthenticatedError`, which `toErrorResponse` renders
 *     as `403` with the `unauthenticated` code. Routes therefore have no way to
 *     "handle" a missing session by continuing unauthenticated.
 */

import "server-only";

import { UnauthenticatedError } from "@/domain/errors";

import { getAuthService } from "@/server/db/container";

import { readSessionCookie } from "./session-cookie";

/** The authenticated organiser identity, as business logic is allowed to see it. */
export interface OrganiserContext {
  readonly organiserId: string;
}

export interface OrganiserContextResolver {
  /**
   * Resolve the caller's organiser identity, or throw.
   *
   * Implementations must never fall back to a body field, query parameter, or
   * header that the client controls as an *identity* — only to a credential the
   * server has verified.
   */
  resolve(request: Request): Promise<OrganiserContext>;
}

export const organiserContextResolver: OrganiserContextResolver = {
  async resolve(request: Request): Promise<OrganiserContext> {
    const token = readSessionCookie(request);

    if (token === null) {
      // No cookie at all. Thrown here rather than passed to the service as an
      // empty string so the "no session" path cannot be confused with a
      // malformed one, and so the log line distinguishes "never signed in" from
      // "presented something invalid".
      throw new UnauthenticatedError("This request has no valid organiser session.");
    }

    // The service re-hashes the token, looks the session up, and re-checks expiry
    // and the owning account. The cookie is a bearer credential, so everything
    // that decides whether to trust it lives on the far side of this call.
    const organiser = await getAuthService().resolveSessionToken(token);

    return { organiserId: organiser.organiserId };
  },
};

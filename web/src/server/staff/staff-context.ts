/**
 * Staff authentication boundary (PRD v2 §3, §4.6, §7.2, §12; rule 05; the staff
 * skill's step 1).
 *
 * The exact mirror image of `organiser-context.ts`, and deliberately so. That
 * module is the *only* way an organiser id reaches business logic, and this is the
 * only way a staff event scope does. Both documents exist to make one property
 * structural rather than a habit:
 *
 *   **A staff principal's event scope has no path from the request.**
 *
 *   - `Authorization: Bearer <token>` is read here and nowhere else. The
 *     `StaffContext` that the service receives is built *after* the credential is
 *     verified, and its `eventId` is the token's own column, read server-side.
 *   - There is no code path from a path segment, a query parameter, or a body
 *     field to `StaffContext.eventId`. Rule 05's requirement is "scope is read from
 *     the token server-side, never from the request", and this is the module that
 *     makes that true rather than merely intended.
 *   - The search route's `{id}` is *checked against* the token, never used as it.
 *     The staff skill is explicit: a client-supplied event that disagrees is "a
 *     rejected request, not a scope override". `StaffService.requireEventScope` is
 *     where that rejection happens, and this module is why it has a trustworthy
 *     `eventId` to compare against.
 *
 * Everything else staff cannot do is not enforced by refusing to parse a field; it
 * is enforced by there being no method on the service that would accept one.
 */

import "server-only";

import { UnauthenticatedError } from "@/domain/errors";
import type { StaffContext } from "@/domain/staff/staff";

import { getStaffService } from "../db/container";

/**
 * One failure message for "no usable credential".
 *
 * Shared with the service so that a missing header, an empty bearer value, a
 * malformed one, and a well-formed token nobody issued are all indistinguishable to
 * a caller — none of those is information about which tokens exist. Revoked and
 * expired are deliberately *not* folded in: §4.6.3 and AGENTS.md §11.2 require those
 * to be reported distinctly, because the remedy differs.
 */
const STAFF_NO_TOKEN_MESSAGE = "This request has no valid staff access token.";

/** The scheme as RFC 7235 spells it. */
const BEARER_SCHEME = "bearer";

/**
 * Read the bearer credential out of a request, or `null`.
 *
 * Returns `null` rather than throwing for anything malformed, because every
 * malformed case is the same failure to the caller and none of them is a client
 * mistake worth a `400`: the header either presents a token or it does not, and this
 * endpoint is not a token-format validator.
 */
export function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");

  if (header === null || header === "") {
    return null;
  }

  const separator = header.indexOf(" ");

  if (separator === -1) {
    return null;
  }

  // Case-insensitive per RFC 7235 (`Bearer`, `bearer` and `BEARER` are all valid).
  if (header.slice(0, separator).toLowerCase() !== BEARER_SCHEME) {
    return null;
  }

  const value = header.slice(separator + 1).trim();

  if (value === "" || value.includes(" ")) {
    return null;
  }

  return value;
}

export interface StaffContextResolver {
  /**
   * Resolve the caller's staff identity and its event scope, or throw.
   *
   * Implementations must never fall back to a body field, path segment, or
   * unverified header as an *identity or a scope*.
   */
  resolve(request: Request): Promise<StaffContext>;
}

export const staffContextResolver: StaffContextResolver = {
  async resolve(request: Request): Promise<StaffContext> {
    const secret = readBearerToken(request);

    if (secret === null) {
      // Thrown before any service call, so a request with no staff credential does
      // no work at all — the same order the organiser routes authenticate in.
      throw new UnauthenticatedError(STAFF_NO_TOKEN_MESSAGE);
    }

    // The service hashes the presented value, looks the row up, and re-checks
    // revocation and expiry. Everything that decides whether to trust this lives
    // behind that call; a bearer credential is not self-describing.
    return getStaffService().resolveStaffToken(secret);
  },
};

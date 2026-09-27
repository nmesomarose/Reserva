import { NextResponse } from "next/server";

import { serialiseClearedSessionCookie, readSessionCookie } from "@/server/auth/session-cookie";
import { getAuthService } from "@/server/db/container";
import { toErrorResponse } from "@/server/http/error-response";

/**
 * `POST /api/v1/auth/logout` — end the caller's session.
 *
 * POST rather than DELETE because there is no resource path to address: the
 * session is identified entirely by the cookie the caller already holds, and
 * `DELETE /api/v1/auth/session` would imply a session id that the client never
 * receives. POST is also what avoids the cross-site request that a
 * cookie-authenticated `GET`-shaped logout invites.
 *
 * Idempotent by design: a logout with no cookie, an unknown cookie, or an
 * already-ended session all answer `204`. Refusing would leave a client that
 * retried after a timeout unable to tell "already signed out" from "signed out
 * elsewhere", and the user's intent — end up signed out — holds either way.
 *
 * Two things happen on every response, whether or not a session existed:
 * the row is deleted, and the cookie is overwritten with an already-expired one.
 * Skipping the second for an unknown token would leave the browser holding a
 * cookie it keeps re-sending.
 */

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const token = readSessionCookie(request);

    await getAuthService().logout(token);

    return new NextResponse(null, {
      status: 204,
      headers: { "set-cookie": serialiseClearedSessionCookie() },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

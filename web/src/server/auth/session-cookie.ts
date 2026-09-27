/**
 * Organiser session cookie (product-owner decision 1, 2026-09-26).
 *
 * The cookie is the only thing on the client that proves a session exists. Its
 * attributes are the security controls, so each one is set here once and cannot
 * be overridden by a caller:
 *
 *   httpOnly  — script on the page cannot read the token, so an XSS bug cannot
 *               exfiltrate a session. The single most important attribute.
 *   sameSite  — "Lax" sends the cookie on top-level navigations but not on
 *               cross-site subrequests, which blocks the cross-site request
 *               forgery that "any state-changing cookie-authenticated route"
 *               would otherwise be. "Strict" was rejected because it also
 *               suppresses the cookie on a link followed from another site, which
 *               breaks ordinary use for no security gain here.
 *   secure    — set whenever the deployment is not a development environment, so
 *               a session token is never sent over plaintext HTTP in production.
 *   path      — "/" because the session covers every organiser route, not one.
 *
 * Parsing is hand-rolled against the `Cookie` request header rather than pulled
 * from `next/headers` or a library: the routes are typed against the Web
 * `Request` (AGENTS.md §4 wants a framework-agnostic handler), and a cookie
 * string with one named value in it does not justify a dependency.
 */

import "server-only";

/**
 * Cookie name. Prefixed so it cannot collide with anything a future dependency
 * sets, and named for the subject rather than the mechanism so changing the
 * session implementation does not silently log every organiser out under the same
 * name.
 */
export const ORGANISER_SESSION_COOKIE = "organiser_session";

/** How long a freshly issued session stays valid. */
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/**
 * Expiry for the *cleared* cookie.
 *
 * A logout must actively remove the cookie, and that means overwriting it with
 * an already-expired one. It does not need the original 7-day lifetime — matching
 * it is the same instruction to delete, with a wider window in which a
 * misconfigured client might keep the dead value around.
 */
const CLEAR_MAX_AGE_SECONDS = 0;

export interface OrganiserSessionCookieOptions {
  readonly httpOnly: true;
  readonly sameSite: "lax";
  readonly secure: boolean;
  readonly path: "/";
  readonly maxAge: number;
}

/**
 * `Secure` unless this is a development environment.
 *
 * Keyed off `NODE_ENV` rather than a bespoke env var so it cannot be set to
 * disagree with the framework's own notion of the environment. The only
 * environments where a non-secure cookie is correct are local development and
 * the test runner; in production a missing `Secure` flag is a real vulnerability,
 * so the safe reading is the default.
 */
function isSecureDeployment(): boolean {
  return process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test";
}

export function buildSessionCookieOptions(
  maxAge: number = SESSION_MAX_AGE_SECONDS,
): OrganiserSessionCookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureDeployment(),
    path: "/",
    maxAge,
  };
}

/** Serialise the cookie for a `Set-Cookie` response header. */
export function serialiseSessionCookie(
  token: string,
  maxAge: number = SESSION_MAX_AGE_SECONDS,
): string {
  const options = buildSessionCookieOptions(maxAge);

  return [
    `${ORGANISER_SESSION_COOKIE}=${token}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAge}`,
    "HttpOnly",
    `SameSite=${options.sameSite === "lax" ? "Lax" : "Strict"}`,
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
}

/** Serialise an already-expired cookie, i.e. the logout response. */
export function serialiseClearedSessionCookie(): string {
  return serialiseSessionCookie("", CLEAR_MAX_AGE_SECONDS);
}

/**
 * Read the session token out of a request, or `null`.
 *
 * Returns `null` for a missing, empty, or malformed cookie rather than throwing:
 * every caller treats "no session" the same way, and a bad cookie is not a
 * client error worth a `400`. Percent-decoding is applied because a token
 * containing `-`/`_` is base64url and safe, but a stray `%` from a proxy would
 * otherwise be compared verbatim against the stored hash and simply fail.
 */
export function readSessionCookie(request: Request): string | null {
  const header = request.headers.get("cookie");

  if (header === null || header === "") {
    return null;
  }

  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");

    if (separator === -1) {
      continue;
    }

    const name = pair.slice(0, separator).trim();

    if (name !== ORGANISER_SESSION_COOKIE) {
      continue;
    }

    const value = pair.slice(separator + 1).trim().replace(/^"|"$/g, "");

    if (value === "") {
      return null;
    }

    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  return null;
}

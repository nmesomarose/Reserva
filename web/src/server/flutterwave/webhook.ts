/**
 * Flutterwave webhook authenticity (PRD v2 §16, §8.6, FR-13a; rule 04).
 *
 * ## What this check is, and what it is not
 *
 * Flutterwave's mechanism is a **static shared secret hash** sent in a `verif-hash`
 * header, not a signature over the body. Verified against the official documentation
 * and recorded in `docs/evidence/flutterwave-verify-resolution.md` §3, along with the
 * three consequences that follow and constrain this file:
 *
 *   1. There is **no HMAC and no timestamp**, so the check proves the caller knows the
 *      secret. It does **not** bind the body, and it has no freshness window.
 *   2. Therefore it is **necessary but not sufficient** for §16's "an unsigned or
 *      incorrect payload produces zero state changes". A captured delivery is
 *      replayable by anyone who also learns the secret, and the only remaining
 *      defence is that every webhook write is keyed on
 *      `UNIQUE(Payment.provider_reference)` inside a transaction, so a replay cannot
 *      produce a second confirmation.
 *   3. The provider's docs recommend **against IP allow-listing** (their IPs change),
 *      so none is built. Implementing one would be a control that looks real and
 *      breaks silently.
 *
 * The comparison is **length-checked then constant-time**. A plain `===` leaks the
 * secret's length and prefix through timing, and this is a check whose entire purpose
 * is to keep an unauthenticated caller out; `timingSafeEqual` is used because it is
 * in Node's standard library and costs three lines.
 */

import "server-only";

import { timingSafeEqual } from "node:crypto";

/**
 * The header Flutterwave sends the secret hash in.
 *
 * Compared case-insensitively: HTTP header names are case-insensitive, and a
 * deployment behind a proxy that normalises them to `Verif-Hash` must not silently
 * start rejecting every delivery.
 */
export const WEBHOOK_VERIFICATION_HEADER = "verif-hash";

/**
 * Is this request from Flutterwave?
 *
 * Returns `false` — rather than throwing — for an absent header, an empty header, an
 * unconfigured secret, and a mismatch alike, so the route has one decision to make
 * and cannot accidentally treat a *malformed* request differently from an
 * *unauthenticated* one. Those two deserve different logs, not different code paths.
 */
export function isAuthenticFlutterwaveRequest(request: Request, secret: string | null): boolean {
  if (secret === null || secret === "") {
    return false;
  }

  const provided = headerValue(request, WEBHOOK_VERIFICATION_HEADER);

  if (provided === null) {
    return false;
  }

  return constantTimeEquals(provided, secret);
}

/**
 * Read a header, case-insensitively, without assuming the runtime normalises.
 *
 * `Headers.get` is already case-insensitive, so this exists for the tests and for
 * any caller holding a plain object; returning `null` for an empty value stops
 * `""` from being compared against a secret as though it were a real attempt.
 */
function headerValue(request: Request, name: string): string | null {
  const value = request.headers.get(name);

  if (value === null) {
    return null;
  }

  const trimmed = value.trim();

  return trimmed === "" ? null : trimmed;
}

/**
 * Length-checked, constant-time string equality.
 *
 * `timingSafeEqual` throws on a length mismatch, and the length of a secret is not
 * itself a secret worth protecting here — but the throw must not become the
 * difference between a `200` and a rejection, so mismatched lengths are compared as
 * unequal and returned.
 */
function constantTimeEquals(provided: string, expected: string): boolean {
  const providedBytes = Buffer.from(provided, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");

  if (providedBytes.length !== expectedBytes.length) {
    return false;
  }

  return timingSafeEqual(providedBytes, expectedBytes);
}

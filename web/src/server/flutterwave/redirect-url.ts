/**
 * Where Flutterwave should send the attendee back to (PRD v2 §8, §12; rule 04).
 *
 * ## Why the configured value is an *origin*, not a full URL
 *
 * `FLUTTERWAVE_REDIRECT_BASE_URL` names a public origin, and the path that consumes
 * the redirect is ours to own: PRD §12 fixes it as `/api/v1/payments/verify`, and a
 * future change to that path should not require every deployment's environment to be
 * edited in step with a code change. The operator therefore configures *where the
 * product is*, and this module decides *which route the provider returns to*.
 *
 * The alternative — treating the variable as a literal `redirect_url` — was the
 * original wiring, and it fails quietly: an operator who correctly configures their
 * origin gets an attendee redirected to their home page after paying, with no
 * verification call, no `verified_at`, and nothing in the logs to explain it. The
 * payment would still be resolved by the webhook, but §8.6 makes the webhook
 * eventually authoritative rather than immediately available, so the attendee would
 * sit on an unrelated page while their ticket is being paid for.
 *
 * The one accommodation made for operators who pasted the full endpoint anyway: a
 * value that already ends in the verify path is used as-is. Silently producing
 * `…/api/v1/payments/verify/api/v1/payments/verify` would be a worse experience
 * than accepting the value they clearly meant.
 */

/** PRD v2 §12's redirect-callback route. */
export const VERIFY_REDIRECT_PATH = "/api/v1/payments/verify";

/**
 * The `redirect_url` to hand the provider, or `null` when none is configured.
 *
 * `null` is a supported state, not a misconfiguration: the port models the field as
 * nullable because a deployment may have no public origin, and §8.6 makes the
 * webhook the governing channel regardless.
 */
export function buildVerifyRedirectUrl(origin: string | null): string | null {
  if (origin === null) {
    return null;
  }

  const trimmed = origin.trim().replace(/\/+$/, "");

  if (trimmed === "") {
    return null;
  }

  if (trimmed.endsWith(VERIFY_REDIRECT_PATH)) {
    return trimmed;
  }

  return `${trimmed}${VERIFY_REDIRECT_PATH}`;
}

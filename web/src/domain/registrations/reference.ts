/**
 * High-entropy reference generation (PRD v2 §7.2, FR-10a, §18; the registration
 * skill's preconditions and integrity checks).
 *
 * ## Two distinct references, and why they are not interchangeable
 *
 * | Reference | Column | Who holds it | Purpose |
 * | --- | --- | --- | --- |
 * | `unique_reference` | `registrations.unique_reference` | the **attendee** | FR-15's first factor for retrieving their own ticket |
 * | `tx_ref` | `payments.provider_reference` | **us and the provider** | correlates a provider transaction to a `Payment` row |
 *
 * Both are generated here so the two share one entropy source and one rule, and
 * so there is exactly one place to audit that neither is guessable.
 *
 * ## Entropy: 256 bits, and why the skill's floor is not the target
 *
 * The skill's precondition is "≥ 128 bits, cryptographically secure,
 * non-sequential, non-guessable", and PRD §18 requires an unguessable reference
 * that cannot be walked. 32 bytes gives 256 bits — double the floor — which
 * matters here because `unique_reference` is a **bearer** for FR-15's first
 * factor: anyone holding it gets within one guess of the attendee's ticket. The
 * second factor (email, FR-15) is what actually protects the record, but the
 * reference should not be the weak link. `auth.service.ts` already uses the same
 * 32-byte recipe for organiser session tokens, so this is a known quantity in
 * this codebase rather than a new idea.
 *
 * ## `node:crypto`, not `Math.random`
 *
 * `slug.ts` uses `Math.random`, which is appropriate for a URL suffix where a
 * collision only costs an extra attempt. A reference is different: a predictable
 * generator lets an attacker walk the space and enumerate other attendees'
 * tickets. `randomBytes` is a CSPRNG, needs no dependency, and — as
 * `server/auth/password.ts` already argues at length — introduces no framework
 * coupling, so the domain stays framework- and database-agnostic.
 *
 * ## Why the `tx_ref` is prefixed
 *
 * The value is sent to Flutterwave as `tx_ref` and comes back in every webhook
 * payload and in the redirect's query string. A `rsv_` prefix makes a
 * transaction row recognisable as ours in provider dashboards, support tickets,
 * and logs without looking anything up. It carries no entropy of its own and is
 * not a secret.
 */

import { randomBytes } from "node:crypto";

/**
 * Bytes of CSPRNG output per reference. 32 bytes = 256 bits, twice the skill's
 * 128-bit floor.
 */
const REFERENCE_ENTROPY_BYTES = 32;

/**
 * Distinguishing prefix for values sent to the payment provider.
 *
 * Not a secret and not part of the entropy. Only added to values that leave the
 * system; the attendee-facing `unique_reference` is unprefixed so it is the
 * shortest thing that can be typed or read aloud.
 */
const TX_REF_PREFIX = "rsv_";

/**
 * The attendee-facing `registrations.unique_reference`.
 *
 * Base64url of 32 random bytes: 43 characters, URL-safe with no escaping, using
 * the full alphabet so no information is lost to a reduced character set (a
 * hex encoding would spend 32 bits per character for the same 256 bits of
 * entropy and produce a 64-character string).
 */
export function generateUniqueReference(): string {
  return randomBytes(REFERENCE_ENTROPY_BYTES).toString("base64url");
}

/**
 * The provider-facing `payments.provider_reference`, sent as Flutterwave's
 * `tx_ref`.
 *
 * ## Why this is our own reference and not the provider's `flw_ref`
 *
 * Flutterwave returns both: `data.flw_ref` is theirs and `data.tx_ref` is ours.
 * Storing `flw_ref` looks like the more "provider-native" choice and was
 * suggested by an earlier reading of the API, but it is the wrong one here, for a
 * reason the verified error-timeout contract makes concrete:
 *
 * - `provider_reference` is `NOT NULL`, so it must exist **at insert time**. If it
 *   were `flw_ref`, no `Payment` row could be written until the provider call
 *   returned.
 * - The provider documents that `POST /v3/payments` returns **`503` after 28
 *   seconds** and that *"a timeout does not always mean request failure; it
 *   could also mean the request is still processing"*, with the instruction not
 *   to retry a create but to query the verify endpoint. Under a `flw_ref` design
 *   that 28-second window is exactly the case with **no trace at all**: no
 *   `Payment` row, nothing to verify, a live hold, and a payment that may have
 *   succeeded.
 * - With `tx_ref`, the `Payment` row is committed in the same transaction as the
 *   registration and the hold, *before* the network call. A timeout then leaves a
 *   durable `initiated` attempt that `/payments/verify` can resolve by reference
 *   — the documented remedy, already an endpoint in PRD §12.
 *
 * `tx_ref` is also what the provider echoes in the webhook payload, so
 * duplicate-delivery suppression via `UNIQUE(provider_reference)` works exactly
 * as BR-2 requires, keyed on a value both sides already agree on.
 */
export function generateProviderReference(): string {
  return `${TX_REF_PREFIX}${randomBytes(REFERENCE_ENTROPY_BYTES).toString("base64url")}`;
}

/**
 * Is this string shaped like a reference this module produced?
 *
 * Used by the evidence endpoint (FR-15) to reject an obviously bogus lookup
 * cheaply, *before* touching the database. It is a cheap filter, never an
 * authority: a well-formed string that matches no row still returns nothing, and
 * a malformed one is rejected without a query. A test asserts the format rather
 * than trusting this function's own reasoning.
 */
export function isWellFormedReference(value: string): boolean {
  return /^[A-Za-z0-9_-]{40,64}$/.test(value);
}

/** Is this string shaped like a `tx_ref` this module produced? */
export function isWellFormedProviderReference(value: string): boolean {
  return value.startsWith(TX_REF_PREFIX) && isWellFormedReference(value.slice(TX_REF_PREFIX.length));
}

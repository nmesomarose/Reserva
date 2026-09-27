/**
 * Reading a Flutterwave transaction, from either channel (PRD v2 §8, §8.6; rule 04).
 *
 * ## Why this is a module and not a private method on the client
 *
 * The provider reports the same `data` object two ways: inside the verify response
 * (`{ status, message, data: { … } }`) and inside a webhook (`{ event, data: { … } }`).
 * Those two `data` objects carry the same fields with the same meanings, and PRD
 * §8.6 makes the two channels *govern the same decision* — the webhook is
 * authoritative, and the redirect's answer is provisional, which is only a coherent
 * rule if both are read by the same code.
 *
 * If the field extraction lived in `client.ts` as private methods, the webhook route
 * would have to re-implement `tx_ref` reading, the `charged_amount` preference
 * (D-5), and the status narrowing. Any later correction to one copy — a provider
 * field rename, a fix to the amount rule — would then apply to one channel and not
 * the other, and the two channels would silently disagree about whether a payment
 * succeeded. That is precisely the failure §8.6 exists to prevent, so there is one
 * reader and both routes use it.
 *
 * ## The three things this refuses to guess
 *
 * 1. **A missing `tx_ref` is malformed, not absent.** The domain's check 1 compares
 *    the echoed reference against ours to prove the transaction is this platform's.
 *    Without a reference there is nothing to compare, and a default would let an
 *    unrelated transaction confirm a registration.
 * 2. **An unrecognised `status` is `"unknown"`, which is not success.** PRD §15
 *    forbids guessing, and the provider's vocabulary is longer than the five states
 *    §9.1 defines.
 * 3. **A missing or non-numeric amount is malformed.** Comparing an absent amount
 *    against an expected one would either block every confirmation or — far worse —
 *    treat absence as a match.
 *
 * `processor_response` is deliberately not consulted: PRD §9.1/§15 require the
 * *transaction* status, and that field also contains the words "successful" for
 * transactions that failed. Reading it is the single most likely way to confirm a
 * ticket that was never paid for.
 */

import {
  PaymentProviderError,
  type ProviderTransactionStatus,
  type VerifiedTransaction,
} from "@/domain/payments/provider";

/**
 * The provider's status vocabulary, narrowed to what the platform acts on.
 *
 * `processor_response` also carries words like "successful" and is **not** used:
 * PRD §9.1/§15 require the *transaction* status, and two similarly-named fields with
 * different meanings is exactly the kind of ambiguity that produces a wrong
 * confirmation.
 */
const TRANSACTION_STATUSES: ReadonlySet<string> = new Set([
  "successful",
  "failed",
  "pending",
  "refunded",
  "cancelled",
]);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(source: Record<string, unknown>, field: string): string | null {
  const value = source[field];

  return typeof value === "string" && value !== "" ? value : null;
}

export function readNumber(source: Record<string, unknown>, field: string): number | null {
  const value = source[field];

  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Narrow the provider's status word.
 *
 * Anything unrecognised becomes `"unknown"`, which the domain treats as *not*
 * successful: PRD §15 forbids guessing, and the provider's vocabulary is longer
 * than the five states §9.1 defines. Defaulting an unknown value to `successful`
 * would be the single most dangerous line in this integration.
 */
export function statusOf(data: Record<string, unknown>): ProviderTransactionStatus {
  const status = readString(data, "status");

  if (status === null) {
    return "unknown";
  }

  const normalised = status.trim().toLowerCase();

  return TRANSACTION_STATUSES.has(normalised)
    ? (normalised as ProviderTransactionStatus)
    : "unknown";
}

/**
 * The amount to compare the tier's price against.
 *
 * `charged_amount` is preferred over `amount`, falling back to `amount` when it is
 * absent, and the reason is the failure this prevents: on a partially-collected
 * method the two diverge, and a strict equality check against `amount` would
 * confirm a ticket for money that was never received. `amount` is the field the
 * provider's own documented success condition names, so where both are present
 * and equal — every normal card payment — the choice makes no difference; where
 * they are not, only the collected figure is defensible.
 *
 * Recorded as divergence D-5 in `docs/evidence/flutterwave-verify-resolution.md`.
 */
export function verifiedAmountOf(data: Record<string, unknown>): number | null {
  const charged = readNumber(data, "charged_amount");

  if (charged !== null) {
    return charged;
  }

  return readNumber(data, "amount");
}

function malformed(message: string, status: number | null = null): PaymentProviderError {
  return new PaymentProviderError("malformed", message, status, null);
}

/**
 * Turn a verify response's `data` object into a {@link VerifiedTransaction}.
 *
 * Throws `PaymentProviderError` of kind `malformed` when the response cannot answer
 * the three questions above. A caller that treats that as "we do not know" is
 * correct; a caller that treated it as success would not be.
 */
export function verifiedTransactionFromData(
  data: unknown,
  raw: unknown,
  httpStatus: number | null = null,
): VerifiedTransaction {
  if (!isPlainObject(data)) {
    throw malformed(
      "The payment provider's transaction payload did not contain a transaction.",
      httpStatus,
    );
  }

  const providerReference = readString(data, "tx_ref");
  const currency = readString(data, "currency");

  if (providerReference === null || currency === null) {
    throw malformed(
      "The payment provider's transaction payload was missing a reference or currency.",
      httpStatus,
    );
  }

  const amount = verifiedAmountOf(data);

  if (amount === null) {
    throw malformed(
      "The payment provider's transaction payload did not contain a usable amount.",
      httpStatus,
    );
  }

  return {
    providerReference,
    flwReference: readString(data, "flw_ref"),
    transactionId: readNumber(data, "id"),
    amount,
    currency,
    status: statusOf(data),
    // The **whole** body, not a projection of it: PRD §14 retains the provider's
    // raw response for audit, and a lossy copy cannot settle a dispute later. For
    // the webhook channel that means the entire delivery, envelope included.
    raw,
  };
}

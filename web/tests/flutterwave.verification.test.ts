import { describe, expect, it } from "vitest";

/**
 * The provider's own words, read once and used by both channels (PRD v2 §8, §8.6).
 *
 * These tests exist because this reader is the single place a wrong reading becomes a
 * wrong decision about money. Each block below pins one of the three refusals the
 * module makes, plus the two channel-level facts — the `verif-hash` check and the
 * redirect URL — that decide whether the two channels can even be reached.
 */

import { PaymentProviderError } from "@/domain/payments/provider";
import { buildVerifyRedirectUrl } from "@/server/flutterwave/redirect-url";
import {
  isPlainObject,
  statusOf,
  verifiedAmountOf,
  verifiedTransactionFromData,
} from "@/server/flutterwave/transaction-payload";
import {
  isAuthenticFlutterwaveRequest,
  WEBHOOK_VERIFICATION_HEADER,
} from "@/server/flutterwave/webhook";

const REFERENCE = "rsv_8Xk2mQ7pL4vR1sT6yB0nJ3wZ5cD7fH1aG9iK2l";

/** A realistic `data` object: what the provider's verify response and webhook share. */
function transaction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1_234_567,
    tx_ref: REFERENCE,
    flw_ref: "FLW-REF-ABC-123",
    amount: 5_000,
    currency: "NGN",
    status: "successful",
    ...overrides,
  };
}

describe("the transaction status vocabulary", () => {
  it("narrows each of the five states §9.1 acts on", () => {
    for (const status of ["successful", "failed", "pending", "refunded", "cancelled"]) {
      expect(statusOf({ status })).toBe(status);
    }
  });

  it("is case- and whitespace-insensitive, because the value is a human-facing word", () => {
    expect(statusOf({ status: "  SUCCESSFUL " })).toBe("successful");
  });

  it("REFUSES to read processor_response, which says 'successful' for failed payments", () => {
    // The single most dangerous available mistake: two similarly-named fields with
    // opposite meanings, and one of them lies.
    expect(statusOf({ processor_response: "Successful" })).toBe("unknown");
  });

  it("treats an unrecognised status as unknown, which is NOT success", () => {
    // §15 forbids guessing, and the provider's vocabulary is longer than §9.1's five.
    for (const status of ["SUCCESS", "completed", "partially_paid", ""]) {
      expect(statusOf({ status })).toBe("unknown");
    }
  });

  it("treats a missing status as unknown rather than absent", () => {
    // "Absent" would be a hole in the confirmation check: only `=== "successful"`
    // grants a ticket, and undefined satisfies that, but a `null` default flowing into
    // a truthiness test would not.
    expect(statusOf({})).toBe("unknown");
  });
});

describe("the amount rule (D-5)", () => {
  it("prefers charged_amount, which is what was actually collected", () => {
    // On a partially-collected method the two diverge. Confirming against `amount`
    // grants a ticket for money never received.
    expect(verifiedAmountOf({ amount: 5_000, charged_amount: 2_500 })).toBe(2_500);
  });

  it("falls back to amount, which is the field the provider's success condition names", () => {
    expect(verifiedAmountOf({ amount: 5_000 })).toBe(5_000);
  });

  it("is unaffected when the two agree, as they do for every normal card payment", () => {
    expect(verifiedAmountOf({ amount: 5_000, charged_amount: 5_000 })).toBe(5_000);
  });

  it("REFUSES a string amount rather than parsing it", () => {
    // "5000" and 5000 are not the same value to a comparison against a stored price,
    // and Number() would quietly accept a locale-formatted "5,000" as NaN.
    expect(verifiedAmountOf({ amount: "5000" })).toBeNull();
    expect(verifiedAmountOf({ amount: "5,000" })).toBeNull();
  });

  it("refuses a non-finite amount", () => {
    expect(verifiedAmountOf({ amount: Number.NaN })).toBeNull();
    expect(verifiedAmountOf({ amount: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it("keeps a zero amount, which is a real free ticket and not a missing value", () => {
    expect(verifiedAmountOf({ amount: 0 })).toBe(0);
  });
});

describe("reading a transaction out of a payload", () => {
  it("carries the reference, the provider's own id, the amount, and the status", () => {
    const verified = verifiedTransactionFromData(transaction(), { status: "success" });

    expect(verified.providerReference).toBe(REFERENCE);
    expect(verified.transactionId).toBe(1_234_567);
    expect(verified.flwReference).toBe("FLW-REF-ABC-123");
    expect(verified.amount).toBe(5_000);
    expect(verified.currency).toBe("NGN");
    expect(verified.status).toBe("successful");
  });

  it("retains the WHOLE raw delivery, because a lossy copy cannot settle a dispute", () => {
    // §14 keeps the provider's raw response for audit. For the webhook channel that
    // means the envelope too, not just `data` — a reviewer needs to see what was sent.
    const delivery = { event: "charge.completed", data: transaction() };

    expect(verifiedTransactionFromData(delivery.data, delivery).raw).toBe(delivery);
  });

  it("allows a payload with neither provider id, which is not required to confirm", () => {
    // `id` and `flw_ref` are the provider's own identifiers. Nothing in the
    // confirmation path needs them, so their absence must not block a payment that
    // every other field describes — they are for disputes and for the provider's
    // dashboard, not for the decision.
    const verified = verifiedTransactionFromData(
      transaction({ id: undefined, flw_ref: undefined }),
      null,
    );

    expect(verified.transactionId).toBeNull();
    expect(verified.flwReference).toBeNull();
    expect(verified.providerReference).toBe(REFERENCE);
    expect(verified.status).toBe("successful");
  });

  it("REFUSES a payload with no reference, rather than defaulting one", () => {
    // The domain's first check compares the echoed reference against ours to prove the
    // transaction is this platform's. A default would let an unrelated transaction
    // confirm a registration.
    expect(() => verifiedTransactionFromData(transaction({ tx_ref: undefined }), null)).toThrow(
      PaymentProviderError,
    );
  });

  it("refuses a payload with no currency, which cannot be compared to a price", () => {
    expect(() => verifiedTransactionFromData(transaction({ currency: undefined }), null)).toThrow(
      PaymentProviderError,
    );
  });

  it("refuses a payload with no usable amount, rather than treating absence as a match", () => {
    expect(() => verifiedTransactionFromData(transaction({ amount: undefined }), null)).toThrow(
      PaymentProviderError,
    );
  });

  it("refuses anything that is not an object", () => {
    for (const data of [null, undefined, "successful", 42, []]) {
      expect(() => verifiedTransactionFromData(data, null)).toThrow(PaymentProviderError);
    }
  });

  it("reports a malformed payload as `malformed`, which is 'we cannot answer'", () => {
    try {
      verifiedTransactionFromData({}, null, 200);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(PaymentProviderError);
      const refusal = error as PaymentProviderError;
      expect(refusal.kind).toBe("malformed");
      // Not `indeterminate`: a malformed response did not leave the payment in doubt
      // at the provider, it means the provider's answer was unreadable. Both leave the
      // attempt untouched, which is what makes the distinction safe to ignore.
      expect(refusal.mayHaveMoved).toBe(false);
    }
  });

  it("does not read a nested `data` on its own, so both callers extract it explicitly", () => {
    // The verify response and the webhook envelope differ, and reading the envelope
    // here would make one of the two channels pass the wrong shape.
    expect(() => verifiedTransactionFromData({ event: "charge.completed" }, null)).toThrow(
      PaymentProviderError,
    );
  });
});

describe("the payload guards both routes share", () => {
  it("recognises a plain object and nothing else", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject("{}")).toBe(false);
  });
});

describe("webhook authenticity: the verif-hash check (PRD §16)", () => {
  const SECRET = "flwseck_a1b2c3d4e5f6";

  const delivery = (headers: Record<string, string>) =>
    new Request("https://example.test/api/v1/payments/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ event: "charge.completed" }),
    });

  it("accepts the exact secret", () => {
    expect(isAuthenticFlutterwaveRequest(delivery({ [WEBHOOK_VERIFICATION_HEADER]: SECRET }), SECRET)).toBe(
      true,
    );
  });

  it("is case-insensitive in the header NAME, as HTTP requires", () => {
    // A proxy normalising to `Verif-Hash` must not start rejecting every delivery.
    expect(isAuthenticFlutterwaveRequest(delivery({ "Verif-Hash": SECRET }), SECRET)).toBe(true);
  });

  it("tolerates surrounding whitespace in the value", () => {
    expect(isAuthenticFlutterwaveRequest(delivery({ [WEBHOOK_VERIFICATION_HEADER]: ` ${SECRET} ` }), SECRET)).toBe(
      true,
    );
  });

  it("refuses a wrong secret, a prefix of it, and an extension of it", () => {
    for (const value of ["flwseck_a1b2c3d4e5f", "flwseck_a1b2c3d4e5f6x", "nope", " "]) {
      expect(isAuthenticFlutterwaveRequest(delivery({ [WEBHOOK_VERIFICATION_HEADER]: value }), SECRET)).toBe(
        false,
      );
    }
  });

  it("refuses a delivery with no header at all", () => {
    expect(isAuthenticFlutterwaveRequest(delivery({}), SECRET)).toBe(false);
  });

  it("refuses everything when the secret is not configured, rather than allowing all", () => {
    // A missing `FLUTTERWAVE_WEBHOOK_SECRET` is a deployment error. Failing open would
    // turn it into an unauthenticated write endpoint, which is the one outcome worth
    // burning a delivery for.
    expect(isAuthenticFlutterwaveRequest(delivery({ [WEBHOOK_VERIFICATION_HEADER]: SECRET }), null)).toBe(
      false,
    );
    expect(isAuthenticFlutterwaveRequest(delivery({ [WEBHOOK_VERIFICATION_HEADER]: SECRET }), "")).toBe(
      false,
    );
  });

  it("returns false rather than throwing, so the route has one decision to make", () => {
    // A malformed request and an unauthenticated one deserve different logs, not
    // different code paths.
    expect(() => isAuthenticFlutterwaveRequest(delivery({}), "s")).not.toThrow();
  });
});

describe("the redirect URL we hand the provider", () => {
  it("appends PRD §12's verify route to a configured origin", () => {
    expect(buildVerifyRedirectUrl("https://tickets.example.com")).toBe(
      "https://tickets.example.com/api/v1/payments/verify",
    );
  });

  it("does not double the slash when the origin has a trailing one", () => {
    expect(buildVerifyRedirectUrl("https://tickets.example.com/")).toBe(
      "https://tickets.example.com/api/v1/payments/verify",
    );
    expect(buildVerifyRedirectUrl("https://tickets.example.com///")).toBe(
      "https://tickets.example.com/api/v1/payments/verify",
    );
  });

  it("keeps a sub-path origin, which is what a preview deployment has", () => {
    expect(buildVerifyRedirectUrl("https://example.com/reserva")).toBe(
      "https://example.com/reserva/api/v1/payments/verify",
    );
  });

  it("accepts a full verify URL, so an operator who pasted one is not punished", () => {
    // Silently producing .../verify/api/v1/payments/verify would be a worse outcome
    // than accepting what they clearly meant.
    expect(buildVerifyRedirectUrl("https://tickets.example.com/api/v1/payments/verify")).toBe(
      "https://tickets.example.com/api/v1/payments/verify",
    );
  });

  it("is null with no origin, which the webhook makes survivable", () => {
    // §8.6 makes the webhook the governing channel, so an absent public origin
    // degrades the redirect rather than breaking the payment.
    expect(buildVerifyRedirectUrl(null)).toBeNull();
    expect(buildVerifyRedirectUrl("   ")).toBeNull();
  });
});

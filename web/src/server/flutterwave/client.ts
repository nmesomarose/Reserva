/**
 * The Flutterwave HTTP adapter (PRD v2 §5.4, §8, §19; rule 04).
 *
 * The only file in the project that knows Flutterwave exists. It speaks HTTP,
 * parses the provider's envelope, and returns the plain shapes
 * `domain/payments/provider.ts` declares. Every money and lifecycle decision lives
 * on the other side of that interface, which is what lets those rules be tested
 * without a sandbox account.
 *
 * ## The five failure kinds, and why the mapping is not simpler
 *
 * `PaymentProviderError.kind` exists because the provider's documented behaviours
 * lead to *different product outcomes*, and a single "the call failed" would force
 * one wrong answer onto all of them:
 *
 *   - `503` or our own timeout — the provider says the request "could also mean the
 *     request is still processing", and instructs that a payment-creating request
 *     must **not** be retried. This is `indeterminate`, and it is the reason the
 *     domain leaves the attempt `initiated` instead of failing it.
 *   - `429` — the documented remedy is a backoff retry, so nothing has failed.
 *   - any other non-2xx, including the `400` whose documented body is `{}` — a real
 *     rejection. The attempt can be closed and a fresh one opened.
 *   - a 2xx whose shape is not the documented one — we did not learn the outcome,
 *     which is not the same as learning it failed. `malformed` keeps it distinct
 *     from `rejected` so a contract change surfaces as its own signal.
 *
 * ## Read the evidence, not this file, for the provider's contract
 *
 * `docs/evidence/flutterwave-verify-resolution.md` is the record of what was
 * verified against the official documentation, including the two corrections that
 * matter most: `amount` is in **major** units, and webhook authenticity is a static
 * `verif-hash` secret rather than a body-bound signature. This file implements what
 * that record establishes and cites it rather than restating the API.
 */

import "server-only";

import {
  PaymentProviderError,
  type InitiateCheckoutInput,
  type InitiatedCheckout,
  type PaymentProvider,
  type VerifiedTransaction,
  type VerifyTransactionInput,
} from "@/domain/payments/provider";

import {
  isPlainObject,
  readNumber,
  readString,
  verifiedTransactionFromData,
} from "./transaction-payload";

/** The live base URL, and the `v3` prefix the endpoints are all relative to. */
const DEFAULT_BASE_URL = "https://api.flutterwave.com/v3";

/**
 * Our own request deadline, in milliseconds.
 *
 * Set **above** the provider's documented 28-second `503` so that the case we
 * normally hit is the one they document — a `503` carrying a body we can classify —
 * rather than our own abort firing first and masking it. The margin exists only to
 * let that response arrive; the provider's figure is the one that decides how long
 * we are willing to wait.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/** A `tx_ref` is placed in a query string, and this platform's is base64url. */
const MAX_REFERENCE_LENGTH = 128;

export interface FlutterwaveClientConfig {
  /** The secret key. Never logged, never returned, never sent to a client. */
  readonly secretKey: string;
  /** Overridable so tests can point at a stub instead of the live API. */
  readonly baseUrl?: string;
  /** Overridable for tests that assert the timeout path without waiting 30 s. */
  readonly timeoutMs?: number;
}

/** Injected for tests; defaults to the platform `fetch`. */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}>;

/**
 * The provider's status vocabulary, the `charged_amount` preference (D-5), and the
 * "refuse to guess" rules for `tx_ref`/currency/amount all live in
 * `./transaction-payload`, not here.
 *
 * That module is shared with the webhook route on purpose: PRD §8.6 makes both
 * channels decide the same question about the same `data` object, and two copies of
 * the reading rules could one day disagree about whether a payment succeeded.
 */

/**
 * Parse a body, or report that there is nothing to parse.
 *
 * A JSON parse failure is **not** a provider failure: the documented error body for
 * a `400` is `{}` and an HTML error page from a proxy is not unheard of. Returning
 * `null` lets the caller decide, which for a non-2xx is "rejected" and for a 2xx is
 * "malformed" — the two must not be conflated, because one means "you asked wrong"
 * and the other means "we do not know what happened".
 */
async function readJsonBody(response: {
  text(): Promise<string>;
}): Promise<Record<string, unknown> | null> {
  const text = await response.text();

  if (text.trim() === "") {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;

    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The provider's own `message`, kept apart from ours so it can never reach a log. */
function providerMessageOf(body: Record<string, unknown> | null): string | null {
  return body === null ? null : readString(body, "message");
}

/**
 * Classify a non-2xx response into a failure kind.
 *
 * The three branches are the provider's documented contracts, not heuristics:
 * `429` is rate limiting, `503` is the "may still be processing" timeout, and
 * everything else is a rejection we are allowed to act on.
 */
function failureFor(response: {
  readonly status: number;
}, providerMessage: string | null): PaymentProviderError {
  if (response.status === 429) {
    return new PaymentProviderError(
      "rate_limited",
      "The payment provider is rate limiting this request.",
      429,
      providerMessage,
    );
  }

  if (response.status === 503) {
    // `mayHaveMoved` is true for this kind, and the domain relies on it to leave the
    // attempt `initiated` rather than failing a payment that may have been taken.
    return new PaymentProviderError(
      "indeterminate",
      "The payment provider did not confirm the outcome of this request.",
      503,
      providerMessage,
    );
  }

  return new PaymentProviderError(
    "rejected",
    "The payment provider rejected this request.",
    response.status,
    providerMessage,
  );
}

export class FlutterwaveClient implements PaymentProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: FlutterwaveClientConfig,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * `POST /v3/payments` — create a hosted checkout and return `data.link`.
   *
   * The body carries only documented fields, and `currency` is sent **explicitly**
   * because the provider defaults it to `NGN`: relying on that default would charge
   * a GBP ticket in Naira. `configuration.session_duration` is set from BR-3's hold
   * window so the provider's hosted session expires with our hold rather than after
   * its own default 30 minutes.
   */
  async initiateCheckout(input: InitiateCheckoutInput): Promise<InitiatedCheckout> {
    const body: Record<string, unknown> = {
      // **Major** units. `amount` is converted by the caller from the stored minor
      // unit price by the single function in `domain/payments/currency-units.ts`
      // (R-6); sending `price_minor_units` here would overcharge by 100×.
      amount: input.amount,
      tx_ref: input.providerReference,
      currency: input.currency,
      customer: {
        email: input.customerEmail,
        name: input.customerName,
        phone_number: input.customerPhone,
      },
      configuration: {
        session_duration: input.sessionDurationMinutes,
      },
    };

    // Omitted entirely when unconfigured rather than sent as `null`: the provider
    // documents `redirect_url` as optional, and a `null` is not a URL. A deployment
    // without a public origin completes by webhook alone, which §8.6 makes the
    // governing channel anyway.
    if (input.redirectUrl !== null) {
      body.redirect_url = input.redirectUrl;
    }

    const { response, payload } = await this.request("POST", "/payments", body);

    if (!response.ok) {
      throw failureFor(response, providerMessageOf(payload));
    }

    const data = payload === null ? null : payload.data;

    if (!isPlainObject(data)) {
      throw new PaymentProviderError(
        "malformed",
        "The payment provider's response did not contain a hosted checkout link.",
        response.status,
        providerMessageOf(payload),
      );
    }

    const link = readString(data, "link");

    if (link === null) {
      // A `200` with no link is a contract change, not a rejection: there may be a
      // hosted session this platform cannot see, so the attempt must stay unresolved
      // rather than be closed.
      throw new PaymentProviderError(
        "malformed",
        "The payment provider's response did not contain a hosted checkout link.",
        response.status,
        providerMessageOf(payload),
      );
    }

    // The documented `200` body is `{ status, message, data: { link } }` — `data`
    // carries no transaction id, so this is normally `null`. It is read anyway
    // because a provider that starts returning one should not require a code change
    // to be recorded for audit.
    return { link, transactionId: readNumber(data, "id"), raw: payload };
  }

  /**
   * `GET /v3/transactions/verify_by_reference?tx_ref=…` — the redirect channel's
   * authoritative answer.
   *
   * Verified by our own `tx_ref` rather than by numeric id, because the `Payment`
   * row is written **before** the provider call and by then the numeric id may not
   * exist (a `503` on initiate) — the reference is the one identifier this platform
   * has unconditionally.
   *
   * A missing transaction is `null`, not a throw: the provider documents it as a
   * `200` with `status: "error"`, and it is an ordinary answer meaning "there is
   * nothing to confirm".
   */
  async verifyTransaction(input: VerifyTransactionInput): Promise<VerifiedTransaction | null> {
    const reference = input.providerReference;

    // The reference goes into a query string. It is generated as base64url, so this
    // cannot fire in production, but a reference that could break out of the query
    // is worth refusing rather than encoding — the value is the lookup key and
    // silently searching for something else would be worse than an error.
    if (
      reference.length === 0 ||
      reference.length > MAX_REFERENCE_LENGTH ||
      !/^[A-Za-z0-9_-]+$/.test(reference)
    ) {
      throw new PaymentProviderError(
        "rejected",
        "The payment reference is not in a form this provider adapter can query.",
        null,
        null,
      );
    }

    const { response, payload } = await this.request(
      "GET",
      `/transactions/verify_by_reference?tx_ref=${reference}`,
    );

    if (!response.ok) {
      throw failureFor(response, providerMessageOf(payload));
    }

    // The documented "not found" is a `200` with `status: "error"` and `data: null`.
    if (payload === null || readString(payload, "status") !== "success") {
      return null;
    }

    // `tx_ref`, `currency`, `amount`, and the status narrowing are read by the
    // shared reader in `./transaction-payload` — the same one the webhook route uses
    // on the same fields, so §8.6's "the webhook governs" cannot be undermined by the
    // two channels disagreeing about what a payload says.
    return verifiedTransactionFromData(payload.data, payload, response.status);
  }

  /**
   * One authenticated request, with the provider's failure vocabulary applied.
   *
   * `503` and a transport failure are both `indeterminate` and are treated the same
   * way here on purpose — from the caller's position they are the same fact: the
   * outcome is unknown and the money may have moved. An `AbortError` is matched by
   * name because a timeout is signalled that way rather than by an HTTP status, and
   * an unrecognised transport failure is conservatively treated the same: claiming
   * a definite outcome we do not have would be the worse error of the two.
   */
  private async request(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{
    readonly response: { readonly ok: boolean; readonly status: number };
    readonly payload: Record<string, unknown> | null;
  }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.secretKey}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });

      return { response, payload: await readJsonBody(response) };
    } catch (error) {
      if (error instanceof PaymentProviderError) {
        throw error;
      }

      const isTimeout = isAbortError(error);

      throw new PaymentProviderError(
        "indeterminate",
        isTimeout
          ? "The payment provider did not respond before the request deadline."
          : "The payment provider could not be reached.",
        null,
        null,
      );
    } finally {
      // Cleared on every path, including the throw: a pending timer is what turns one
      // slow request into a leaked timer per request.
      clearTimeout(timer);
    }
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

import { NextResponse } from "next/server";

import { PaymentProviderError } from "@/domain/payments/provider";
import { getPaymentEnv } from "@/server/env";
import {
  isPlainObject,
  readString,
  verifiedTransactionFromData,
} from "@/server/flutterwave/transaction-payload";
import { isAuthenticFlutterwaveRequest } from "@/server/flutterwave/webhook";
import { getPaymentService } from "@/server/db/container";
import { toErrorResponse } from "@/server/http/error-response";

/**
 * `POST /api/v1/payments/webhook` — the provider's own notification that a payment
 * settled (PRD v2 §12, auth: Flutterwave, signature-verified; FR-13, FR-13a, §8.6,
 * §16).
 *
 * ## The order of the four checks, and why the order is the security property
 *
 * 1. **`verif-hash`** — compared before the body is even read. A caller without the
 *    secret gets a `403` and this code never sees their payload, which is what makes
 *    §16's "an unsigned or incorrect payload produces zero state changes" true rather
 *    than aspirational.
 * 2. **the body parses as a JSON object** — `400` otherwise.
 * 3. **is this a payment event at all** — a `200` acknowledgement with no state change
 *    for anything this integration does not act on (below).
 * 4. **can the payload be read as a transaction** — then §8.6 hands it to the domain
 *    as the authoritative verification, with **no** re-query of the provider.
 *
 * Step 4's "no re-query" is deliberate and is the whole point of the channel. §8.6
 * and FR-13a make the webhook the eventual source of truth: if the two channels were
 * symmetric, the provider's own report would merely be another opinion and the
 * precedence rule would have no meaning. The re-query the provider's docs *recommend*
 * is a recommendation about authenticity, and this route answers it with the
 * `verif-hash` check plus the database-level guarantee that a redelivery cannot apply
 * anything twice (see `PaymentService.resolve` and the `FOR UPDATE` in the adapter).
 *
 * ## What is acknowledged without being acted on, and why that is not a silent drop
 *
 * The provider sends several event families to this one URL. Only a **charge** carries
 * a `tx_ref` this platform issued, and that — not the event name — is the discriminator
 * used here, because the docs record that `charge.completed` covers both success and
 * failure and that other families (`transfer.completed`, `bvn.completed`,
 * `subscription.cancelled`, virtual-card events) have their own payloads. A payload
 * without a usable `tx_ref` is acknowledged `200` and changes nothing.
 *
 * That includes the **refund** payload, which the evidence record shows is a flat,
 * PascalCase object with no `event` envelope and no `tx_ref` (it correlates by
 * `TransactionId`). Handling it is a real gap and it is recorded as one — a reversal
 * needs a lookup by provider transaction id and a §8.6 reconciliation path that
 * un-confirms a registration, which is not built yet. Answering `200` is still the
 * correct response to a delivery this integration cannot act on: the provider's
 * documented contract is that a non-`200` marks the delivery failed and schedules
 * retries, and an error page for an event we deliberately ignore is a worse outcome
 * than an acknowledged no-op. Reporting the gap in the evidence record is what keeps
 * this honest.
 *
 * ## A `400` for an authentic but unreadable charge
 *
 * The one payload that gets a non-`200` after the secret check is a charge whose
 * `data` cannot be read as a transaction. Reachable only by the provider, so it is a
 * genuine contract failure that must be visible rather than swallowed — and retrying
 * it will not help. The trade is accepted deliberately: silence would hide a provider
 * contract change behind a queue of payments that never confirm.
 *
 * ## `200` is mandatory
 *
 * The provider's contract is that anything other than `200` — **including `3xx`** —
 * marks the delivery failed. Every payload this route declines to act on is therefore
 * acknowledged with a `200` *after* it has decided, never before.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const authentic = isAuthenticFlutterwaveRequest(request, getPaymentEnv().FLUTTERWAVE_WEBHOOK_SECRET);

    if (!authentic) {
      // `403`, not `401`: the documented access-control code in PRD §15 is `403`, and
      // this route has no notion of a login to redirect anyone to.
      return NextResponse.json(
        {
          error: {
            code: "forbidden",
            message: "This endpoint accepts notifications from the payment provider only.",
          },
        },
        { status: 403 },
      );
    }

    const body = await readJsonBody(request);

    if (!isPlainObject(body)) {
      return malformed("The webhook body must be a JSON object.");
    }

    // A payload with no `event` is one of the families that does not use the envelope
    // — the documented refund payload is flat and PascalCase. Not an error: nothing
    // here can act on it.
    if (readString(body, "event") === null) {
      return acknowledged("ignored");
    }

    const data = body.data;

    // No usable `tx_ref` means this is not a charge for a payment this platform
    // opened. Acknowledged, unacted, and named in the route's comment above.
    if (!isPlainObject(data) || readString(data, "tx_ref") === null) {
      return acknowledged("ignored");
    }

    // The **whole** delivery is the retained payload, envelope and `event` included
    // (PRD §14): a reviewer reading this row later needs to see what was delivered,
    // not a projection of the part that happened to be used.
    const verified = verifiedTransactionFromData(data, body);

    const outcome = await getPaymentService().resolve({
      providerReference: verified.providerReference,
      channel: "webhook",
      verified,
      providerTransactionId: verified.transactionId,
    });

    return acknowledged(outcome.kind);
  } catch (error) {
    // A provider error escaping `resolve` means a transaction payload the reader
    // could not use, which is the `400` case discussed above. Any other unexpected
    // failure deliberately becomes a non-`200` so the provider retries: a payment that
    // succeeded must not be lost because this process had a bad moment, and a
    // redelivery is a no-op by construction (§16's duplicate-delivery case).
    if (error instanceof PaymentProviderError) {
      return malformed("The payment provider's transaction payload could not be read.");
    }

    return toErrorResponse(error);
  }
}

/**
 * Read the body as JSON, or report that it is not.
 *
 * Uses `request.json()` and not the shared `readJsonObject` because this route is not
 * validating a *caller's* body: a delivery the provider could not serialise is a
 * broken delivery, and the answer is a non-`200` either way. Both produce the same
 * `400`, so the shared helper would only obscure where the check came from.
 */
async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    return null;
  }
}

function malformed(message: string): NextResponse {
  return NextResponse.json(
    { error: { code: "validation_failed", message } },
    { status: 400 },
  );
}

/**
 * The mandatory `200`.
 *
 * `outcome` is this product's own resolution kind, useful in a log and harmless to the
 * provider (which ignores the body). No payment detail, no reference, no provider
 * payload is echoed — rule 08, and the recipient is a machine anyway.
 */
function acknowledged(outcome: string): NextResponse {
  return NextResponse.json({ received: true, outcome }, { status: 200 });
}

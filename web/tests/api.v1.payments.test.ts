import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The attendee payment routes:
 *
 *   - `POST     /api/v1/events/{id}/registrations`  (PRD v2 §12, Public)
 *   - `POST     /api/v1/payments/initiate`          (PRD v2 §12, Public)
 *   - `POST/GET /api/v1/payments/verify`           (PRD v2 §12, System)
 *   - `POST     /api/v1/payments/webhook`           (PRD v2 §12, Flutterwave)
 *
 * These assert the *transport* contract only: status codes, the error shape, the
 * untrusted-input refusals, the `no-store` header, and the webhook's check order. The
 * rules behind them are proven against fake repositories in
 * `registrations.service.test.ts` and `payments.service.test.ts`, and the parsers in
 * `registrations.validation.test.ts`, so nothing here needs a database or a provider.
 *
 * Two of these decisions exist only at this layer and are therefore only testable
 * here: `201` versus `200` on a replay, and a webhook that authenticates before it
 * reads the body.
 */

const { getRegistrationService, getPaymentService, getPaymentEnv } = vi.hoisted(() => ({
  getRegistrationService: vi.fn(),
  getPaymentService: vi.fn(),
  getPaymentEnv: vi.fn(),
}));

vi.mock("@/server/db/container", () => ({
  getRegistrationService,
  getPaymentService,
}));

vi.mock("@/server/env", () => ({ getPaymentEnv }));

import { POST as CREATE_REGISTRATION } from "@/app/api/v1/events/[identifier]/registrations/route";
import { POST as INITIATE_PAYMENT } from "@/app/api/v1/payments/initiate/route";
import { GET as VERIFY_GET, POST as VERIFY_POST } from "@/app/api/v1/payments/verify/route";
import { POST as WEBHOOK } from "@/app/api/v1/payments/webhook/route";
import { ConflictError, IllegalTransitionError, NotFoundError } from "@/domain/errors";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const TICKET_TYPE_ID = "33333333-3333-4333-8333-333333333333";
const REGISTRATION_ID = "55555555-5555-4555-8555-555555555555";
const IDEMPOTENCY_KEY = "66666666-6666-4666-8666-666666666666";
const PROVIDER_REFERENCE = "rsv_8Xk2mQ7pL4vR1sT6yB0nJ3wZ5cD7fH1aG9iK2l";
const WEBHOOK_SECRET = "flwseck_a1b2c3d4e5f6";

const registrationService = {
  createRegistration: vi.fn(),
  initiatePayment: vi.fn(),
};

const paymentService = { resolve: vi.fn() };

const CHECKOUT = {
  registration: {
    unique_reference: "BGNEqSon4dw4szERiBHK5o58VDyy",
    attendee_name: "Ada Lovelace",
    attendee_email: "ada@example.com",
    attendee_phone: "+2348012345678",
    ticket_type_name: "General Admission",
    status: "pending_payment" as const,
    hold_expires_at: "2026-09-27T10:20:00.000Z",
    created_at: "2026-09-27T10:05:00.000Z",
  },
  payment: {
    status: "awaiting_payment" as const,
    expected_amount_minor_units: 5_000,
    currency: "NGN",
    verified_amount_minor_units: null,
    created_at: "2026-09-27T10:05:00.000Z",
  },
  redirect_url: "https://checkout.flutterwave.com/rsv_abc",
};

const eventParams = (id: string) => ({ params: Promise.resolve({ identifier: id }) });

const postJson = (url: string, body: unknown) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const VALID_BODY = {
  attendee_name: "Ada Lovelace",
  email: "ada@example.com",
  phone: "+2348012345678",
  ticket_type_id: TICKET_TYPE_ID,
  idempotency_key: IDEMPOTENCY_KEY,
};

/** A resolution outcome as the payment service returns it. */
const resolution = (overrides: Record<string, unknown> = {}) => ({
  kind: "confirmed",
  registration: {
    id: REGISTRATION_ID,
    status: "confirmed",
    ticketTypeId: TICKET_TYPE_ID,
    uniqueReference: "BGNEqSon4dw4szERiBHK5o58VDyy",
    createdAt: new Date("2026-09-27T10:05:00.000Z"),
  },
  payment: {
    id: "pay-1",
    registrationId: REGISTRATION_ID,
    providerReference: PROVIDER_REFERENCE,
    expectedAmountMinorUnits: 5_000,
    verifiedAmountMinorUnits: 5_000,
    currency: "NGN",
    status: "success",
    verifiedAt: new Date("2026-09-27T10:06:00.000Z"),
    requiresReconciliation: false,
    rawProviderPayload: { secret: "must never be rendered" },
    createdAt: new Date("2026-09-27T10:05:00.000Z"),
  },
  reason: null,
  ticketTypeName: "General Admission",
  ...overrides,
});

/** A `charge.completed` delivery for the reference above. */
function chargeDelivery(reference = PROVIDER_REFERENCE) {
  return {
    event: "charge.completed",
    data: {
      id: 1_234_567,
      tx_ref: reference,
      flw_ref: "FLW-REF-ABC-123",
      amount: 50,
      currency: "NGN",
      status: "successful",
    },
  };
}

const webhookRequest = (body: unknown, secret: string | null = WEBHOOK_SECRET) =>
  new Request("https://tickets.example.com/api/v1/payments/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret === null ? {} : { "verif-hash": secret }),
    },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  getRegistrationService.mockReturnValue(registrationService);
  getPaymentService.mockReturnValue(paymentService);
  getPaymentEnv.mockReturnValue({ FLUTTERWAVE_WEBHOOK_SECRET: WEBHOOK_SECRET });
  registrationService.createRegistration.mockResolvedValue({ checkout: CHECKOUT, created: true });
  registrationService.initiatePayment.mockResolvedValue({ checkout: CHECKOUT, created: true });
  paymentService.resolve.mockResolvedValue(resolution());
});

// -----------------------------------------------------------------------------
// POST /events/{id}/registrations
// -----------------------------------------------------------------------------

describe("POST /api/v1/events/{id}/registrations", () => {
  it("answers 201 for a registration this call created", async () => {
    const response = await CREATE_REGISTRATION(
      postJson("http://localhost/api/v1/events/e1/registrations", VALID_BODY),
      eventParams(EVENT_ID),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual(CHECKOUT);
  });

  it("answers 200 for a replay, because nothing new was created", async () => {
    // A 201 here tells an idempotent client that a resource now exists which it already
    // had — enough, for a client that keys on the status, to count a retry as a
    // second purchase.
    registrationService.createRegistration.mockResolvedValue({ checkout: CHECKOUT, created: false });

    const response = await CREATE_REGISTRATION(
      postJson("http://localhost/api/v1/events/e1/registrations", VALID_BODY),
      eventParams(EVENT_ID),
    );

    expect(response.status).toBe(200);
  });

  it("passes the path identifier and the parsed body through unchanged", async () => {
    await CREATE_REGISTRATION(
      postJson("http://localhost/api/v1/events/e1/registrations", VALID_BODY),
      eventParams(EVENT_ID),
    );

    expect(registrationService.createRegistration).toHaveBeenCalledWith(EVENT_ID, {
      attendeeName: "Ada Lovelace",
      attendeeEmail: "ada@example.com",
      attendeePhone: "+2348012345678",
      ticketTypeId: TICKET_TYPE_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
  });

  it("reads NO session, because §12 marks this endpoint Public", async () => {
    await CREATE_REGISTRATION(
      postJson("http://localhost/api/v1/events/e1/registrations", VALID_BODY),
      eventParams(EVENT_ID),
    );

    // No auth seam is consulted at all. A signed-in organiser buying a ticket is still
    // an anonymous attendee here, which is why the event's own state is the only gate.
    expect(registrationService.createRegistration).toHaveBeenCalled();
  });

  it("answers 409 for a sold-out tier, and 404 for an event that cannot be sold", async () => {
    registrationService.createRegistration.mockRejectedValueOnce(
      new ConflictError("That ticket tier has no availability left. No registration was created."),
    );
    registrationService.createRegistration.mockRejectedValueOnce(new NotFoundError("No such event."));

    const conflict = await CREATE_REGISTRATION(
      postJson("http://localhost/api/v1/events/e1/registrations", VALID_BODY),
      eventParams(EVENT_ID),
    );
    const missing = await CREATE_REGISTRATION(
      postJson("http://localhost/api/v1/events/e1/registrations", VALID_BODY),
      eventParams(EVENT_ID),
    );

    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ error: { code: "conflict" } });
    expect(missing.status).toBe(404);
  });

  it("answers 400 with field issues for a malformed body, and never calls the service", async () => {
    const response = await CREATE_REGISTRATION(
      postJson("http://localhost/api/v1/events/e1/registrations", { attendee_name: "Ada" }),
      eventParams(EVENT_ID),
    );

    expect(response.status).toBe(400);
    // The renderer renames the parser's `issues` to `fields`, which is the name PRD §15
    // documents, so the assertion uses the documented one.
    const body = (await response.json()) as { error: { code: string; fields: Record<string, string[]> } };
    expect(body.error.code).toBe("validation_failed");
    expect(Object.keys(body.error.fields).sort()).toEqual([
      "email",
      "idempotency_key",
      "phone",
      "ticket_type_id",
    ]);
    expect(registrationService.createRegistration).not.toHaveBeenCalled();
  });

  it("answers 400 for a body that is not JSON at all", async () => {
    const response = await CREATE_REGISTRATION(
      new Request("http://localhost/api/v1/events/e1/registrations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
      eventParams(EVENT_ID),
    );

    expect(response.status).toBe(400);
    expect(registrationService.createRegistration).not.toHaveBeenCalled();
  });

  it("renders an unexpected failure as a 500 without leaking its detail", async () => {
    registrationService.createRegistration.mockRejectedValueOnce(
      new Error("connect ECONNREFUSED 10.0.0.4:5432"),
    );

    const response = await CREATE_REGISTRATION(
      postJson("http://localhost/api/v1/events/e1/registrations", VALID_BODY),
      eventParams(EVENT_ID),
    );

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("ECONNREFUSED");
  });
});

// -----------------------------------------------------------------------------
// POST /payments/initiate
// -----------------------------------------------------------------------------

describe("POST /api/v1/payments/initiate", () => {
  it("answers 201 for a newly prepared attempt, and 200 for a re-served link", async () => {
    const created = await INITIATE_PAYMENT(
      postJson("http://localhost/api/v1/payments/initiate", { registration_id: REGISTRATION_ID }),
    );

    registrationService.initiatePayment.mockResolvedValue({ checkout: CHECKOUT, created: false });
    const reserved = await INITIATE_PAYMENT(
      postJson("http://localhost/api/v1/payments/initiate", { registration_id: REGISTRATION_ID }),
    );

    expect(created.status).toBe(201);
    expect(reserved.status).toBe(200);
  });

  it("passes only the registration id, so no amount can arrive from the client", async () => {
    await INITIATE_PAYMENT(
      postJson("http://localhost/api/v1/payments/initiate", { registration_id: REGISTRATION_ID }),
    );

    expect(registrationService.initiatePayment).toHaveBeenCalledWith(REGISTRATION_ID);
  });

  it("answers 409 for a registration that is already resolved", async () => {
    // A `confirmed`, `cancelled`, or lapsed registration cannot take another payment,
    // and that is a state conflict (§15), not a bad request.
    registrationService.initiatePayment.mockRejectedValue(
      new IllegalTransitionError(
        "This registration is already resolved, so no further payment can be started for it.",
      ),
    );

    const response = await INITIATE_PAYMENT(
      postJson("http://localhost/api/v1/payments/initiate", { registration_id: REGISTRATION_ID }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "conflict" } });
  });

  it("answers 404 for a registration this platform never issued", async () => {
    registrationService.initiatePayment.mockRejectedValue(
      new NotFoundError("No registration exists with that id."),
    );

    const response = await INITIATE_PAYMENT(
      postJson("http://localhost/api/v1/payments/initiate", { registration_id: REGISTRATION_ID }),
    );

    expect(response.status).toBe(404);
  });

  it("answers 400 when the body carries an amount", async () => {
    const response = await INITIATE_PAYMENT(
      postJson("http://localhost/api/v1/payments/initiate", {
        registration_id: REGISTRATION_ID,
        amount: 1,
      }),
    );

    expect(response.status).toBe(400);
    expect(registrationService.initiatePayment).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// POST/GET /payments/verify
// -----------------------------------------------------------------------------

describe("POST and GET /api/v1/payments/verify", () => {
  const confirmedBody = {
    outcome: "confirmed",
    registration: {
      unique_reference: "BGNEqSon4dw4szERiBHK5o58VDyy",
      ticket_type_name: "General Admission",
      status: "confirmed",
      hold_expires_at: null,
    },
    payment: {
      status: "confirmed",
      expected_amount_minor_units: 5_000,
      currency: "NGN",
      verified_amount_minor_units: 5_000,
      verified_at: "2026-09-27T10:06:00.000Z",
    },
  };

  it("answers 200 and the five-state report for a confirmed payment", async () => {
    const response = await VERIFY_POST(
      postJson("http://localhost/api/v1/payments/verify", {
        provider_reference: PROVIDER_REFERENCE,
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(confirmedBody);
  });

  it("asks the service to fetch the facts itself, on the redirect channel", async () => {
    await VERIFY_POST(
      postJson("http://localhost/api/v1/payments/verify", { provider_reference: PROVIDER_REFERENCE }),
    );

    // FR-12: the redirect is not authoritative, so `verified: null` is the instruction
    // to verify before writing, not a claim that there is nothing to check.
    expect(paymentService.resolve).toHaveBeenCalledWith({
      providerReference: PROVIDER_REFERENCE,
      channel: "redirect",
      verified: null,
    });
  });

  it("answers 200 for a FAILED payment, because the caller asked a question", async () => {
    // §12 asks for a report of the state. A failed payment is a true answer, and §10's
    // next step is a new attempt through /initiate, not an error page.
    paymentService.resolve.mockResolvedValue(
      resolution({ kind: "failed", payment: { ...resolution().payment, status: "failed" } }),
    );

    const response = await VERIFY_POST(
      postJson("http://localhost/api/v1/payments/verify", { provider_reference: PROVIDER_REFERENCE }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "failed" });
  });

  it("answers 200 for requires_reconciliation, never a 4xx or 5xx", async () => {
    // The money moved and value was withheld. That is "needs review", which §15 wants
    // surfaced as a state and §17 forbids reporting as a failure.
    //
    // The flag on the stored attempt — not the outcome's `kind` — is what the body
    // reports, which is what makes a repeated `/verify` answer the same thing.
    paymentService.resolve.mockResolvedValue(
      resolution({
        kind: "reconciliation",
        reason: "The amount charged does not equal the ticket price.",
        payment: {
          ...resolution().payment,
          status: "success",
          verifiedAmountMinorUnits: 4_000,
          requiresReconciliation: true,
        },
      }),
    );

    const response = await VERIFY_POST(
      postJson("http://localhost/api/v1/payments/verify", { provider_reference: PROVIDER_REFERENCE }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.outcome).toBe("requires_reconciliation");
    // R-1's ordering rule, visible in the body: a `success` attempt that carries the
    // flag must never read as a confirmation.
    expect((body.payment as Record<string, unknown>).status).toBe("requires_reconciliation");
  });

  it("answers 404 for a reference this platform never issued", async () => {
    paymentService.resolve.mockResolvedValue(
      resolution({ kind: "unknown_reference", registration: null, payment: null }),
    );

    const response = await VERIFY_POST(
      postJson("http://localhost/api/v1/payments/verify", { provider_reference: "rsv_neverIssued" }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ outcome: "not_found" });
  });

  it("marks the response no-store, on BOTH channels", async () => {
    const posted = await VERIFY_POST(
      postJson("http://localhost/api/v1/payments/verify", { provider_reference: PROVIDER_REFERENCE }),
    );
    const fetched = await VERIFY_GET(
      new Request(`http://localhost/api/v1/payments/verify?tx_ref=${PROVIDER_REFERENCE}`),
    );

    expect(posted.headers.get("cache-control")).toBe("no-store");
    // A 200 is cacheable by default, and this body is one attendee's payment state.
    expect(fetched.headers.get("cache-control")).toBe("no-store");
  });

  it("accepts the tx_ref the provider appends to the redirect URL", async () => {
    const response = await VERIFY_GET(
      new Request(`http://localhost/api/v1/payments/verify?tx_ref=${PROVIDER_REFERENCE}&status=successful`),
    );

    expect(response.status).toBe(200);
    expect(paymentService.resolve).toHaveBeenCalledWith({
      providerReference: PROVIDER_REFERENCE,
      channel: "redirect",
      verified: null,
    });
  });

  it("answers 400 for a redirect with no reference, and never calls the service", async () => {
    const response = await VERIFY_GET(new Request("http://localhost/api/v1/payments/verify"));

    expect(response.status).toBe(400);
    expect(paymentService.resolve).not.toHaveBeenCalled();
  });

  it("exposes no provider detail, not even the raw payload", async () => {
    // The service hands this route a `rawProviderPayload`; rule 08 says it stays here.
    const response = await VERIFY_POST(
      postJson("http://localhost/api/v1/payments/verify", { provider_reference: PROVIDER_REFERENCE }),
    );
    const body = await response.text();

    expect(body).not.toContain("rawProviderPayload");
    expect(body).not.toContain("must never be rendered");
    expect(body).not.toContain(PROVIDER_REFERENCE);
    // Nor the reconciliation reason, which is organiser/audit surface.
    expect(body).not.toContain("reason");
  });

  it("omits the attendee's email and phone, which no verify response needs", async () => {
    const body = await (
      await VERIFY_POST(
        postJson("http://localhost/api/v1/payments/verify", { provider_reference: PROVIDER_REFERENCE }),
      )
    ).text();

    expect(body).not.toContain("ada@example.com");
    expect(body).not.toContain("+2348012345678");
  });
});

// -----------------------------------------------------------------------------
// POST /payments/webhook
// -----------------------------------------------------------------------------

describe("POST /api/v1/payments/webhook", () => {
  it("refuses a delivery with no verif-hash, and reads no body at all", async () => {
    const response = await WEBHOOK(webhookRequest(chargeDelivery(), null));

    expect(response.status).toBe(403);
    // The order is the security property: no parse, no lookup, no write.
    expect(paymentService.resolve).not.toHaveBeenCalled();
  });

  it("refuses a delivery with the wrong secret, and leaks nothing about which was wrong", async () => {
    const response = await WEBHOOK(webhookRequest(chargeDelivery(), "guessed"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "forbidden" } });
    expect(paymentService.resolve).not.toHaveBeenCalled();
  });

  it("refuses EVERYTHING when no secret is configured, rather than allowing all", async () => {
    getPaymentEnv.mockReturnValue({ FLUTTERWAVE_WEBHOOK_SECRET: null });

    const response = await WEBHOOK(webhookRequest(chargeDelivery(), WEBHOOK_SECRET));

    expect(response.status).toBe(403);
    expect(paymentService.resolve).not.toHaveBeenCalled();
  });

  it("hands a charge to the service as the authoritative verification, without re-querying", async () => {
    const response = await WEBHOOK(webhookRequest(chargeDelivery()));

    expect(response.status).toBe(200);
    expect(paymentService.resolve).toHaveBeenCalledWith({
      providerReference: PROVIDER_REFERENCE,
      channel: "webhook",
      // The facts come from the delivery. §8.6 is why the provider is not asked again.
      verified: expect.objectContaining({
        providerReference: PROVIDER_REFERENCE,
        amount: 50,
        currency: "NGN",
        status: "successful",
        transactionId: 1_234_567,
      }),
      providerTransactionId: 1_234_567,
    });
  });

  it("retains the WHOLE delivery as the raw payload, envelope included", async () => {
    await WEBHOOK(webhookRequest(chargeDelivery()));

    const call = paymentService.resolve.mock.calls[0]?.[0] as { verified: { raw: unknown } };
    expect(call.verified.raw).toEqual(chargeDelivery());
  });

  it("acknowledges a delivery for an unknown reference instead of failing it", async () => {
    paymentService.resolve.mockResolvedValue(
      resolution({ kind: "unknown_reference", registration: null, payment: null }),
    );

    const response = await WEBHOOK(webhookRequest(chargeDelivery()));

    // The provider retries anything that is not 200. A delivery we cannot act on must
    // not become a retry storm, and must not be reported as a success either.
    expect(response.status).toBe(200);
  });

  it("acknowledges a duplicate delivery without applying it twice", async () => {
    paymentService.resolve.mockResolvedValue(resolution({ kind: "already_resolved" }));

    const response = await WEBHOOK(webhookRequest(chargeDelivery()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "already_resolved" });
  });

  it("acknowledges an event family it does not act on, and calls the service not at all", async () => {
    // `transfer.completed` and the virtual-card events are real deliveries to this URL.
    for (const delivery of [
      { event: "transfer.completed", data: { id: 1, amount: 50 } },
      { event: "bvn.completed", data: { id: 1 } },
      { event: "subscription.cancelled", data: { id: 1 } },
    ]) {
      const response = await WEBHOOK(webhookRequest(delivery));

      expect(response.status).toBe(200);
    }

    expect(paymentService.resolve).not.toHaveBeenCalled();
  });

  it("acknowledges the documented FLAT refund payload rather than erroring on it", async () => {
    // The refund payload has no `event` envelope and no `tx_ref`; it correlates by
    // TransactionId. Handling it is a recorded gap, but the delivery is still valid
    // and must be answered 200 — a non-200 marks it failed and schedules retries.
    const refund = {
      Payload: {
        TransactionId: 1_234_567,
        TransactionStatus: "successful",
        RefundAmount: 50,
      },
    };

    const response = await WEBHOOK(webhookRequest(refund));

    expect(response.status).toBe(200);
    expect(paymentService.resolve).not.toHaveBeenCalled();
  });

  it("answers 400 for an authentic charge whose payload cannot be read", async () => {
    // Reachable only by the provider, so it is a contract failure that must be visible
    // rather than swallowed. Retrying will not help; silence would hide a change.
    const response = await WEBHOOK(
      webhookRequest({ event: "charge.completed", data: { tx_ref: PROVIDER_REFERENCE } }),
    );

    expect(response.status).toBe(400);
    expect(paymentService.resolve).not.toHaveBeenCalled();
  });

  it("answers 400 for a body that is not JSON, or not an object", async () => {
    for (const body of [null, "charge.completed", 42, []]) {
      const response = await WEBHOOK(webhookRequest(body));

      expect(response.status).toBe(400);
    }

    expect(paymentService.resolve).not.toHaveBeenCalled();
  });

  it("answers non-200 for an unexpected failure, so the delivery is retried", async () => {
    // A payment that succeeded must not be lost because this process had a bad moment.
    // A redelivery is a no-op by construction, which is what makes a retry safe.
    paymentService.resolve.mockRejectedValueOnce(new Error("connection reset"));

    const response = await WEBHOOK(webhookRequest(chargeDelivery()));

    expect(response.status).toBe(500);
  });

  it("echoes nothing from the payload in its acknowledgement", async () => {
    const response = await WEBHOOK(webhookRequest(chargeDelivery()));

    const body = await response.text();
    expect(body).not.toContain(PROVIDER_REFERENCE);
    expect(body).not.toContain("FLW-REF-ABC-123");
    expect(body).not.toContain("Ada");
  });
});

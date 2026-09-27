# Rule 08 — Security, Privacy & Evidence

**Axis: what may be exposed, retained, or written to logs.** Rule 05 owns
*whether a request is authorised*; this rule owns *what happens to the data once
it is in hand*.

The product's premise is that it **never misrepresents payment or registration
state** (PRD §1, §18). A privacy or integrity regression here is a correctness
bug, not a hardening nicety.

## Never expose in any API response

- **Password hashes**, or any organiser credential material.
- **Staff-token secrets or `token_hash` values.** Only a hash is stored at all;
  the plaintext is never persisted, never returned, never logged.
- **`Payment.raw_provider_payload` in full, to attendees or staff.** Only derived
  status fields go to those roles. Full payloads are **organiser/audit-only**
  (PRD §18).
- **Internal provider details** beyond what a role actually needs — provider
  references, internal codes, gateway diagnostics are organiser/audit surface,
  not attendee or staff surface.
- **Internal counters** on public surfaces (`quantity_confirmed`,
  `quantity_held`, `quantity_total`) — use the public-safe
  `TicketTypeSummaryDTO` (rule 06, PRD §13).
- **Other events' data** to a staff token, and other organisers' data to an
  organiser (rule 05).

DTO allow-lists, not deny-lists: define what a role may receive and serialise
exactly that. A deny-list silently leaks the next field someone adds.

## Ticket evidence retrieval — privacy

- Evidence requires **reference + matching email** (two-factor). Reference alone
  must never be sufficient (PRD §3, §15, §18).
- On email/reference mismatch return **`403`, never `404`** — a `404` confirms
  to an attacker which references exist (PRD §15). This is a deliberate status
  choice, not an oversight.
- The mismatch response must not differ in shape, timing, or wording between
  "no such reference" and "wrong email" — otherwise the 403 leaks the same
  information it was chosen to protect.
- Evidence shows **live** event details, not a snapshot (BR-6), so an organiser's
  edit is reflected rather than requiring a reconciliation path.
- Do not return the registration's payment history, check-in log, or attendee
  requests through the evidence endpoint — evidence is the attendee's own ticket
  view, nothing more.

## Identifier entropy

- `unique_reference` and every `idempotency_key`: **≥ 128 bits of entropy**
  (PRD §18). Non-sequential, non-guessable, not derived from a counter,
  timestamp, or visible attribute.
- Generate with a cryptographically secure source. UUIDs are acceptable for
  `idempotency_key`; the reference must be equally unguessable.
- Enumeration resistance is a property of the *whole* lookup, not just the
  token's length: rate limiting and the `403`-not-`404` rule are both part of it.

## Event isolation

- Every read and write is scoped to a single event, resolved **server-side**
  (rule 05). A staff token's scope comes from the token, never from a
  client-supplied `event_id`.
- Public event lookup returns only `published`, non-soft-deleted events.
- Cross-event leakage via a related resource is a real risk: a `Registration.id`
  from event A must not be actionable through event B's endpoints. Resolve
  parent→child relationships before authorising, not after.

## Logging discipline

- **Never log secrets**: staff-token values, provider signing/secret keys,
  passwords or hashes, raw card-adjacent data.
- **Log identifiers and outcomes**, not sensitive payloads: log the
  `provider_reference`, the resulting status, and the transition — not the
  provider's raw body or the attendee's full details.
- Retained `raw_provider_payload` exists for **audit and dispute resolution**
  (PRD §7.2, §14) and is read by audit surfaces, not by general application
  logs.
- Access denials (IDOR attempts, cross-event access, signature failures,
  expired/revoked token use) are **loggable events** — they are evidence that the
  boundary is being tested.
- An error response or log line must not carry a stack trace, SQL, or provider
  payload to a client.

## Auditability (retain, never destroy)

Required by PRD §14 and Must-Have in §20:

- Every **Payment** state transition is timestamped on the Payment row, with
  `raw_provider_payload` retained.
- Every **Check-in**, including overrides, is its own immutable row — no in-place
  edits (rule 03).
- Every **Attendee Request** and its resolution is retained, **never deleted**;
  resolution notes are part of the record.
- Organiser **edits to published event/tier details are logged** (what changed,
  when). The log is Must-Have; attendee *notification* on top of it is
  Supporting and is not built (PRD §20, AGENTS.md §11.2).
- **Events are soft-deleted (`deleted_at`), never hard-deleted, once any
  `Payment` exists** against them. The audit trail outranks the deletion request.
- A payment that succeeded but could not be confirmed is **flagged for
  reconciliation**, not deleted and not hidden — money moved, and a human must be
  able to see it (PRD §8.5).

## Never trust client-provided authorization or state

Out of summary, because it is the recurring source of real defects:

- amount / price / total → always server-computed (rule 04)
- `event_id` as proof of scope → resolved server-side (rule 05)
- role / ownership / tier claims → derived from the verified credential
- `available` / `quantity_*` → derived from the DB
- registration or payment `status` from the client → derived from the lifecycle
  (rule 03)
- signature / authenticity of a webhook → verified before any write (rule 04)

A hidden button, a disabled control, or a client-side route guard is **never** a
security boundary. Every such rule must be enforced by the endpoint itself
(FR-21 is the canonical example).

## Verification expectations

Security controls here are only real if tested (AGENTS.md §17, PRD §16):

- an attendee cannot retrieve another attendee's evidence (`403` on mismatch);
- staff tokens cannot access other events;
- organisers cannot access other organisers' events (IDOR);
- unsigned / incorrectly-signed webhooks are rejected with **zero** state changes;
- revoked/expired staff tokens are rejected on the next request;
- a public event response contains no internal counters or provider data.

## Related

- `05-authentication-authorization-and-event-scope.md` — the access model
- `06-api-contract-and-validation.md` — DTO allow-lists, status codes
- `04-payment-and-flutterwave-integrity.md` — provider payload handling

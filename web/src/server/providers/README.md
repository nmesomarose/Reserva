# `src/server/providers` — external provider integrations

Adapters for third-party services. **Flutterwave is the one payment provider**
(PRD v2 §8); no alternative provider may be introduced.

## Boundary

- **Server-only.** Provider credentials must never reach the client bundle.
- **Amounts are never accepted from the client.** A provider amount is always
  server-computed from the stored `TicketType.price_minor_units` (FR-11).
- **No provider response is authoritative on its own.** Client/browser redirect
  state is never proof of payment; webhook authenticity is verified before any
  state change; the webhook is the eventual source of truth when a
  redirect-check and a webhook disagree (§8.6).
- Raw provider payloads are retained for audit but are **never** returned to
  attendee- or staff-facing responses.
- Keep the provider call isolated behind a small adapter so the rest of the
  domain does not depend on provider response shapes.

## Governing rules

- `.agents/rules/04-payment-and-flutterwave-integrity.md`
- `.agents/skills/flutterwave-payment-verification/SKILL.md`

## Status

The Flutterwave integration lives in `src/server/flutterwave/` (client, redirect
URL assembly, transaction payload, and webhook signature verification). The
Flutterwave-specific mechanics were confirmed against current official
documentation before being written — the record is
`docs/evidence/flutterwave-verify-resolution.md`. One item remains open and is
recorded as `O-7` in `docs/evidence/requirements-matrix.md`: the webhook does
not yet recognise a post-success **reversal**. Flutterwave is the one payment
provider (PRD v2 §8); no alternative may be introduced.

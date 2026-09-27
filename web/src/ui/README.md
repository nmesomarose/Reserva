# `src/ui` — UI / application layer

Presentational and client-interaction code: React components, client state, and
form composition.

## Boundary

- **Renders** state that the server already established. It must never infer or
  upgrade a payment or registration status — a non-confirmed registration must
  never be rendered as a valid ticket.
- **Does not:** compute amounts, decide authorization, or contain
  payment-verification or lifecycle logic. Those belong to `src/domain` and the
  API layer.
- Reads all visual values from the `--ds-*` design tokens imported in
  `src/app/globals.css`. Never introduce hex codes, magic pixel values, or a
  second token system (`AGENTS.md §11.1`).
- Secrets, database access, and provider credentials are unreachable from here;
  server modules are `server-only`.

## Governing rules

- `.agents/rules/06-api-contract-and-validation.md` — DTO allow-lists
- `.agents/rules/08-security-privacy-and-evidence.md` — never trust
  client-provided authorization or state

## Status

Empty by design. The product-state treatments required by `AGENTS.md §11.2`
(pending vs confirmed payment, sold-out tier, zero/multiple search matches,
check-in conflict, expired staff access) are not implemented yet.

# `src/server/auth` — authentication & authorization

Where the three access tiers of PRD v2 §3 are implemented and enforced:
organiser accounts, event-scoped staff tokens, and two-factor attendee evidence
lookup.

## Boundary

- **Server-only.** Every module here must `import "server-only"` so a Client
  Component cannot pull credentials or session handling into the browser bundle.
- **Every authorization decision is made server-side.** A client-supplied
  `event_id`, role claim, or ownership assertion is never trusted without a
  check against the authenticated identity (`AGENTS.md §4`, §7).
- Organiser scope is `event.organiser_id == current_user.id`, verified on every
  organiser-scoped request. Staff scope comes from the staff token's own
  `event_id`, never from the request body.
- Revoked and expired tokens are rejected on the next request server-side, not
  merely hidden in the UI.

## Governing rules

- `.agents/rules/05-authentication-authorization-and-event-scope.md`
- `.agents/rules/08-security-privacy-and-evidence.md` — token secrecy

## Status

**Boundary in place, no mechanism implemented (2026-09-26).**

`organiser-context.ts` defines `OrganiserContext`, an
`OrganiserContextResolver` port, and a placeholder resolver that always throws
`OrganiserAuthenticationUnavailableError`. `POST /api/v1/events` resolves the
organiser through it and answers `501` — the authorisation *model* is already
wired and server-derived, but no credential is ever checked.

Still true: **no** password handling, sessions, JWTs, magic links, staff tokens,
or login flows. The organiser authentication mechanism and the staff-token
transport are both explicitly undecided — PRD v2 §19 and `AGENTS.md §21.4`–`§21.5`
— and must be decided, not invented, when this layer is built. Implementing the
resolver is a one-file change with no business-rule impact.

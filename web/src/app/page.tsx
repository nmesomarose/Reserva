import Link from "next/link";

/**
 * Public root page for the Reserva API.
 *
 * This is the front door to the application. The product surface is an HTTP
 * API under `/api/v1`; this page describes what that API implements rather than
 * reproducing any of its screens. It is deliberately minimal — the browser UI
 * is a separate, later workstream — so it lists capabilities and points at the
 * one operational endpoint a visitor can always check (`/api/health`).
 *
 * All visual values come from the generated design tokens
 * (`dist/tokens.css`, imported in `globals.css`). No hardcoded colours or
 * spacing — see AGENTS.md §11.1.
 */
export default function Home() {
  return (
    <main
      style={{
        maxWidth: "48rem",
        margin: "0 auto",
        padding: "var(--ds-spacing-extra-large)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--ds-spacing-large)",
      }}
    >
      <header style={{ display: "flex", flexDirection: "column", gap: "var(--ds-spacing-small)" }}>
        <h1 style={{ margin: 0, fontFamily: "var(--ds-typography-headline-large-font)" }}>
          Reserva — Event Management &amp; Ticketing Platform
        </h1>
        <p style={{ margin: 0 }}>
          A complete event-ticketing API: events, ticket tiers, registrations,
          Flutterwave payments, staff check-in, attendee requests, and a live
          organiser dashboard — with server-side authorisation and
          database-enforced integrity.
        </p>
      </header>

      <section
        aria-labelledby="capabilities-heading"
        style={{
          backgroundColor: "var(--ds-color-secondary-container)",
          color: "var(--ds-color-on-secondary-container)",
          borderRadius: "var(--ds-spacing-small)",
          boxShadow: "var(--ds-shadow-soft-shadow)",
          padding: "var(--ds-spacing-large)",
        }}
      >
        <h2 id="capabilities-heading" style={{ marginTop: 0 }}>
          API capabilities
        </h2>
        <ul style={{ margin: 0, paddingInlineStart: "var(--ds-spacing-large)" }}>
          <li>
            <strong>Events &amp; programme</strong> — create, publish, edit,
            soft-delete, and author an ordered agenda, with an append-only change log.
          </li>
          <li>
            <strong>Ticket tiers &amp; inventory</strong> — per-tier pricing in
            minor units and a two-counter availability model (held vs confirmed)
            with 15-minute holds.
          </li>
          <li>
            <strong>Registrations</strong> — idempotent creation with a
            non-guessable reference; confirmation only via a verified payment.
          </li>
          <li>
            <strong>Payments</strong> — Flutterwave initiate, server-side
            verification, a signature-checked webhook, and an atomic confirmation
            transaction.
          </li>
          <li>
            <strong>Check-in</strong> — an append-only staff check-in log with
            overrides and eligibility enforcement.
          </li>
          <li>
            <strong>Staff tokens</strong> — event-scoped, revocable, bounded-lifetime
            access for search and check-in.
          </li>
          <li>
            <strong>Attendee requests</strong> — submit an issue against a
            registration, and respond to or resolve it from the organiser queue.
          </li>
          <li>
            <strong>Organiser dashboard</strong> — aggregate counts (registrations,
            payments, tier sales, check-ins) with an SSE live stream.
          </li>
          <li>
            <strong>Evidence</strong> — two-factor ticket retrieval by reference
            plus email.
          </li>
        </ul>
      </section>

      <section
        aria-labelledby="foundation-heading"
        style={{
          backgroundColor: "var(--ds-color-tertiary-container)",
          color: "var(--ds-color-on-tertiary-container)",
          borderRadius: "var(--ds-spacing-small)",
          padding: "var(--ds-spacing-large)",
        }}
      >
        <h2 id="foundation-heading" style={{ marginTop: 0 }}>
          Foundation
        </h2>
        <ul style={{ margin: 0, paddingInlineStart: "var(--ds-spacing-large)" }}>
          <li>Next.js App Router + TypeScript (strict)</li>
          <li>Prisma 7 + PostgreSQL — the full PRD §7.2 schema with constraints and triggers</li>
          <li>Layer boundaries: ui / app (routes) / domain / server (db, auth, flutterwave, validation)</li>
          <li>Design tokens imported from the repository root</li>
        </ul>
      </section>

      <section aria-labelledby="status-heading">
        <h2 id="status-heading">Service status</h2>
        <p>
          <Link href="/api/health">GET /api/health</Link> reports whether the
          service is up and whether required configuration is present.
        </p>
      </section>
    </main>
  );
}

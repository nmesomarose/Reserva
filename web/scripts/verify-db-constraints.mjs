#!/usr/bin/env node
/**
 * Database integrity verification — PRD v2 §7 / AGENTS.md §5, §17.
 *
 * AGENTS.md §17: "a passing build does not prove the constraint rejects the
 * invalid write". This script ATTEMPTS the invalid writes against real
 * PostgreSQL and records the rejection, rather than inspecting the schema.
 *
 * Everything runs inside ONE transaction. Each case runs between a SAVEPOINT
 * and a ROLLBACK TO SAVEPOINT, so every case is independent and the script
 * leaves ZERO rows behind in the database. This is deliberately not seed data.
 *
 * Usage: npm run db:verify-constraints
 * Exits non-zero if any case does not behave as the PRD requires.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const EXPECTED_TABLES = [
  "attendee_requests",
  "check_ins",
  "event_edit_logs",
  "events",
  "organiser_sessions",
  "organisers",
  "payments",
  "programme_items",
  "registrations",
  "staff_tokens",
  "ticket_types",
];

/** CHECK constraints asserted by name, so a silently dropped one fails the run. */
const EXPECTED_CHECKS = [
  "attendee_requests_status_resolved_at_check",
  "check_ins_exactly_one_actor_check",
  "event_edit_logs_changes_non_empty_check",
  "events_description_length_check",
  "events_name_length_check",
  "events_slug_length_check",
  "events_time_order_check",
  "events_venue_length_check",
  "organiser_sessions_expires_in_future_check",
  "ticket_types_currency_iso4217_check",
  "ticket_types_description_length_check",
  "ticket_types_name_length_check",
  "ticket_types_price_non_negative_check",
  "ticket_types_quantity_non_negative_check",
  "ticket_types_quantity_total_positive_check",
  "ticket_types_quantity_within_total_check",
];

function loadDatabaseUrl() {
  const raw = readFileSync(path.join(webRoot, ".env"), "utf8");
  const match = raw.match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m);
  if (!match) throw new Error("DATABASE_URL not found in web/.env");
  return match[1].trim();
}

const results = [];

function record(label, expectation, ok, detail) {
  results.push({ label, expectation, ok, detail });
}

function shorten(text) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > 150 ? `${flat.slice(0, 147)}...` : flat;
}

/** Runs the statement and requires it to be REJECTED by the database. */
async function expectRejected(client, label, sql, params = []) {
  await client.query("SAVEPOINT sp");
  try {
    await client.query(sql, params);
    record(label, "reject", false, "ACCEPTED — the database did not reject it");
  } catch (error) {
    record(label, "reject", true, shorten(`${error.code ?? ""} ${error.message}`));
  }
  await client.query("ROLLBACK TO SAVEPOINT sp");
}

/** Runs the statement and requires it to be ACCEPTED (guards against a constraint that rejects everything). */
async function expectAccepted(client, label, sql, params = []) {
  await client.query("SAVEPOINT sp");
  try {
    await client.query(sql, params);
    record(label, "accept", true, "accepted as expected");
  } catch (error) {
    record(label, "accept", false, shorten(`REJECTED — ${error.code ?? ""} ${error.message}`));
  }
  await client.query("ROLLBACK TO SAVEPOINT sp");
}

async function expectQuery(client, label, sql, params = [], validate) {
  await client.query("SAVEPOINT sp");
  try {
    const result = await client.query(sql, params);
    const ok = validate(result);
    record(label, "query", ok, ok ? shorten(JSON.stringify(result.rows[0] ?? {})) : "validation failed");
  } catch (error) {
    record(label, "query", false, shorten(`${error.code ?? ""} ${error.message}`));
  }
  await client.query("ROLLBACK TO SAVEPOINT sp");
}

async function main() {
  const client = new Client({ connectionString: loadDatabaseUrl() });
  await client.connect();
  console.log(`Connected: ${client.database}@${client.host}:${client.port}\n`);

  // --- Structure -----------------------------------------------------------
  const tables = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  const found = tables.rows.map((r) => r.table_name);
  const missing = EXPECTED_TABLES.filter((t) => !found.includes(t));
  record(
    // 9 tabulated in PRD §7.2, plus EventEditLog (decision 4 in rule 02) and
    // OrganiserSession (the session store the auth decision requires). Naming
    // the additions keeps the count honest instead of quietly inflating it.
    `All 9 PRD §7.2 tables + EventEditLog + OrganiserSession exist (${EXPECTED_TABLES.length} expected)`,
    "query",
    missing.length === 0,
    missing.length === 0 ? found.join(", ") : `MISSING: ${missing.join(", ")}`,
  );

  // Every migration on disk must have a FINISHED, non-rolled-back row. Reading the
  // directory rather than counting `_prisma_migrations` is what makes this a real
  // check: a count passes just as happily when a migration was added and never
  // deployed, and fails when Prisma has left a normal `rolled_back_at` record of an
  // aborted `migrate dev` — which is not a broken database, it is Prisma doing its job.
  const migrationDirs = readdirSync(path.join(webRoot, "prisma", "migrations"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const appliedRows = await client.query(
    `SELECT migration_name, finished_at IS NOT NULL AS ok FROM _prisma_migrations
      WHERE rolled_back_at IS NULL ORDER BY migration_name`,
  );
  const appliedNames = new Set(appliedRows.rows.filter((r) => r.ok).map((r) => r.migration_name));
  const notApplied = migrationDirs.filter((name) => !appliedNames.has(name));
  record(
    `${migrationDirs.length} migrations on disk are recorded as applied (${appliedNames.size} applied in the database)`,
    "query",
    notApplied.length === 0,
    notApplied.length === 0
      ? migrationDirs.join(", ")
      : `NOT APPLIED: ${notApplied.join(", ")}`,
  );

  const checks = await client.query(
    `SELECT conname FROM pg_constraint WHERE conname = ANY($1::text[]) ORDER BY conname`,
    [EXPECTED_CHECKS],
  );
  const foundChecks = checks.rows.map((r) => r.conname);
  const missingChecks = EXPECTED_CHECKS.filter((c) => !foundChecks.includes(c));
  record(
    `${EXPECTED_CHECKS.length} CHECK constraints present in pg_constraint`,
    "query",
    missingChecks.length === 0,
    missingChecks.length === 0 ? foundChecks.join(", ") : `MISSING: ${missingChecks.join(", ")}`,
  );

  const triggers = await client.query(
    `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname`,
  );
  const expectedTriggers = [
    "attendee_requests_forbid_delete",
    "attendee_requests_guard_update",
    "check_ins_insert_guard",
    "check_ins_no_delete",
    "check_ins_no_update",
    "event_edit_logs_no_delete",
    "event_edit_logs_no_update",
    "payment_status_transition_guard",
    "registration_status_transition_guard",
    "registration_ticket_type_event_guard",
  ];
  const triggerNames = triggers.rows.map((r) => r.tgname);
  const missingTriggers = expectedTriggers.filter((t) => !triggerNames.includes(t));
  record(
    `${expectedTriggers.length} integrity triggers present`,
    "query",
    missingTriggers.length === 0,
    missingTriggers.length === 0 ? triggerNames.join(", ") : `MISSING: ${missingTriggers.join(", ")}`,
  );

  // --- Fixture (rolled back at the end) ------------------------------------
  await client.query("BEGIN");

  const { rows: [org] } = await client.query(
    `INSERT INTO organisers (email) VALUES ('verify@example.test') RETURNING id`,
  );
  const { rows: [eventA] } = await client.query(
    `INSERT INTO events (organiser_id, name, slug, description, starts_at, ends_at, venue)
     VALUES ($1, 'Event A', 'verify-event-a', 'd', now(), now() + interval '2 days', 'Venue A') RETURNING id`,
    [org.id],
  );
  const { rows: [eventB] } = await client.query(
    `INSERT INTO events (organiser_id, name, slug, description, starts_at, ends_at, venue)
     VALUES ($1, 'Event B', 'verify-event-b', 'd', now(), now() + interval '2 days', 'Venue B') RETURNING id`,
    [org.id],
  );
  const { rows: [tierA] } = await client.query(
    `INSERT INTO ticket_types (event_id, name, price_minor_units, currency, quantity_total)
     VALUES ($1, 'General', 500000, 'NGN', 10) RETURNING id`,
    [eventA.id],
  );
  const { rows: [tierB] } = await client.query(
    `INSERT INTO ticket_types (event_id, name, price_minor_units, currency, quantity_total)
     VALUES ($1, 'General', 100000, 'NGN', 10) RETURNING id`,
    [eventB.id],
  );
  const { rows: [regA] } = await client.query(
    `INSERT INTO registrations (event_id, ticket_type_id, unique_reference, attendee_name,
        attendee_email, attendee_phone, status, idempotency_key)
     VALUES ($1, $2, $3, 'Ada', 'ada@example.test', '+234000000000', 'confirmed', $4) RETURNING id`,
    [eventA.id, tierA.id, "ref-verify-0000000000000001", "idem-verify-0000000000000001"],
  );
  const { rows: [token] } = await client.query(
    `INSERT INTO staff_tokens (event_id, token_hash, label, expires_at)
     VALUES ($1, 'hash-verify-0000000000000001', 'Door A', now() + interval '1 day') RETURNING id`,
    [eventA.id],
  );

  // --- 1. TicketType inventory CHECKs (PRD §7.2, BR-3) ---------------------
  await expectRejected(
    client,
    "1. quantity_confirmed + quantity_held > quantity_total",
    `INSERT INTO ticket_types (event_id, name, price_minor_units, currency, quantity_total,
        quantity_confirmed, quantity_held)
     VALUES ($1, 'Over', 100, 'NGN', 10, 8, 5)`,
    [eventA.id],
  );
  await expectRejected(
    client,
    "2a. negative quantity_confirmed",
    `INSERT INTO ticket_types (event_id, name, price_minor_units, currency, quantity_total, quantity_confirmed)
     VALUES ($1, 'NegC', 100, 'NGN', 10, -1)`,
    [eventA.id],
  );
  await expectRejected(
    client,
    "2b. negative quantity_held",
    `INSERT INTO ticket_types (event_id, name, price_minor_units, currency, quantity_total, quantity_held)
     VALUES ($1, 'NegH', 100, 'NGN', 10, -1)`,
    [eventA.id],
  );
  await expectAccepted(
    client,
    "2c. CONTROL: confirmed + held == total (boundary) is allowed",
    `INSERT INTO ticket_types (event_id, name, price_minor_units, currency, quantity_total,
        quantity_confirmed, quantity_held)
     VALUES ($1, 'Exact', 100, 'NGN', 10, 8, 2)`,
    [eventA.id],
  );

  // --- 2. CheckIn exactly-one-actor CHECK ----------------------------------
  await expectRejected(
    client,
    "3. CheckIn with NEITHER actor",
    `INSERT INTO check_ins (registration_id, checked_in_at) VALUES ($1, now())`,
    [regA.id],
  );
  await expectRejected(
    client,
    "4. CheckIn with BOTH actors",
    `INSERT INTO check_ins (registration_id, checked_in_at, organiser_id, staff_token_id)
     VALUES ($1, now(), $2, $3)`,
    [regA.id, org.id, token.id],
  );
  await expectAccepted(
    client,
    "4a. CONTROL: CheckIn with organiser actor only",
    `INSERT INTO check_ins (registration_id, checked_in_at, organiser_id) VALUES ($1, now(), $2)`,
    [regA.id, org.id],
  );
  await expectAccepted(
    client,
    "4b. CONTROL: CheckIn with staff-token actor only",
    `INSERT INTO check_ins (registration_id, checked_in_at, staff_token_id) VALUES ($1, now(), $2)`,
    [regA.id, token.id],
  );

  // --- 3. At most one successful Payment per Registration ------------------
  const { rows: [paySuccess] } = await client.query(
    `INSERT INTO payments (registration_id, provider_reference, expected_amount_minor_units,
        currency, status, verified_at, verified_amount_minor_units)
     VALUES ($1, 'prov-verify-00000000000001', 500000, 'NGN', 'success', now(), 500000) RETURNING id`,
    [regA.id],
  );
  // Persisted (not inside a savepoint) so the forbidden-transition test below has
  // a real `failed` row to attempt an update against.
  await client.query(
    `INSERT INTO payments (registration_id, provider_reference, expected_amount_minor_units, currency, status)
     VALUES ($1, 'prov-verify-00000000000003', 500000, 'NGN', 'failed')`,
    [regA.id],
  );
  await expectRejected(
    client,
    "5. SECOND successful Payment for the same Registration",
    `INSERT INTO payments (registration_id, provider_reference, expected_amount_minor_units, currency, status)
     VALUES ($1, 'prov-verify-00000000000002', 500000, 'NGN', 'success')`,
    [regA.id],
  );
  await expectAccepted(
    client,
    "5a. CONTROL: a further FAILED attempt for the same Registration is allowed",
    `INSERT INTO payments (registration_id, provider_reference, expected_amount_minor_units, currency, status)
     VALUES ($1, 'prov-verify-00000000000004', 500000, 'NGN', 'failed')`,
    [regA.id],
  );
  await expectAccepted(
    client,
    "5b. CONTROL: updating a non-status column of the successful Payment is allowed",
    `UPDATE payments SET updated_at = now() WHERE id = $1`,
    [paySuccess.id],
  );

  // --- 4. Uniqueness constraints -------------------------------------------
  // NOTE: the dates here are valid on purpose. `events_time_order_check` exists
  // now, so a `now(), now()` pair would be rejected for the wrong reason and
  // these cases would pass without ever exercising the constraint they name.
  await expectRejected(client, "6a. duplicate Event.slug", `INSERT INTO events (organiser_id, name, slug, description, starts_at, ends_at, venue) VALUES ($1, 'Dup', 'verify-event-a', 'd', now(), now() + interval '1 hour', 'v')`, [org.id]);
  await expectRejected(client, "6b. duplicate Organiser.email", `INSERT INTO organisers (email) VALUES ('verify@example.test')`);
  await expectRejected(client, "6c. duplicate Registration.unique_reference", `INSERT INTO registrations (event_id, ticket_type_id, unique_reference, attendee_name, attendee_email, attendee_phone, status, idempotency_key) VALUES ($1, $2, 'ref-verify-0000000000000001', 'X', 'x@example.test', '+1', 'pending_payment', 'idem-verify-0000000000000002')`, [eventA.id, tierA.id]);
  await expectRejected(client, "6d. duplicate Registration.idempotency_key", `INSERT INTO registrations (event_id, ticket_type_id, unique_reference, attendee_name, attendee_email, attendee_phone, status, idempotency_key) VALUES ($1, $2, 'ref-verify-0000000000000003', 'X', 'x@example.test', '+1', 'pending_payment', 'idem-verify-0000000000000001')`, [eventA.id, tierA.id]);
  await expectRejected(client, "6e. duplicate Payment.provider_reference", `INSERT INTO payments (registration_id, provider_reference, expected_amount_minor_units, currency, status) VALUES ($1, 'prov-verify-00000000000001', 1, 'NGN', 'initiated')`, [regA.id]);
  await expectRejected(client, "6f. duplicate (TicketType.event_id, name)", `INSERT INTO ticket_types (event_id, name, price_minor_units, currency, quantity_total) VALUES ($1, 'General', 1, 'NGN', 1)`, [eventA.id]);
  await expectRejected(client, "6g. duplicate StaffToken.token_hash", `INSERT INTO staff_tokens (event_id, token_hash, label, expires_at) VALUES ($1, 'hash-verify-0000000000000001', 'Dup', now())`, [eventA.id]);
  await client.query(
    `INSERT INTO attendee_requests (registration_id, message, status, idempotency_key)
     VALUES ($1, 'first', 'open', 'idem-verify-0000000000000020')`,
    [regA.id],
  );
  await expectRejected(client, "6h. duplicate AttendeeRequest.idempotency_key", `INSERT INTO attendee_requests (registration_id, message, status, idempotency_key) VALUES ($1, 'second', 'open', 'idem-verify-0000000000000020')`, [regA.id]);
  // Persisted (no savepoint) so 6i has an existing row to collide with — the
  // unique index rejects a second row only if a first one is really there.
  await client.query(
    `INSERT INTO organiser_sessions (organiser_id, token_hash, expires_at)
     VALUES ($1, 'hash-verify-0000000000000002', now() + interval '7 days')`,
    [org.id],
  );
  await expectRejected(client, "6i. duplicate OrganiserSession.token_hash", `INSERT INTO organiser_sessions (organiser_id, token_hash, expires_at) VALUES ($1, 'hash-verify-0000000000000002', now() + interval '1 day')`, [org.id]);

  // --- 5. Forbidden lifecycle transitions (PRD §9) -------------------------
  for (const [label, from, to] of [
    ["7a. Registration cancelled -> confirmed (forbidden)", "cancelled", "confirmed"],
    ["7b. Registration cancelled -> checked_in (forbidden)", "cancelled", "checked_in"],
    ["7c. Registration refunded -> confirmed (forbidden)", "refunded", "confirmed"],
    ["7d. Registration checked_in -> pending_payment (forbidden)", "checked_in", "pending_payment"],
  ]) {
    await client.query("SAVEPOINT sp");
    try {
      await client.query(`UPDATE registrations SET status = $2 WHERE id = $1`, [regA.id, from]);
      await client.query(`UPDATE registrations SET status = $2 WHERE id = $1`, [regA.id, to]);
      record(label, "reject", false, "ACCEPTED — the database did not reject it");
    } catch (error) {
      record(label, "reject", true, shorten(`${error.code ?? ""} ${error.message}`));
    }
    await client.query("ROLLBACK TO SAVEPOINT sp");
  }
  await expectAccepted(
    client,
    "7e. CONTROL: Registration pending_payment -> confirmed (allowed)",
    `UPDATE registrations SET status = 'pending_payment' WHERE id = $1`,
    [regA.id],
  );
  await client.query("UPDATE registrations SET status = 'confirmed' WHERE id = $1", [regA.id]);
  await expectRejected(
    client,
    "7f. Payment failed -> success on the same row (forbidden)",
    `UPDATE payments SET status = 'success' WHERE provider_reference = 'prov-verify-00000000000003'`,
  );
  await expectQuery(
    client,
    "7g. CONTROL: that Payment is still failed after the rejected update",
    `SELECT status::text AS status FROM payments WHERE provider_reference = 'prov-verify-00000000000003'`,
    [],
    (r) => r.rows[0]?.status === "failed",
  );

  // --- 6. R-2: late webhook after hold-expiry cancellation -----------------
  const { rows: [regC] } = await client.query(
    `INSERT INTO registrations (event_id, ticket_type_id, unique_reference, attendee_name,
        attendee_email, attendee_phone, status, idempotency_key)
     VALUES ($1, $2, 'ref-verify-0000000000000009', 'Late', 'late@example.test', '+2', 'cancelled', 'idem-verify-0000000000000009') RETURNING id`,
    [eventA.id, tierA.id],
  );
  await client.query(
    `INSERT INTO payments (registration_id, provider_reference, expected_amount_minor_units, currency, status)
     VALUES ($1, 'prov-verify-00000000000009', 500000, 'NGN', 'pending')`,
    [regC.id],
  );
  await expectAccepted(
    client,
    "8a. R-2: late webhook may set a PENDING payment to success + flag reconciliation",
    `UPDATE payments SET status = 'success', verified_at = now(), verified_amount_minor_units = 500000,
        requires_reconciliation = true WHERE provider_reference = 'prov-verify-00000000000009'`,
  );
  await expectQuery(
    client,
    "8b. R-2: registration is STILL cancelled (no CANCELLED -> CONFIRMED)",
    `SELECT status::text AS status FROM registrations WHERE id = $1`,
    [regC.id],
    (r) => r.rows[0]?.status === "cancelled",
  );

  // --- 7. CheckIn append-only (PRD §9.4, §14) -----------------------------
  const { rows: [checkIn] } = await client.query(
    `INSERT INTO check_ins (registration_id, checked_in_at, organiser_id) VALUES ($1, now(), $2) RETURNING id`,
    [regA.id, org.id],
  );
  await expectRejected(client, "9a. UPDATE an existing CheckIn row", `UPDATE check_ins SET is_override = true WHERE id = $1`, [checkIn.id]);
  await expectRejected(client, "9b. DELETE an existing CheckIn row", `DELETE FROM check_ins WHERE id = $1`, [checkIn.id]);
  await expectAccepted(
    client,
    "9c. CONTROL: a repeat check-in is a NEW row with is_override = true",
    `INSERT INTO check_ins (registration_id, checked_in_at, organiser_id, is_override) VALUES ($1, now(), $2, true)`,
    [regA.id, org.id],
  );

  // --- 7b. CheckIn insertion guards (PRD §9.4, §4.4.4, §18, FR-21) ----------
  // `20260927000000_check_in_guards` added eligibility, actor scope and
  // override-meaningfulness; `20260927010000_check_in_serialise` made them true under
  // concurrency; `20260927030000_check_in_single_first` added the converse of the
  // override rule. Every one is proved here against a write that bypasses the service
  // entirely, because that is the only kind of write they exist to stop — the
  // application decides all of this itself and returns 409s long before an INSERT runs.
  //
  // Each case is also paired with an accept case, because a guard written so that it
  // rejects everything would pass every reject case below.
  const { rows: [regPending] } = await client.query(
    `INSERT INTO registrations (event_id, ticket_type_id, unique_reference, attendee_name,
        attendee_email, attendee_phone, status, idempotency_key)
     VALUES ($1, $2, 'ref-verify-0000000000000021', 'Unpaid', 'unpaid@example.test', '+3', 'pending_payment', 'idem-verify-0000000000000021') RETURNING id`,
    [eventA.id, tierA.id],
  );
  await expectRejected(
    client,
    "9d. CheckIn for a Registration whose status is pending_payment (FR-21 eligibility)",
    `INSERT INTO check_ins (registration_id, checked_in_at, staff_token_id) VALUES ($1, now(), $2)`,
    [regPending.id, token.id],
  );
  // Persisted (no savepoint) so the control below acts on a genuinely confirmed row.
  // Without this the control would be rejected by the same guard and would prove
  // nothing about what the guard should allow.
  await client.query(`UPDATE registrations SET status = 'confirmed' WHERE id = $1`, [regPending.id]);
  await expectAccepted(
    client,
    "9e. CONTROL: the same write is accepted once the registration is confirmed",
    `INSERT INTO check_ins (registration_id, checked_in_at, staff_token_id) VALUES ($1, now(), $2)`,
    [regPending.id, token.id],
  );

  const { rows: [regForeign] } = await client.query(
    `INSERT INTO registrations (event_id, ticket_type_id, unique_reference, attendee_name,
        attendee_email, attendee_phone, status, idempotency_key)
     VALUES ($1, $2, 'ref-verify-0000000000000022', 'Foreign', 'foreign@example.test', '+4', 'confirmed', 'idem-verify-0000000000000022') RETURNING id`,
    [eventB.id, tierB.id],
  );
  await expectRejected(
    client,
    "9f. Staff CheckIn for a Registration in ANOTHER event (token scope, §18/rule 05)",
    `INSERT INTO check_ins (registration_id, checked_in_at, staff_token_id) VALUES ($1, now(), $2)`,
    [regForeign.id, token.id],
  );
  await expectAccepted(
    client,
    "9g. CONTROL: the ORGANISER actor is not event-scoped, so that same row is accepted",
    `INSERT INTO check_ins (registration_id, checked_in_at, organiser_id) VALUES ($1, now(), $2)`,
    [regForeign.id, org.id],
  );
  // Removed so it cannot sit under event B when case 13 proves that an event with no
  // registrations cascades. Its own check-in was rolled back with the savepoint, so
  // nothing else references it.
  await client.query("DELETE FROM registrations WHERE id = $1", [regForeign.id]);

  const { rows: [regFresh] } = await client.query(
    `INSERT INTO registrations (event_id, ticket_type_id, unique_reference, attendee_name,
        attendee_email, attendee_phone, status, idempotency_key)
     VALUES ($1, $2, 'ref-verify-0000000000000023', 'Fresh', 'fresh@example.test', '+5', 'confirmed', 'idem-verify-0000000000000023') RETURNING id`,
    [eventA.id, tierA.id],
  );
  await expectRejected(
    client,
    "9h. CheckIn marked is_override = true with NO earlier check-in",
    `INSERT INTO check_ins (registration_id, checked_in_at, staff_token_id, is_override) VALUES ($1, now(), $2, true)`,
    [regFresh.id, token.id],
  );
  // Persisted (no savepoint) so 9j and 9k have a real history to act on. This is the
  // same trap the EventEditLog seed below documents: a row inserted through
  // expectAccepted is gone by the time the next case runs, and "one non-override row"
  // would then be trivially true for a registration that has none.
  await client.query(
    `INSERT INTO check_ins (registration_id, checked_in_at, staff_token_id) VALUES ($1, now(), $2)`,
    [regFresh.id, token.id],
  );
  await expectQuery(
    client,
    "9i. CONTROL: that first check-in is present and not an override",
    `SELECT count(*)::int AS n FROM check_ins WHERE registration_id = $1 AND is_override = false`,
    [regFresh.id],
    (r) => r.rows[0]?.n === 1,
  );
  await expectRejected(
    client,
    "9j. A SECOND non-override CheckIn for a Registration already checked in (§4.4.4/BR-4)",
    `INSERT INTO check_ins (registration_id, checked_in_at, staff_token_id) VALUES ($1, now(), $2)`,
    [regFresh.id, token.id],
  );
  await expectAccepted(
    client,
    "9k. CONTROL: the explicit override of that first check-in is accepted",
    `INSERT INTO check_ins (registration_id, checked_in_at, staff_token_id, is_override) VALUES ($1, now(), $2, true)`,
    [regFresh.id, token.id],
  );
  await expectQuery(
    client,
    "9l. CONTROL: the log still holds exactly one non-override row for that registration",
    `SELECT count(*)::int AS n FROM check_ins WHERE registration_id = $1 AND is_override = false`,
    [regFresh.id],
    (r) => r.rows[0]?.n === 1,
  );

  // --- 8. Cross-entity integrity + FK actions -----------------------------
  await expectRejected(
    client,
    "10. Registration whose event_id != its TicketType.event_id",
    `INSERT INTO registrations (event_id, ticket_type_id, unique_reference, attendee_name,
        attendee_email, attendee_phone, status, idempotency_key)
     VALUES ($1, $2, 'ref-verify-0000000000000010', 'X', 'x@example.test', '+1', 'pending_payment', 'idem-verify-0000000000000010')`,
    [eventA.id, tierB.id],
  );
  await expectRejected(
    client,
    "11. Registration with a non-existent event_id (FK)",
    `INSERT INTO registrations (event_id, ticket_type_id, unique_reference, attendee_name,
        attendee_email, attendee_phone, status, idempotency_key)
     VALUES ('00000000-0000-0000-0000-0000000000ff', $1, 'ref-verify-0000000000000011', 'X',
        'x@example.test', '+1', 'pending_payment', 'idem-verify-0000000000000011')`,
    [tierA.id],
  );
  await expectRejected(
    client,
    "12. DELETE organiser that still owns an Event (RESTRICT)",
    `DELETE FROM organisers WHERE id = $1`,
    [org.id],
  );
  await client.query(
    `INSERT INTO programme_items (event_id, sort_order, time, title) VALUES ($1, 1, now(), 'Doors')`,
    [eventB.id],
  );
  await expectAccepted(
    client,
    "13. CONTROL: DELETE event cascades to ProgrammeItem + TicketType + StaffToken",
    `DELETE FROM events WHERE id = $1`,
    [eventB.id],
  );
  await expectRejected(
    client,
    "14. DELETE event whose TicketType still has a Registration (RESTRICT)",
    `DELETE FROM events WHERE id = $1`,
    [eventA.id],
  );

  // --- 15. EventEditLog: append-only audit trail (PRD §14 L420, §20 L501) -----
  // A dedicated event, so the RESTRICT below is attributable to the audit row
  // alone rather than to a registration or a tier.
  const { rows: [eventLog] } = await client.query(
    `INSERT INTO events (organiser_id, name, slug, description, starts_at, ends_at, venue)
     VALUES ($1, 'Audit Log Event', 'verify-audit-log-event', 'For verification.',
             now(), now() + interval '2 hours', 'Hall')
     RETURNING id`,
    [org.id],
  );

  const logFks = await client.query(
    `SELECT conname, confdeltype FROM pg_constraint
      WHERE conrelid = 'event_edit_logs'::regclass AND contype = 'f' ORDER BY conname`,
  );
  record(
    "event_edit_logs carries 2 RESTRICT foreign keys",
    "query",
    logFks.rows.length === 2 && logFks.rows.every((r) => r.confdeltype === "r"),
    logFks.rows.map((r) => `${r.conname}=${r.confdeltype}`).join(", "),
  );

  await expectRejected(
    client,
    "15a. EventEditLog recording an EMPTY changes object",
    `INSERT INTO event_edit_logs (event_id, organiser_id, changes) VALUES ($1, $2, '{}'::jsonb)`,
    [eventLog.id, org.id],
  );
  await expectRejected(
    client,
    "15b. EventEditLog whose changes is not a JSON object",
    `INSERT INTO event_edit_logs (event_id, organiser_id, changes) VALUES ($1, $2, '"nope"'::jsonb)`,
    [eventLog.id, org.id],
  );
  await expectAccepted(
    client,
    "15c. CONTROL: a before/after changes object is accepted",
    `INSERT INTO event_edit_logs (event_id, organiser_id, changes)
     VALUES ($1, $2, '{"venue": {"from": "The Blue Room", "to": "Riverside Hall"}}'::jsonb)`,
    [eventLog.id, org.id],
  );

  // NOTE: every expect* helper ends with ROLLBACK TO SAVEPOINT, so a row inserted
  // through expectAccepted does NOT survive into the next check. The append-only
  // checks below need a row that is really there, so this seed uses a plain query
  // and persists until the fixture is rolled back at the end. (A data-modifying CTE
  // would not work: its sub-statements share one snapshot, so the UPDATE would not
  // see the row the seed had just inserted, and the trigger would never fire.)
  const { rows: [seededLog] } = await client.query(
    `INSERT INTO event_edit_logs (event_id, organiser_id, changes)
     VALUES ($1, $2, '{"venue": {"from": "The Blue Room", "to": "Riverside Hall"}}'::jsonb)
     RETURNING id`,
    [eventLog.id, org.id],
  );

  await expectRejected(
    client,
    "15d. UPDATE an existing EventEditLog row (append-only)",
    `UPDATE event_edit_logs SET changes = '{"venue": {"from": "X", "to": "Y"}}'::jsonb
      WHERE id = $1`,
    [seededLog.id],
  );
  await expectRejected(
    client,
    "15e. DELETE an existing EventEditLog row (append-only)",
    `DELETE FROM event_edit_logs WHERE id = $1`,
    [seededLog.id],
  );
  await expectRejected(
    client,
    "15f. DELETE the event that owns an audit row (RESTRICT — §14 soft delete only)",
    `DELETE FROM events WHERE id = $1`,
    [eventLog.id],
  );
  await expectQuery(
    client,
    "15g. CONTROL: the audit row is untouched after both rejected attempts",
    `SELECT changes FROM event_edit_logs WHERE id = $1`,
    [seededLog.id],
    (r) => r.rows[0]?.changes?.venue?.to === "Riverside Hall",
  );

  // --- 16. Event field limits (product-owner decision 4) --------------------
  // The application validates these too. AGENTS.md §5 is explicit that a rule
  // living only in application code is not the same guarantee, so each one is
  // proved to reject the bad write AND proved to accept the boundary value —
  // without the accept case, a CHECK written as `char_length(name) < 0` would
  // pass every reject case below.
  const insertEvent = (overrides) => `
    INSERT INTO events (organiser_id, name, slug, description, starts_at, ends_at, venue)
    VALUES ($1,
            ${overrides.name},
            ${overrides.slug},
            ${overrides.description},
            now(), now() + interval '2 hours',
            ${overrides.venue})`;

  await expectRejected(
    client,
    "16a. Event.name longer than 200 characters",
    insertEvent({ name: `'${"a".repeat(201)}'`, slug: "'limit-name-too-long'", description: "'d'", venue: "'v'" }),
    [org.id],
  );
  await expectAccepted(
    client,
    "16b. CONTROL: Event.name of exactly 200 characters is allowed",
    insertEvent({ name: `'${"a".repeat(200)}'`, slug: "'limit-name-exact'", description: "'d'", venue: "'v'" }),
    [org.id],
  );
  await expectRejected(
    client,
    "16c. Event.name that is only whitespace (btrim => length 0)",
    insertEvent({ name: "'   '", slug: "'limit-name-blank'", description: "'d'", venue: "'v'" }),
    [org.id],
  );
  await expectRejected(
    client,
    "16d. Event.venue longer than 300 characters",
    insertEvent({ name: "'V'", slug: "'limit-venue-too-long'", description: "'d'", venue: `'${"v".repeat(301)}'` }),
    [org.id],
  );
  await expectAccepted(
    client,
    "16e. CONTROL: Event.venue of exactly 300 characters is allowed",
    insertEvent({ name: "'V'", slug: "'limit-venue-exact'", description: "'d'", venue: `'${"v".repeat(300)}'` }),
    [org.id],
  );
  await expectAccepted(
    client,
    "16f. CONTROL: Event.description is NULL — decision 4 made it OPTIONAL",
    `INSERT INTO events (organiser_id, name, slug, description, starts_at, ends_at, venue)
     VALUES ($1, 'No Blurb', 'limit-description-null', NULL, now(), now() + interval '2 hours', 'v')`,
    [org.id],
  );
  await expectAccepted(
    client,
    "16g. CONTROL: Event.description of exactly 5000 characters is allowed",
    `INSERT INTO events (organiser_id, name, slug, description, starts_at, ends_at, venue)
     VALUES ($1, 'Max Blurb', 'limit-description-exact', $2, now(), now() + interval '2 hours', 'v')`,
    [org.id, "d".repeat(5000)],
  );
  await expectRejected(
    client,
    "16h. Event.description longer than 5000 characters",
    `INSERT INTO events (organiser_id, name, slug, description, starts_at, ends_at, venue)
     VALUES ($1, 'Over Blurb', 'limit-description-over', $2, now(), now() + interval '2 hours', 'v')`,
    [org.id, "d".repeat(5001)],
  );
  await expectAccepted(
    client,
    "16i. CONTROL: Event.slug of exactly 200 characters is allowed (decision 3)",
    `INSERT INTO events (organiser_id, name, slug, description, starts_at, ends_at, venue)
     VALUES ($1, 'Long Slug', $2, 'd', now(), now() + interval '2 hours', 'v')`,
    [org.id, "s".repeat(200)],
  );
  await expectRejected(
    client,
    "16j. Event.slug longer than 200 characters",
    `INSERT INTO events (organiser_id, name, slug, description, starts_at, ends_at, venue)
     VALUES ($1, 'Longer Slug', $2, 'd', now(), now() + interval '2 hours', 'v')`,
    [org.id, "s".repeat(201)],
  );
  await expectRejected(
    client,
    "16k. Event whose ends_at is NOT after starts_at",
    `INSERT INTO events (organiser_id, name, slug, description, starts_at, ends_at, venue)
     VALUES ($1, 'Backwards', 'limit-time-order', 'd', now() + interval '2 hours', now(), 'v')`,
    [org.id],
  );
  await expectRejected(
    client,
    "16l. Event whose ends_at EQUALS starts_at (zero-length)",
    `INSERT INTO events (organiser_id, name, slug, description, starts_at, ends_at, venue)
     VALUES ($1, 'Zero Length', 'limit-time-equal', 'd', now(), now(), 'v')`,
    [org.id],
  );
  await expectRejected(
    client,
    "16m. UPDATE an Event so ends_at precedes the stored starts_at",
    `UPDATE events SET ends_at = starts_at - interval '1 hour' WHERE id = $1`,
    [eventA.id],
  );
  await expectQuery(
    client,
    "16n. CONTROL: the event is untouched after the rejected time-order UPDATE",
    `SELECT (ends_at > starts_at) AS ordered FROM events WHERE id = $1`,
    [eventA.id],
    (r) => r.rows[0]?.ordered === true,
  );

  // --- 17. OrganiserSession: the auth decision's store ----------------------
  const sessionFks = await client.query(
    `SELECT conname, confdeltype FROM pg_constraint
      WHERE conrelid = 'organiser_sessions'::regclass AND contype = 'f'`,
  );
  record(
    "organiser_sessions cascades on organiser DELETE (ephemeral state, not evidence)",
    "query",
    sessionFks.rows.length === 1 && sessionFks.rows[0].confdeltype === "c",
    sessionFks.rows.map((r) => `${r.conname}=${r.confdeltype}`).join(", "),
  );

  await expectAccepted(
    client,
    "17a. CONTROL: a session expiring in the future is accepted",
    `INSERT INTO organiser_sessions (organiser_id, token_hash, expires_at)
     VALUES ($1, 'hash-verify-0000000000000010', now() + interval '7 days')`,
    [org.id],
  );
  await expectRejected(
    client,
    "17b. Session whose expires_at is in the past",
    `INSERT INTO organiser_sessions (organiser_id, token_hash, expires_at)
     VALUES ($1, 'hash-verify-0000000000000011', now() - interval '1 day')`,
    [org.id],
  );
  await expectRejected(
    client,
    "17c. Session whose expires_at equals created_at (zero lifetime)",
    `INSERT INTO organiser_sessions (organiser_id, token_hash, expires_at, created_at)
     VALUES ($1, 'hash-verify-0000000000000012', now(), now())`,
    [org.id],
  );
  await expectRejected(
    client,
    "17d. Session for a non-existent organiser (FK)",
    `INSERT INTO organiser_sessions (organiser_id, token_hash, expires_at)
     VALUES ('00000000-0000-0000-0000-0000000000fe', 'hash-verify-0000000000000013', now() + interval '1 day')`,
  );

  // --- 18. TicketType field limits (product-owner decision 5) ----------------
  // The application validates all of these too, and for the same reason as the
  // event limits in section 16: AGENTS.md §5 treats a rule that lives only in
  // application code as a gap. Each is proved to REJECT the bad write and — just as
  // importantly — proved to ACCEPT the boundary value, because a CHECK written
  // wrongly (say `char_length(name) < 0`) would pass every reject case below.
  //
  // `overrides` values are SQL fragments, not bound parameters, so a name can be
  // an expression (`repeat('a', 201)`) and stay readable in the log.
  const insertTier = (o) => `
    INSERT INTO ticket_types (event_id, name, description, price_minor_units, currency, quantity_total)
    VALUES ($1,
            ${o.name},
            ${o.description ?? "NULL"},
            ${o.price ?? "100"},
            ${o.currency ?? "'NGN'"},
            ${o.quantity ?? "10"})`;

  await expectRejected(
    client,
    "18a. TicketType.name longer than 200 characters",
    insertTier({ name: `'${"a".repeat(201)}'` }),
    [eventA.id],
  );
  await expectAccepted(
    client,
    "18b. CONTROL: TicketType.name of exactly 200 characters is allowed",
    insertTier({ name: `'${"a".repeat(200)}'` }),
    [eventA.id],
  );
  await expectRejected(
    client,
    "18c. TicketType.name that is only whitespace (btrim => length 0)",
    insertTier({ name: "'   '" }),
    [eventA.id],
  );
  await expectRejected(
    client,
    "18d. TicketType with a NEGATIVE price_minor_units",
    insertTier({ name: "'Negative'", price: "-1" }),
    [eventA.id],
  );
  await expectAccepted(
    client,
    "18e. CONTROL: a zero-price (free) tier is allowed — the floor is 0, not 1",
    insertTier({ name: "'Free'", price: "0" }),
    [eventA.id],
  );
  await expectRejected(
    client,
    "18f. TicketType.currency of only two letters (fits VARCHAR(3), wrong shape)",
    insertTier({ name: "'Short Currency'", currency: "'NG'" }),
    [eventA.id],
  );
  await expectRejected(
    client,
    "18g. TicketType.currency in lower case",
    insertTier({ name: "'Lower Currency'", currency: "'ngn'" }),
    [eventA.id],
  );
  await expectRejected(
    client,
    "18h. TicketType.currency containing a digit",
    insertTier({ name: "'Digit Currency'", currency: "'N1N'" }),
    [eventA.id],
  );
  await expectAccepted(
    client,
    "18i. CONTROL: an upper-case three-letter currency is allowed",
    insertTier({ name: "'Good Currency'", currency: "'GBP'" }),
    [eventA.id],
  );
  await expectRejected(
    client,
    "18j. TicketType with quantity_total of 0 (satisfies the sum CHECK, unsellable)",
    insertTier({ name: "'Zero Capacity'", quantity: "0" }),
    [eventA.id],
  );
  await expectRejected(
    client,
    "18k. TicketType with a NEGATIVE quantity_total",
    insertTier({ name: "'Negative Capacity'", quantity: "-5" }),
    [eventA.id],
  );
  await expectAccepted(
    client,
    "18l. CONTROL: quantity_total of exactly 1 is allowed",
    insertTier({ name: "'One Unit'", quantity: "1" }),
    [eventA.id],
  );
  await expectRejected(
    client,
    "18m. TicketType.description longer than 5000 characters",
    insertTier({ name: "'Over Blurb'", description: `$2` }),
    [eventA.id, "d".repeat(5001)],
  );
  await expectAccepted(
    client,
    "18n. CONTROL: TicketType.description of exactly 5000 characters is allowed",
    insertTier({ name: "'Max Blurb'", description: `$2` }),
    [eventA.id, "d".repeat(5000)],
  );
  await expectAccepted(
    client,
    "18o. CONTROL: TicketType.description is NULL — it is optional",
    insertTier({ name: "'No Blurb'" }),
    [eventA.id],
  );

  // --- 19. quantity_total edits are judged by the CHECK, not by the application
  // (skill step 9). A dedicated tier, persisted without a savepoint so both the
  // rejected and the accepted UPDATE have a real row to act on.
  const { rows: [stockedTier] } = await client.query(
    `INSERT INTO ticket_types (event_id, name, price_minor_units, currency, quantity_total,
        quantity_confirmed, quantity_held)
     VALUES ($1, 'Committed', 100, 'NGN', 10, 6, 3) RETURNING id`,
    [eventA.id],
  );
  await expectRejected(
    client,
    "19a. UPDATE quantity_total to 5, below the 9 units already committed (confirmed + held)",
    `UPDATE ticket_types SET quantity_total = 5 WHERE id = $1`,
    [stockedTier.id],
  );
  await expectAccepted(
    client,
    "19b. CONTROL: UPDATE quantity_total to 9, exactly the committed total, is allowed",
    `UPDATE ticket_types SET quantity_total = 9 WHERE id = $1`,
    [stockedTier.id],
  );
  await expectQuery(
    client,
    "19c. CONTROL: quantity_total is still 10 after the rejected reduction",
    `SELECT quantity_total FROM ticket_types WHERE id = $1`,
    [stockedTier.id],
    (r) => r.rows[0]?.quantity_total === 10,
  );
  await expectRejected(
    client,
    "19d. UPDATE a tier so quantity_confirmed alone exceeds quantity_total",
    `UPDATE ticket_types SET quantity_confirmed = quantity_total + 1 WHERE id = $1`,
    [tierA.id],
  );
  await expectQuery(
    client,
    "19e. CONTROL: tierA counters are untouched after the rejected oversell",
    `SELECT quantity_confirmed, quantity_held, quantity_total FROM ticket_types WHERE id = $1`,
    [tierA.id],
    (r) =>
      r.rows[0]?.quantity_confirmed === 0 &&
      r.rows[0]?.quantity_held === 0 &&
      r.rows[0]?.quantity_total === 10,
  );

  // --- 20. The two-counter invariant also holds through a hold/release cycle ---
  // The arithmetic the §9.3 transitions rely on, proved against the database rather
  // than asserted in a comment: available drops by exactly the held amount, and a
  // release restores it. None of this is a race test — the last-unit race needs two
  // concurrent connections and lives in `tests/ticket-types.db.test.ts`.
  // Two distinct kinds of refusal, and conflating them would hide a real bug:
  //
  //   - A GUARDED conditional update whose condition fails matches zero rows. That
  //     is not an error, it is a no-op, and the adapter detects it from an empty
  //     `RETURNING`. Cases 20b-20d therefore assert the row is UNCHANGED, not that
  //     the database raised.
  //   - The CHECK constraint is the BACKSTOP beneath the guard. It turns an
  //     unguarded oversell into a hard error, which is what stops a second writer —
  //     a seed script, a future admin tool, a hand-written UPDATE — from creating the
  //     invalid state the guard exists to prevent. Cases 20f-20g are that case.
  await expectQuery(
    client,
    "20a. Holding the LAST unit of stockedTier (1 of 1 remaining) leaves available = 0",
    `UPDATE ticket_types
        SET quantity_held = quantity_held + 1, updated_at = now()
      WHERE id = $1
        AND quantity_confirmed + quantity_held + 1 <= quantity_total
      RETURNING quantity_total - quantity_confirmed - quantity_held AS available`,
    [stockedTier.id],
    (r) => r.rows[0]?.available === 0,
  );
  await expectQuery(
    client,
    "20b. GUARDED: holding 11 of a 10-unit tier matches zero rows (no error, no write)",
    `UPDATE ticket_types
        SET quantity_held = quantity_held + 11
      WHERE id = $1
        AND quantity_confirmed + quantity_held + 11 <= quantity_total
      RETURNING id`,
    [tierA.id],
    (r) => r.rowCount === 0,
  );
  await expectQuery(
    client,
    "20c. GUARDED: releasing more than is held matches zero rows rather than clamping",
    `UPDATE ticket_types
        SET quantity_held = quantity_held - 99
      WHERE id = $1
        AND quantity_held >= 99
      RETURNING id`,
    [stockedTier.id],
    (r) => r.rowCount === 0,
  );
  await expectQuery(
    client,
    "20d. GUARDED: confirming more than is held matches zero rows (the §8.5 pair)",
    `UPDATE ticket_types
        SET quantity_confirmed = quantity_confirmed + 10, quantity_held = quantity_held - 10
      WHERE id = $1
        AND quantity_held >= 10
      RETURNING id`,
    [stockedTier.id],
    (r) => r.rowCount === 0,
  );
  await expectQuery(
    client,
    "20e. CONTROL: stockedTier still holds exactly 3 after all four guarded attempts",
    `SELECT quantity_held FROM ticket_types WHERE id = $1`,
    [stockedTier.id],
    (r) => r.rows[0]?.quantity_held === 3,
  );

  // The CHECK beneath the guard: these are UNGUARDED, so each must be a hard
  // rejection. This is the "proven by the CHECK constraint rejecting the losing
  // write" evidence PRD §10 asks for — the constraint, not application code, is
  // what makes an invalid counter combination unstorable.
  await expectRejected(
    client,
    "20f. UNGUARDED oversell: held 11 of a 10-unit tier is rejected by the CHECK",
    `UPDATE ticket_types SET quantity_held = quantity_held + 11 WHERE id = $1`,
    [tierA.id],
  );
  await expectRejected(
    client,
    "20g. UNGUARDED: driving quantity_held negative is rejected by the CHECK",
    `UPDATE ticket_types SET quantity_held = quantity_held - 99 WHERE id = $1`,
    [stockedTier.id],
  );
  await expectQuery(
    client,
    "20h. CONTROL: neither unguarded write landed — counters are exactly as seeded",
    `SELECT quantity_confirmed, quantity_held, quantity_total FROM ticket_types WHERE id = $1`,
    [stockedTier.id],
    (r) =>
      r.rows[0]?.quantity_confirmed === 6 &&
      r.rows[0]?.quantity_held === 3 &&
      r.rows[0]?.quantity_total === 10,
  );

  // --- 21. AttendeeRequest lifecycle (PRD §5.8, §7.2, §14; FR-23a, FR-24) ----
  //
  // The service already refuses all of these with a 4xx, so the interesting question is
  // not "does the API reject it" but "does the *database* reject it". AGENTS.md §17:
  // a passing build does not prove the constraint rejects the invalid write. A guard
  // that lives only in a service is a guard the next write path forgets, and the
  // `requests.db.test.ts` cases prove the same rules through Prisma; these run as raw SQL
  // so they also cover any future path that writes the table directly.
  const { rows: [requestA] } = await client.query(
    `INSERT INTO attendee_requests (registration_id, message, status, idempotency_key)
     VALUES ($1, 'Can I transfer my ticket?', 'open', $2) RETURNING id`,
    [regA.id, "idem-verify-request-0000001"],
  );

  // A registration on the *other* event, so "moved to another attendee's queue" is a
  // real move rather than a no-op. Selecting `LIMIT 1` would have returned regA itself,
  // and an UPDATE that changes nothing is exactly what the immutability guard permits.
  const { rows: [regB] } = await client.query(
    `INSERT INTO registrations (event_id, ticket_type_id, unique_reference, attendee_name,
        attendee_email, attendee_phone, status, idempotency_key)
     VALUES ($1, $2, $3, 'Grace', 'grace@example.test', '+234000000001', 'confirmed', $4) RETURNING id`,
    [eventB.id, tierB.id, "ref-verify-0000000000000002", "idem-verify-0000000000000002"],
  );

  // An already-resolved request, seeded here rather than by an earlier case.
  //
  // Every case above runs between a SAVEPOINT and a ROLLBACK TO SAVEPOINT, so an
  // `expectAccepted` case leaves *no* trace for the cases after it. Building the
  // resolved state inside a case and then asserting on it in the next would therefore
  // test a row that is open again. The resolved state has to be fixture.
  const { rows: [requestC] } = await client.query(
    `INSERT INTO attendee_requests (registration_id, message, status, resolution_notes,
        idempotency_key, resolved_at)
     VALUES ($1, 'Already answered', 'resolved', 'Refunded on Tuesday.', $2, now()) RETURNING id`,
    [regA.id, "idem-verify-request-0000006"],
  );

  // (1) Status/timestamp agreement, both directions.
  await expectRejected(
    client,
    "21a. AttendeeRequest resolved with NO resolved_at (a resolution with no instant)",
    `INSERT INTO attendee_requests (registration_id, message, status, idempotency_key)
     VALUES ($1, 'Resolved but undated', 'resolved', $2)`,
    [regA.id, "idem-verify-request-0000002"],
  );
  await expectRejected(
    client,
    "21b. AttendeeRequest open WITH a resolved_at (a resolution that never happened)",
    `INSERT INTO attendee_requests (registration_id, message, status, idempotency_key, resolved_at)
     VALUES ($1, 'Open but dated', 'open', $2, now())`,
    [regA.id, "idem-verify-request-0000003"],
  );
  await expectAccepted(
    client,
    "21c. CONTROL: open with no resolved_at is allowed",
    `INSERT INTO attendee_requests (registration_id, message, status, idempotency_key)
     VALUES ($1, 'Plain open request', 'open', $2)`,
    [regA.id, "idem-verify-request-0000004"],
  );
  await expectAccepted(
    client,
    "21d. CONTROL: resolved WITH resolved_at is allowed (the seeded request's own shape)",
    `INSERT INTO attendee_requests (registration_id, message, status, resolution_notes,
        idempotency_key, resolved_at)
     VALUES ($1, 'Resolved and dated', 'resolved', 'Answered.', $2, now())`,
    [regA.id, "idem-verify-request-0000007"],
  );

  // (2) What the attendee wrote is immutable.
  await expectRejected(
    client,
    "21e. rewriting the idempotency_key (would hand one request another identity)",
    `UPDATE attendee_requests SET idempotency_key = 'idem-verify-swapped-00000001' WHERE id = $1`,
    [requestA.id],
  );
  await expectRejected(
    client,
    "21f. rewriting the attendee's message",
    `UPDATE attendee_requests SET message = 'Something else entirely' WHERE id = $1`,
    [requestA.id],
  );
  await expectRejected(
    client,
    "21g. moving a request to a registration of another event",
    `UPDATE attendee_requests SET registration_id = $2 WHERE id = $1`,
    [requestA.id, regB.id],
  );
  await expectRejected(
    client,
    "21h. backdating created_at (would reorder the queue and misreport response time)",
    `UPDATE attendee_requests SET created_at = created_at - interval '1 year' WHERE id = $1`,
    [requestA.id],
  );

  // (3) `resolved` is terminal, and the status/timestamp CHECK is not a way around it.
  await expectRejected(
    client,
    "21i. an UPDATE that sets resolved without resolved_at is caught by the CHECK",
    `UPDATE attendee_requests SET status = 'resolved' WHERE id = $1`,
    [requestA.id],
  );
  await expectAccepted(
    client,
    "21j. CONTROL: the forward open -> resolved transition is allowed",
    `UPDATE attendee_requests
        SET status = 'resolved', resolution_notes = 'Refunded on Tuesday.', resolved_at = now()
      WHERE id = $1`,
    [requestA.id],
  );
  await expectRejected(
    client,
    "21k. reopening a resolved request",
    `UPDATE attendee_requests SET status = 'open', resolved_at = NULL WHERE id = $1`,
    [requestC.id],
  );
  await expectRejected(
    client,
    "21l. rewriting the resolution notes of a resolved request",
    `UPDATE attendee_requests SET resolution_notes = 'Actually, we cannot.' WHERE id = $1`,
    [requestC.id],
  );
  await expectRejected(
    client,
    "21m. moving a resolved request's timestamp",
    `UPDATE attendee_requests SET resolved_at = resolved_at + interval '1 day' WHERE id = $1`,
    [requestC.id],
  );
  await expectAccepted(
    client,
    "21n. CONTROL: a no-op write to a resolved request is allowed (idempotent redelivery)",
    `UPDATE attendee_requests SET resolution_notes = resolution_notes WHERE id = $1`,
    [requestC.id],
  );

  // (4) A response is not a resolution, so a notes-only write must stay legal.
  await expectAccepted(
    client,
    "21o. CONTROL: a notes-only response on an OPEN request is allowed and does not resolve it",
    `UPDATE attendee_requests SET resolution_notes = 'We are looking into it.' WHERE id = $1`,
    [requestA.id],
  );
  await expectQuery(
    client,
    "21p. CONTROL: that response left the request open with no resolved_at",
    `SELECT status, resolved_at FROM attendee_requests WHERE id = $1`,
    [requestA.id],
    (r) => r.rows[0]?.status === "open" && r.rows[0]?.resolved_at === null,
  );

  // (5) Retention.
  await expectRejected(
    client,
    "21q. deleting a resolved request",
    `DELETE FROM attendee_requests WHERE id = $1`,
    [requestC.id],
  );
  await expectQuery(
    client,
    "21r. CONTROL: the refused DELETE left the row and its resolution standing",
    `SELECT status, resolution_notes FROM attendee_requests WHERE id = $1`,
    [requestC.id],
    (r) => r.rows[0]?.status === "resolved" && r.rows[0]?.resolution_notes === "Refunded on Tuesday.",
  );

  // (6) The one rule the service relies on the database for, exercised the way the
  // application's own conditional UPDATE relies on it: the same statement, with a
  // precondition that a resolved row does not satisfy, must match nothing.
  await expectQuery(
    client,
    "21s. CONTROL: the guarded UPDATE's WHERE matches nothing once the request is resolved",
    `UPDATE attendee_requests
        SET resolution_notes = 'A second answer.'
      WHERE id = $1 AND status = 'open'`,
    [requestC.id],
    (r) => r.rowCount === 0,
  );
  await expectQuery(
    client,
    "21t. CONTROL: and the winner's text is still the one stored",
    `SELECT resolution_notes FROM attendee_requests WHERE id = $1`,
    [requestC.id],
    (r) => r.rows[0]?.resolution_notes === "Refunded on Tuesday.",
  );

  // --- No residue ----------------------------------------------------------
  await client.query("ROLLBACK");
  // Every table the fixture above can write to, so a fixture that leaked through a
  // savepoint is caught rather than reported clean.
  const residue = await client.query(
    `SELECT count(*)::int AS n FROM registrations
      UNION ALL SELECT count(*)::int FROM payments
      UNION ALL SELECT count(*)::int FROM check_ins
      UNION ALL SELECT count(*)::int FROM staff_tokens
      UNION ALL SELECT count(*)::int FROM attendee_requests
      UNION ALL SELECT count(*)::int FROM event_edit_logs
      UNION ALL SELECT count(*)::int FROM programme_items
      UNION ALL SELECT count(*)::int FROM ticket_types
      UNION ALL SELECT count(*)::int FROM events
      UNION ALL SELECT count(*)::int FROM organiser_sessions
      UNION ALL SELECT count(*)::int FROM organisers`,
  );
  const total = residue.rows.reduce((sum, r) => sum + r.n, 0);
  record("No rows left behind (fixture rolled back)", "query", total === 0, `${total} rows remaining`);

  await client.end();

  // --- Report --------------------------------------------------------------
  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed += 1;
    console.log(`${r.ok ? "PASS" : "FAIL"}  [${r.expectation}] ${r.label}\n        ${r.detail}\n`);
  }
  console.log(`\n${results.length - failed}/${results.length} checks passed.`);
  if (failed > 0) {
    console.error(`${failed} check(s) FAILED.`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("verification aborted:", error.message);
  process.exit(1);
});

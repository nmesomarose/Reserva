#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadDatabaseUrl() {
  const raw = readFileSync(path.join(webRoot, ".env"), "utf8");
  const match = raw.match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m);
  if (!match) throw new Error("DATABASE_URL not found in web/.env");
  return match[1].trim();
}

const EVENT_ID = "00000000-0000-0000-0000-000000000001";

const queries = [
  {
    title: "Query 1 - Event-day staff search (PRD 17)",
    sql: `SELECT r.id
FROM registrations r
WHERE r.event_id = $1::uuid
  AND (r.attendee_name ILIKE '%ada%' ESCAPE '\\'
    OR r.attendee_email ILIKE '%ada%' ESCAPE '\\'
    OR r.attendee_phone ILIKE '%ada%' ESCAPE '\\')`,
  },
  {
    title: "Query 2 - Dashboard registrations-by-status (PRD 17 / FR-25)",
    sql: `SELECT r.status, count(*)::bigint AS "count"
FROM registrations r
WHERE r.event_id = $1::uuid
GROUP BY r.status`,
  },
];

const client = new Client({ connectionString: loadDatabaseUrl() });
await client.connect();
console.log(`Connected: ${client.database}@${client.host}:${client.port}\n`);
console.log("enable_seqscan = off\n");

await client.query("SET enable_seqscan = off");

for (const { title, sql } of queries) {
  console.log(`### ${title}\n`);
  console.log(sql + "\n");
  const res = await client.query(`EXPLAIN ${sql}`, [EVENT_ID]);
  console.log(res.rows.map((r) => r["QUERY PLAN"]).join("\n"));
  console.log("\n" + "=".repeat(70) + "\n");
}

await client.end();

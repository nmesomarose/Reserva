/**
 * Create or update an organiser account.
 *
 * WHY A CLI AND NOT A `POST /api/v1/auth/register` ENDPOINT
 *
 * The auth decision (2026-09-26) chose email + password authentication and
 * explicitly did not choose a registration flow — it was not in scope, and an
 * unauthenticated "create an account" endpoint is a security surface of its own
 * (who may sign up, is email verified, is there a rate limit, does it send mail).
 * Inventing one would be deciding an undecided question silently.
 *
 * But a login endpoint with no way to have an account is not a working feature,
 * so accounts are provisioned out of band, the same way a database is seeded.
 * This is a deliberate boundary, not an omission: the *mechanism* is a decision,
 * the *onboarding* is not yet one.
 *
 * The password is read from stdin, never from `argv`, so it does not land in the
 * shell history or in the process list. The hash is produced by importing
 * `src/server/auth/password.ts` — the SAME module the application verifies
 * against — because a second copy of the hash format would drift and leave
 * accounts that cannot log in.
 *
 * Run with:  npm run db:create-organiser -- you@example.com
 * (Node 22.6+ strips the TypeScript types natively; no loader or extra dependency.)
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { stdin, stdout } from "node:process";
import pg from "pg";

import { hashPassword } from "../src/server/auth/password.ts";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadDatabaseUrl() {
  const raw = readFileSync(path.join(webRoot, ".env"), "utf8");
  const match = raw.match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m);
  if (!match) throw new Error("DATABASE_URL not found in web/.env");
  return match[1].trim();
}

/**
 * Read one line from stdin without echoing it.
 *
 * `setRawMode` is how the password is kept off the terminal; on a non-TTY (a CI
 * invocation, a piped password) there is no echo to suppress and the line is read
 * plainly, which is what makes the script usable from a test or a seed pipeline.
 */
async function readHidden(prompt: string): Promise<string> {
  if (!stdin.isTTY) {
    return new Promise<string>((resolve, reject) => {
      let data = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (chunk: string) => {
        data += chunk;
      });
      stdin.on("end", () => resolve(data.split("\n")[0].replace(/\r$/, "")));
      stdin.on("error", reject);
    });
  }

  stdout.write(prompt);
  return new Promise<string>((resolve, reject) => {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    stdin.on("data", (chunk: string) => {
      for (const character of chunk) {
        switch (character) {
          case "\n":
          case "\r":
          case "\u0004": // Ctrl-D
            stdin.setRawMode(false);
            stdin.pause();
            stdout.write("\n");
            resolve(value);
            return;
          case "\u0003": // Ctrl-C
            // Abort without writing anything: a half-entered password must not
            // reach the database.
            stdin.setRawMode(false);
            stdout.write("\n");
            process.exit(130);
            break;
          case "\u007f": // Backspace
            value = value.slice(0, -1);
            break;
          default:
            value += character;
        }
      }
    });
    stdin.on("error", reject);
  });
}

function usage(message: string): never {
  console.error(`error: ${message}\n`);
  console.error("Usage: npm run db:create-organiser -- <email>");
  process.exit(1);
}

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();

  if (!email) {
    usage("an email address is required");
  }

  // Deliberately permissive: RFC 5321 caps an address at 320 characters, and the
  // database has no format CHECK on `organisers.email` because the PRD does not
  // specify one. Validating the shape here would invent a rule the schema does not
  // enforce, so the only questions asked are the ones the schema asks.
  if (email.length > 320) {
    usage("email must be at most 320 characters");
  }

  const password = await readHidden("Password: ");
  const confirmation = await readHidden("Confirm password: ");

  if (password.length === 0) {
    usage("password cannot be empty");
  }

  if (password !== confirmation) {
    usage("the two passwords did not match");
  }

  const passwordHash = await hashPassword(password);

  const { Client } = pg;
  const client = new Client({ connectionString: loadDatabaseUrl() });
  await client.connect();

  try {
    // Upsert rather than insert-or-fail: re-running the command to reset a
    // forgotten password is the operation people actually need, and an insert
    // that dies on the unique index would not do it.
    //
    // `password_hash` only. `auth_provider_id` is left alone — decision 1 chose
    // the password credential, but the column is in §7.2 and clearing it would
    // destroy information this script does not own.
    const { rows } = await client.query(
      `INSERT INTO organisers (email, password_hash)
       VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
       RETURNING id, email`,
      [email, passwordHash],
    );

    console.log(`\nOrganiser ready: ${rows[0].email}`);
    console.log(`  id: ${rows[0].id}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("failed:", error.message);
  process.exit(1);
});

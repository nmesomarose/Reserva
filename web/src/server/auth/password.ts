/**
 * Organiser password hashing (product-owner decision 1, 2026-09-26).
 *
 * ALGORITHM: scrypt from `node:crypto`, with the cost parameters baked into
 * every stored hash. Node's `crypto.scryptSync` needs no dependency, and
 * `AGENTS.md §4` requires justifying a new library before adding one — there is
 * no argument for pulling in bcrypt/argon2 here, because the runtime already
 * ships a memory-hard KDF.
 *
 * WHY scrypt AND NOT SHA-256: a password hash must be *slow* and *memory-hard*.
 * A fast digest of a password is a fast offline-cracking target, and a leaked
 * `organisers` table is exactly the scenario the column exists for. The salt and
 * the cost parameters travel with the hash, so raising the cost later does not
 * invalidate existing rows: a verifier reads the parameters from the stored
 * string and an old hash keeps verifying under its own, cheaper settings until
 * the next successful login re-hashes it.
 *
 * Stored format, one string, self-describing:
 *
 *     scrypt$16384$8$1$<salt base64>$<derived key base64>
 *
 * Plaintext passwords are never stored, logged, or included in any error
 * message (AGENTS.md §14). Nothing in this module throws a message containing
 * either the input or the stored hash.
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

/**
 * NO `import "server-only"` HERE, unlike every other module under
 * `src/server/auth`.
 *
 * That guard exists to keep framework-coupled server code out of a client
 * bundle. This file has no framework coupling at all — it is `node:crypto` and
 * string formatting — so the guard would buy nothing, while costing the ability
 * to import it from `scripts/create-organiser.mts`, a plain Node script.
 *
 * That import is the point: account provisioning would otherwise have to
 * re-implement the hash format in a second place, and the two would drift
 * silently, leaving accounts that no login can ever verify. One implementation,
 * used by the app, the tests, and the CLI.
 *
 * Nothing sensitive leaves this module — it returns and accepts hashes and
 * booleans — so its absence from a client bundle would not be a leak.
 */

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Cost parameters for newly created hashes.
 *
 * N=2^14 with r=8 needs ~16 MiB per hash (128 * N * r). `maxmem` is raised
 * above Node's 32 MiB default so a future parameter bump fails loudly at the
 * memory limit rather than silently producing a weaker hash.
 */
const N = 16_384;
const R = 8;
const P = 1;
const MAXMEM = 64 * 1024 * 1024;

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

const ALGORITHM = "scrypt";

/**
 * What `verifyPassword` returns when the stored value cannot be verified.
 *
 * Indistinguishable from "wrong password" on purpose: a `false` here covers a
 * null hash, a malformed hash, and a hash made with parameters this build cannot
 * reproduce. Collapsing all three means a caller cannot use the login endpoint
 * to fingerprint which accounts exist or how their hashes are formatted.
 */
const NOT_VERIFIED = false;

/** Hash a plaintext password for storage in `organisers.password_hash`. */
export async function hashPassword(plaintext: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(plaintext, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAXMEM });

  return [
    ALGORITHM,
    N,
    R,
    P,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

interface ParsedHash {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly derived: Buffer;
}

/**
 * Split a stored hash, or return `null` if it is not one this build can check.
 *
 * Returns `null` rather than throwing: a row with an unparseable hash is a
 * failed login, not a server fault, and must not become a `500` that tells a
 * caller their password is the problem.
 */
function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split("$");

  if (parts.length !== 6 || parts[0] !== ALGORITHM) {
    return null;
  }

  const [, rawN, rawR, rawP, rawSalt, rawDerived] = parts;
  const n = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);

  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return null;
  }

  // Reject absurd parameters before allocating: a tampered row asking for
  // N=2^30 would otherwise become a memory-exhaustion vector driven by database
  // content rather than by anything the caller controls.
  if (n < 2 || n > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) {
    return null;
  }

  let salt: Buffer;
  let derived: Buffer;

  try {
    salt = Buffer.from(rawSalt, "base64");
    derived = Buffer.from(rawDerived, "base64");
  } catch {
    return null;
  }

  if (salt.length === 0 || derived.length === 0) {
    return null;
  }

  return { N: n, r, p, salt, derived };
}

/**
 * Check a plaintext password against a stored hash.
 *
 * `false` — never an exception, never a hint — for a null/empty stored value, an
 * unparseable one, a wrong password, or an unsupported parameter set. A caller
 * that needs to distinguish "no password set on this account" must ask the
 * repository, not infer it from here.
 */
export async function verifyPassword(
  plaintext: string,
  stored: string | null | undefined,
): Promise<boolean> {
  if (typeof stored !== "string" || stored === "") {
    return NOT_VERIFIED;
  }

  const parsed = parseHash(stored);

  if (parsed === null) {
    return NOT_VERIFIED;
  }

  const maxmem = 128 * parsed.N * parsed.r * 2;

  let candidate: Buffer;

  try {
    candidate = await scrypt(plaintext, parsed.salt, parsed.derived.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: Math.max(MAXMEM, maxmem),
    });
  } catch {
    // Out of memory or an unusable parameter set: still just a failed login.
    return NOT_VERIFIED;
  }

  // `timingSafeEqual` throws on a length mismatch, so the lengths are compared
  // first. The derived key's length is fixed by the hash, not by the input, so
  // this cannot leak anything about the password.
  if (candidate.length !== parsed.derived.length) {
    return NOT_VERIFIED;
  }

  return timingSafeEqual(candidate, parsed.derived);
}

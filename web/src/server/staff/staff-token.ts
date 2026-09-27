/**
 * Staff-token secret primitives (product-owner decision 2, 2026-09-27).
 *
 * This is the server-only half of the {@link StaffTokenIssuer} port, and the only
 * place in the codebase that touches `node:crypto` for staff access.
 *
 * WHY THE TRANSPORT IS A BEARER HEADER, and not a cookie — the one thing PRD §19
 * and AGENTS.md §21.5 left open as `[VERIFY / decide at implementation time]`:
 *
 *   - **Ambient vs. presented.** A cookie is sent by the browser whether or not the
 *     application asks for it. Staff tokens are used on shared door devices, and a
 *     cookie is also how the organiser session is presented; on a device used for
 *     both, an ambient staff token would ride along to organiser-scoped routes. A
 *     bearer header is only ever sent where a client deliberately puts it.
 *   - **No ambient CSRF exposure.** A cookie on a state-changing endpoint forces
 *     SameSite/Origin reasoning. A header the browser will not add cross-site is
 *     already inert against CSRF, which matters for a `POST` that checks people in.
 *   - **It is what "event-scoped token, not an account" means.** There is no staff
 *     identity in the database to bind a session to (PRD §3, §7.1), so a cookie
 *     session would have to be invented around a row that is really a capability.
 *
 * What is *not* a choice: the stored form. Only a SHA-256 hash is persisted
 * (`staff_tokens.token_hash`, `UNIQUE`), so a database read does not hand over live
 * door access (AGENTS.md §14). SHA-256 rather than a slow KDF, unlike a password —
 * the input is 32 bytes of CSPRNG output, so there is nothing to brute-force. This
 * is the same argument the organiser session token makes, and it is why the two are
 * built identically rather than differently.
 */

import "server-only";

import { createHash, randomBytes } from "node:crypto";

import type { StaffTokenIssuer, StaffTokenSecret } from "@/domain/staff/staff";

/** Bytes of entropy in a staff token. 32 is the session token's choice too. */
const STAFF_TOKEN_BYTES = 32;

export function hashStaffToken(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export class NodeStaffTokenIssuer implements StaffTokenIssuer {
  issue(): StaffTokenSecret {
    const token = randomBytes(STAFF_TOKEN_BYTES).toString("base64url");

    // Hashing happens here rather than at the call site so the two can never be
    // separated: a plaintext that reached the repository would be a stored secret,
    // and the port's contract ("the plaintext is never persisted") is only
    // enforceable if they are minted together.
    return { token, tokenHash: hashStaffToken(token) };
  }

  hash(secret: string): string {
    return hashStaffToken(secret);
  }
}

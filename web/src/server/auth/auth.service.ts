/**
 * Organiser authentication (product-owner decision 1, 2026-09-26).
 *
 * DECISION: email + password, a server-side session, and an httpOnly
 * `SameSite=Lax` cookie. Explicitly NOT implemented, because the decision
 * excluded them: JWTs, OAuth, SSO, magic links, refresh tokens, password reset,
 * and registration. PRD v2 §3 L47 and §19 L482 defer the mechanism and mark it
 * `[VERIFY / decide at implementation time]`; this is that decision, and the
 * reasoning is recorded where the source documents point.
 *
 * WHAT "SERVER-SIDE SESSION" BUYS, and why it shaped the rest of the design:
 *
 *   - The cookie is an opaque 256-bit random string with no claims in it. There
 *     is nothing in the client's possession to tamper with, so no signature
 *     scheme, expiry claim, or algorithm-confusion defence is needed.
 *   - Revocation is immediate: deleting the row ends the session. A self-contained
 *     token stays valid until it expires no matter what the server thinks, which
 *     is the trade-off a JWT makes in exchange for stateless reads.
 *   - Only a SHA-256 hash of the token is stored, so a database leak does not hand
 *     over live sessions (AGENTS.md §14). SHA-256 is appropriate here and would
 *     NOT be for a password: the token is 32 bytes of full-entropy random data, so
 *     there is nothing to brute-force, whereas passwords need a slow KDF — see
 *     `password.ts` for why the two use different primitives.
 *
 * ONE FAILURE MESSAGE, used for every rejected login. Unknown email, wrong
 * password, null password hash, and an unparseable stored hash all produce the
 * same `UnauthenticatedError` with the same text. Distinguishing them would turn
 * the login endpoint into an account-existence oracle, which is a real disclosure
 * on a ticketing platform where the set of organiser accounts is small and
 * guessable.
 */

import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { UnauthenticatedError } from "@/domain/errors";

import type { AuthenticatedOrganiser, AuthRepository } from "./auth.repository";
import { verifyPassword } from "./password";
import { SESSION_MAX_AGE_SECONDS } from "./session-cookie";

/**
 * The single message every failed login returns.
 *
 * Constant by construction: there is exactly one throw site below, so no future
 * branch can accidentally add a more specific one.
 */
const INVALID_CREDENTIALS_MESSAGE = "Email or password is incorrect.";

/**
 * A real hash of an unguessable value, used only to burn the same CPU a genuine
 * verification would when the email does not exist.
 *
 * Must be a *valid* scrypt hash with the same cost parameters as a real one, or
 * the timing equalisation is a no-op: the whole point is that the failure path
 * performs the same memory-hard work. Sixteen zero bytes of salt and a
 * 64-byte-zero key are well-formed; nothing can ever produce a matching
 * password, which is also why it is safe to keep in source.
 */
const DUMMY_HASH =
  "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** How the session store identifies a token. */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Mint a session token: 32 bytes of CSPRNG output, base64url-encoded. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export class AuthService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Exchange credentials for a session token.
   *
   * The plaintext password goes no further than this method: it is compared
   * against the stored hash and dropped. It is never passed to the repository,
   * never included in an error, and never returned.
   */
  async login(email: string, password: string): Promise<AuthenticatedOrganiser> {
    const account = await this.repository.findOrganiserByEmail(email);

    if (account === null) {
      // Still spend the time a real verification would, so response latency does
      // not reveal whether the address exists. Without this, "no such user" is
      // measurably faster than "wrong password", and the uniform message is
      // undone by the uniform-latency assumption it depends on.
      await verifyPassword(password, DUMMY_HASH);
      throw new UnauthenticatedError(INVALID_CREDENTIALS_MESSAGE);
    }

    if (!(await verifyPassword(password, account.passwordHash))) {
      throw new UnauthenticatedError(INVALID_CREDENTIALS_MESSAGE);
    }

    const session = await this.issueSession(account.id);

    return {
      organiserId: account.id,
      email: account.email,
      sessionToken: session.token,
      expiresAt: session.expiresAt,
    };
  }

  /**
   * Resolve a cookie token to an organiser, or throw.
   *
   * This is the check every organiser route depends on, so it is written to fail
   * closed in every branch: no token, unknown token, expired token, and a token
   * whose organiser has since been deleted all end as `UnauthenticatedError`.
   */
  async resolveSessionToken(token: string): Promise<AuthenticatedOrganiser> {
    const now = this.now();
    const session = await this.repository.findSessionByTokenHash(hashSessionToken(token), now);

    if (session === null) {
      throw new UnauthenticatedError("This request has no valid organiser session.");
    }

    // The store is required to filter expired sessions, and the Prisma adapter
    // does it in the query. This repeats the check so the guarantee is local to
    // the service rather than dependent on every future adapter honouring its
    // part of the port contract: an adapter that forgot the filter would
    // otherwise honour an expired session, and session expiry is the one control
    // standing between a stolen token and seven days of access.
    if (session.expiresAt.getTime() <= now.getTime()) {
      throw new UnauthenticatedError("This request has no valid organiser session.");
    }

    const account = await this.repository.findOrganiserById(session.organiserId);

    if (account === null) {
      // The session outlived its owner. Refuse rather than trust the session row
      // alone, and drop the orphan so it cannot keep being presented.
      await this.repository.deleteSessionByTokenHash(hashSessionToken(token));
      throw new UnauthenticatedError("This request has no valid organiser session.");
    }

    return {
      organiserId: account.id,
      email: account.email,
      sessionToken: token,
      expiresAt: session.expiresAt,
    };
  }

  /**
   * End a session.
   *
   * Idempotent and silent: a logout with no token succeeds. Answering `403` here
   * would make a client that retries after a network timeout unable to
   * distinguish "already signed out" from "signed out somewhere else".
   */
  async logout(token: string | null): Promise<void> {
    if (token === null || token === "") {
      return;
    }

    await this.repository.deleteSessionByTokenHash(hashSessionToken(token));
  }

  private async issueSession(
    organiserId: string,
  ): Promise<{ readonly token: string; readonly expiresAt: Date }> {
    const token = generateSessionToken();
    const expiresAt = new Date(this.now().getTime() + SESSION_MAX_AGE_SECONDS * 1000);

    await this.repository.createSession({
      organiserId,
      tokenHash: hashSessionToken(token),
      expiresAt,
    });

    return { token, expiresAt };
  }
}

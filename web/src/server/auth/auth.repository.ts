/**
 * Persistence port for organiser authentication.
 *
 * Mirrors `src/domain/events/event.repository.ts`: the consumer declares the
 * interface, `src/server/db` supplies the Prisma implementation. Two small
 * records and three methods, so the port earns its keep by letting every
 * authentication rule be tested against an in-memory fake with no database and no
 * scrypt cost (AGENTS.md §4).
 *
 * Deliberately narrow. The port never sees a plaintext password — `login` takes
 * the email and returns the stored hash for the caller to verify, so no layer
 * between here and the database is in a position to log it. The alternative,
 * passing the plaintext in and letting the adapter do the comparison, would put
 * a credential in an argument list that a careless `console.log` or an error
 * reporter could capture.
 */

import "server-only";

/** An organiser account, reduced to what authentication needs. */
export interface OrganiserCredentialRecord {
  readonly id: string;
  readonly email: string;
  /**
   * The stored hash, or `null` for an account that has no password.
   *
   * Nullable because §7.2 specifies `password_hash` OR `auth_provider_id` and
   * decision 1 chose the password side. An account carrying only the provider id
   * cannot log in with a password, and the service treats it exactly like a wrong
   * password.
   */
  readonly passwordHash: string | null;
}

export interface SessionRecord {
  readonly id: string;
  readonly organiserId: string;
  readonly expiresAt: Date;
}

/** What a successful login or session lookup yields. */
export interface AuthenticatedOrganiser {
  readonly organiserId: string;
  readonly email: string;
  /** The opaque token to hand to the client. Only this one call ever returns it. */
  readonly sessionToken: string;
  readonly expiresAt: Date;
}

export interface CreateSessionInput {
  readonly organiserId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

export interface AuthRepository {
  /**
   * Find an account by email, case-insensitively.
   *
   * Case-insensitive because an email local part is conventionally treated that
   * way by users even though the domain technically is not, and because a
   * case-sensitive compare here would produce a login that "randomly" fails for
   * a person who typed their address in a different case than they registered
   * with. The unique index still guarantees one row per address.
   */
  findOrganiserByEmail(email: string): Promise<OrganiserCredentialRecord | null>;

  findOrganiserById(id: string): Promise<OrganiserCredentialRecord | null>;

  /**
   * Look up a live session by the hash of its token.
   *
   * MUST return `null` for a session whose `expires_at` has passed, so expiry is
   * enforced by the store rather than trusted from the client. Deleting expired
   * rows is not this method's job.
   */
  findSessionByTokenHash(tokenHash: string, now: Date): Promise<SessionRecord | null>;

  createSession(input: CreateSessionInput): Promise<SessionRecord>;

  /**
   * Remove a session by token hash.
   *
   * Idempotent: logging out twice, or with a token that never existed, is not an
   * error — the desired state (no session) already holds.
   */
  deleteSessionByTokenHash(tokenHash: string): Promise<void>;
}

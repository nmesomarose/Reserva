/**
 * Prisma implementation of the authentication persistence port.
 *
 * Maps rows to records and enforces the port's guarantees in the query, exactly as
 * `event.repository.ts` does. The only place in the codebase that knows both
 * Prisma and the auth port.
 */

import "server-only";

import type { Prisma } from "@/generated/prisma/client";

import type {
  AuthRepository,
  CreateSessionInput,
  OrganiserCredentialRecord,
  SessionRecord,
} from "@/server/auth/auth.repository";

/**
 * Structural subset of an organiser row, so the mapping accepts the narrow
 * `select` used below as well as a full row.
 *
 * Written as a shape rather than the generated model because the queries select
 * only these three columns — asserting the full model here would force every
 * caller to fetch columns authentication has no use for.
 */
type CredentialColumns = {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string | null;
};

function toCredentialRecord(model: CredentialColumns): OrganiserCredentialRecord {
  return {
    id: model.id,
    email: model.email,
    passwordHash: model.passwordHash,
  };
}

function toSessionRecord(model: {
  readonly id: string;
  readonly organiserId: string;
  readonly expiresAt: Date;
}): SessionRecord {
  return {
    id: model.id,
    organiserId: model.organiserId,
    expiresAt: model.expiresAt,
  };
}

export class PrismaAuthRepository implements AuthRepository {
  constructor(private readonly prisma: Prisma.TransactionClient) {}

  /**
   * `mode: "insensitive"` gives the case-insensitive match the port promises.
   *
   * KNOWN COST, recorded rather than glossed: this is correct but not fast on a
   * large table. Prisma compiles it to `ILIKE`, and `ILIKE` cannot use the plain
   * unique B-tree on `organisers.email` — only a `citext` column, a functional
   * index on `lower(email)`, or a `pg_trgm` GIN index would. So this lookup is a
   * sequential scan of `organisers`, which is the table a pre-authentication
   * endpoint should be least able to hammer.
   *
   * Left as-is deliberately. The alternatives are a second migration and raw SQL
   * in this adapter, for a table that holds one row per organiser account and
   * will hold hundreds rather than millions. If that ever stops being true, the
   * fix is `CREATE UNIQUE INDEX organisers_email_lower_key ON organisers
   * (lower(email))` plus a `lower(email) = lower($1)` query — which then also
   * lets the database enforce case-insensitive uniqueness, something the current
   * exact-match index does not.
   */
  async findOrganiserByEmail(email: string): Promise<OrganiserCredentialRecord | null> {
    const found = await this.prisma.organiser.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true, email: true, passwordHash: true },
    });

    return found === null ? null : toCredentialRecord(found);
  }

  async findOrganiserById(id: string): Promise<OrganiserCredentialRecord | null> {
    const found = await this.prisma.organiser.findUnique({
      where: { id },
      select: { id: true, email: true, passwordHash: true },
    });

    return found === null ? null : toCredentialRecord(found);
  }

  /**
   * Expiry is part of the `where` clause, not a filter applied afterwards.
   *
   * That is what makes the port's guarantee unconditional: a row with a past
   * `expires_at` is never loaded, so no caller can forget to re-check it and
   * accidentally honour an expired session.
   */
  async findSessionByTokenHash(tokenHash: string, now: Date): Promise<SessionRecord | null> {
    const found = await this.prisma.organiserSession.findFirst({
      where: { tokenHash, expiresAt: { gt: now } },
      select: { id: true, organiserId: true, expiresAt: true },
    });

    return found === null ? null : toSessionRecord(found);
  }

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const created = await this.prisma.organiserSession.create({
      data: {
        organiserId: input.organiserId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
      },
      select: { id: true, organiserId: true, expiresAt: true },
    });

    return toSessionRecord(created);
  }

  /**
   * `deleteMany`, not `delete`.
   *
   * `delete` on a missing row throws `P2025`, which would turn a repeated logout
   * into a `500`. The port requires idempotence, and `deleteMany` reports a count
   * instead of caring whether it was one.
   */
  async deleteSessionByTokenHash(tokenHash: string): Promise<void> {
    await this.prisma.organiserSession.deleteMany({ where: { tokenHash } });
  }
}

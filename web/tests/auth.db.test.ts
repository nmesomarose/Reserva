import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { UnauthenticatedError } from "@/domain/errors";
import { hashSessionToken, AuthService } from "@/server/auth/auth.service";
import { hashPassword } from "@/server/auth/password";
import { SESSION_MAX_AGE_SECONDS } from "@/server/auth/session-cookie";
import { prisma } from "@/server/db/client";
import { PrismaAuthRepository } from "@/server/db/auth.repository";

/**
 * Authentication against real PostgreSQL.
 *
 * The unit suite proves the rules with an in-memory repository. These prove the
 * things only the database can answer: that the session table really stores a
 * hash rather than a token, that the unique index and the `expires_at > created_at`
 * CHECK behave as the schema claims, that the `ON DELETE CASCADE` from
 * `organisers` is real, and that the case-insensitive email lookup works through
 * Prisma's `mode: "insensitive"` rather than only in the fake.
 *
 * Skipped when `DATABASE_URL` is absent, like the other integration suites.
 */

const RUN_ID = randomUUID();
const ORGANISER_ID = randomUUID();
const ORGANISER_EMAIL = `auth-slice-${RUN_ID}@test.invalid`;
const PASSWORD = "correct horse battery staple";

/** A second account carrying only a provider id, per §7.2's either/or. */
const PROVIDER_ONLY_ID = randomUUID();
const PROVIDER_ONLY_EMAIL = `auth-sso-${RUN_ID}@test.invalid`;

/** An address stored with deliberate casing, to prove the lookup ignores it. */
const MIXED_CASE_ID = randomUUID();
const MIXED_CASE_EMAIL = `Auth.Mixed.Case-${RUN_ID}@Test.INVALID`;

const describeWithDatabase = process.env.DATABASE_URL ? describe : describe.skip;

describeWithDatabase("organiser authentication against PostgreSQL", () => {
  const service = new AuthService(new PrismaAuthRepository(prisma));

  beforeAll(async () => {
    await prisma.organiser.createMany({
      data: [
        { id: ORGANISER_ID, email: ORGANISER_EMAIL, passwordHash: await hashPassword(PASSWORD) },
        // No password: §7.2 allows `password_hash` OR `auth_provider_id`.
        {
          id: PROVIDER_ONLY_ID,
          email: PROVIDER_ONLY_EMAIL,
          authProviderId: "google",
        },
        {
          id: MIXED_CASE_ID,
          email: MIXED_CASE_EMAIL,
          passwordHash: await hashPassword(PASSWORD),
        },
      ],
    });
  });

  afterAll(async () => {
    // Sessions cascade, so deleting the organisers is enough. No audit rows are
    // created here, so the append-only trigger is not in the way.
    await prisma.organiser.deleteMany({
      where: { id: { in: [ORGANISER_ID, PROVIDER_ONLY_ID, MIXED_CASE_ID] } },
    });
    await prisma.$disconnect();
  });

  it("stores only a hash of the session token, never the token", async () => {
    const result = await service.login(ORGANISER_EMAIL, PASSWORD);

    const row = await prisma.organiserSession.findFirstOrThrow({
      where: { organiserId: ORGANISER_ID },
    });

    expect(row.tokenHash).toBe(hashSessionToken(result.sessionToken));
    expect(row.tokenHash).not.toBe(result.sessionToken);
    // The plaintext must not appear anywhere in the stored row.
    expect(JSON.stringify(row)).not.toContain(result.sessionToken);
  });

  it("never stores the password, only its hash", async () => {
    await service.login(ORGANISER_EMAIL, PASSWORD);

    const row = await prisma.organiser.findUniqueOrThrow({ where: { id: ORGANISER_ID } });

    expect(row.passwordHash).toMatch(/^scrypt\$/);
    expect(row.passwordHash).not.toContain(PASSWORD);
  });

  it("issues a session that resolves back to the organiser", async () => {
    const { sessionToken } = await service.login(ORGANISER_EMAIL, PASSWORD);

    const resolved = await service.resolveSessionToken(sessionToken);

    expect(resolved.organiserId).toBe(ORGANISER_ID);
    expect(resolved.email).toBe(ORGANISER_EMAIL);
  });

  it("expires the session seven days out", async () => {
    const before = Date.now();
    await service.login(ORGANISER_EMAIL, PASSWORD);

    const row = await prisma.organiserSession.findFirstOrThrow({
      where: { organiserId: ORGANISER_ID },
      orderBy: { createdAt: "desc" },
    });
    const lifetime = row.expiresAt.getTime() - row.createdAt.getTime();

    expect(SESSION_MAX_AGE_SECONDS).toBe(7 * 24 * 60 * 60);
    // Within a second rather than exact: `created_at` is written by PostgreSQL's
    // `now()` and `expires_at` by the service's clock, and the column is
    // `timestamptz(3)`, so the two can differ by a millisecond of rounding. A day
    // or an hour of drift would still fail this comfortably.
    expect(Math.abs(lifetime - SESSION_MAX_AGE_SECONDS * 1000)).toBeLessThan(1_000);
    // And the clock the service used is real, not a fixture in the past.
    expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before - 5_000);
  });

  it("keeps concurrent sessions independent", async () => {
    const first = await service.login(ORGANISER_EMAIL, PASSWORD);
    const second = await service.login(ORGANISER_EMAIL, PASSWORD);

    await expect(service.resolveSessionToken(first.sessionToken)).resolves.toMatchObject({
      organiserId: ORGANISER_ID,
    });
    await expect(service.resolveSessionToken(second.sessionToken)).resolves.toMatchObject({
      organiserId: ORGANISER_ID,
    });
  });

  it("matches the stored email case-insensitively", async () => {
    // The stored value has capitals; the submitted one does not. Only the
    // adapter's `mode: "insensitive"` can reconcile them.
    const result = await service.login(MIXED_CASE_EMAIL.toLowerCase(), PASSWORD);

    expect(result.organiserId).toBe(MIXED_CASE_ID);
  });

  it("refuses an expired session", async () => {
    const { sessionToken } = await service.login(ORGANISER_EMAIL, PASSWORD);

    // `organiser_sessions_expires_in_future_check` requires
    // `expires_at > created_at`, so ageing the row means ageing both ends — the
    // same thing that happens to a real session over seven days.
    await prisma.$executeRaw`
      UPDATE organiser_sessions
         SET created_at = now() - interval '8 days',
             expires_at = now() - interval '1 day'
       WHERE token_hash = ${hashSessionToken(sessionToken)}
    `;

    await expect(service.resolveSessionToken(sessionToken)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it("refuses a token it has never issued", async () => {
    await expect(service.resolveSessionToken("not-a-real-token")).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it("gives the same failure for a wrong password and an unknown account", async () => {
    const messages: string[] = [];

    for (const [email, password] of [
      [ORGANISER_EMAIL, "wrong"],
      ["nobody@test.invalid", PASSWORD],
    ] as const) {
      try {
        await service.login(email, password);
        throw new Error("expected a rejection");
      } catch (error) {
        messages.push((error as UnauthenticatedError).message);
      }
    }

    expect(messages[0]).toBe(messages[1]);
  });

  it("creates no session row for a rejected login", async () => {
    const before = await prisma.organiserSession.count({ where: { organiserId: ORGANISER_ID } });

    await expect(service.login(ORGANISER_EMAIL, "wrong")).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
    await expect(
      service.login("nobody@test.invalid", PASSWORD),
    ).rejects.toBeInstanceOf(UnauthenticatedError);

    await expect(
      prisma.organiserSession.count({ where: { organiserId: ORGANISER_ID } }),
    ).resolves.toBe(before);
  });

  it("refuses an account whose only credential is an auth provider", async () => {
    await expect(service.login(PROVIDER_ONLY_EMAIL, PASSWORD)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it("deletes the session row on logout", async () => {
    const { sessionToken } = await service.login(ORGANISER_EMAIL, PASSWORD);

    await service.logout(sessionToken);

    await expect(
      prisma.organiserSession.count({ where: { tokenHash: hashSessionToken(sessionToken) } }),
    ).resolves.toBe(0);
  });

  it("treats a repeated logout as success", async () => {
    const { sessionToken } = await service.login(ORGANISER_EMAIL, PASSWORD);

    await service.logout(sessionToken);

    // `deleteMany`, not `delete`: a missing row must not raise.
    await expect(service.logout(sessionToken)).resolves.toBeUndefined();
    await expect(service.logout(null)).resolves.toBeUndefined();
  });

  it("rejects a token whose row was deleted", async () => {
    const { sessionToken } = await service.login(ORGANISER_EMAIL, PASSWORD);
    await service.logout(sessionToken);

    await expect(service.resolveSessionToken(sessionToken)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it("cascades sessions away when the organiser is deleted", async () => {
    // The `organiser_id` FK is ON DELETE CASCADE, so removing an account cannot
    // leave a live session behind for a row that no longer exists.
    const temporaryId = randomUUID();
    const temporaryEmail = `auth-cascade-${RUN_ID}@test.invalid`;

    await prisma.organiser.create({
      data: { id: temporaryId, email: temporaryEmail, passwordHash: await hashPassword(PASSWORD) },
    });

    const scoped = new AuthService(new PrismaAuthRepository(prisma));
    const { sessionToken } = await scoped.login(temporaryEmail, PASSWORD);

    await prisma.organiser.delete({ where: { id: temporaryId } });

    await expect(
      prisma.organiserSession.count({ where: { organiserId: temporaryId } }),
    ).resolves.toBe(0);
    await expect(scoped.resolveSessionToken(sessionToken)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it("rejects a duplicated token hash at the database level", async () => {
    // The unique index, not application logic, is what makes "generate a token,
    // insert it" safe: a collision is a rejected write rather than two sessions
    // sharing one cookie.
    const { sessionToken } = await service.login(ORGANISER_EMAIL, PASSWORD);
    const tokenHash = hashSessionToken(sessionToken);
    const existing = await prisma.organiserSession.findFirstOrThrow({
      where: { tokenHash },
    });

    await expect(
      prisma.organiserSession.create({
        data: {
          organiserId: PROVIDER_ONLY_ID,
          tokenHash,
          expiresAt: existing.expiresAt,
        },
      }),
    ).rejects.toThrow();

    await service.logout(sessionToken);
  });
});

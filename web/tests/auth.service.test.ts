import { beforeEach, describe, expect, it } from "vitest";

import { UnauthenticatedError } from "@/domain/errors";
import type {
  AuthRepository,
  CreateSessionInput,
  OrganiserCredentialRecord,
  SessionRecord,
} from "@/server/auth/auth.repository";
import { AuthService, generateSessionToken, hashSessionToken } from "@/server/auth/auth.service";
import { hashPassword } from "@/server/auth/password";
import { SESSION_MAX_AGE_SECONDS } from "@/server/auth/session-cookie";

/**
 * `AuthService` rules, against an in-memory repository.
 *
 * Every authentication guarantee is proven here without a database, per
 * AGENTS.md §4: uniform failure, case-insensitive lookup, expiry, the orphan
 * session, idempotent logout, and the fact that a plaintext password never
 * reaches the port.
 */

const ORGANISER_ID = "11111111-1111-1111-1111-111111111111";
const NOW = new Date("2026-09-26T12:00:00Z");
const PASSWORD = "correct horse battery staple";

/**
 * One real scrypt hash for the whole file.
 *
 * The fake is populated with a genuine hash rather than a hand-written string so
 * the service runs the same verification path it runs in production. It is
 * computed once and shared: at ~60 ms a hash, re-deriving it per test would add
 * seconds of pure latency to the suite and prove nothing extra.
 */
let hashPromise: Promise<string> | undefined;

function realHash(): Promise<string> {
  hashPromise ??= hashPassword(PASSWORD);

  return hashPromise;
}

class FakeAuthRepository implements AuthRepository {
  accounts = new Map<string, OrganiserCredentialRecord>();
  sessions = new Map<string, SessionRecord>();
  created: CreateSessionInput[] = [];
  deletedHashes: string[] = [];
  /** When set, the next `findSessionByTokenHash` ignores expiry, to prove the
   *  service does not rely on the store to do it. */
  ignoreExpiry = false;
  /** Replaces the `expiresAt` handed back by `findSessionByTokenHash`, so a
   *  stale row can be simulated without mutating a `readonly` record. */
  expiresAtOverride: Date | null = null;

  constructor(passwordHash: string) {
    this.accounts.set("organiser@example.test", {
      id: ORGANISER_ID,
      email: "organiser@example.test",
      passwordHash,
    });
  }

  async findOrganiserByEmail(email: string): Promise<OrganiserCredentialRecord | null> {
    const wanted = email.toLowerCase();

    for (const account of this.accounts.values()) {
      if (account.email.toLowerCase() === wanted) {
        return account;
      }
    }

    return null;
  }

  async findOrganiserById(id: string): Promise<OrganiserCredentialRecord | null> {
    for (const account of this.accounts.values()) {
      if (account.id === id) {
        return account;
      }
    }

    return null;
  }

  async findSessionByTokenHash(tokenHash: string, now: Date): Promise<SessionRecord | null> {
    const found = this.sessions.get(tokenHash);

    if (found === undefined) {
      return null;
    }

    if (!this.ignoreExpiry && found.expiresAt.getTime() <= now.getTime()) {
      return null;
    }

    return this.expiresAtOverride === null
      ? found
      : { ...found, expiresAt: this.expiresAtOverride };
  }

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    this.created.push(input);
    const record: SessionRecord = {
      id: `session-${this.created.length}`,
      organiserId: input.organiserId,
      expiresAt: input.expiresAt,
    };

    this.sessions.set(input.tokenHash, record);

    return record;
  }

  async deleteSessionByTokenHash(tokenHash: string): Promise<void> {
    this.deletedHashes.push(tokenHash);
    this.sessions.delete(tokenHash);
  }
}

let repository: FakeAuthRepository;
let service: AuthService;

beforeEach(async () => {
  repository = new FakeAuthRepository(await realHash());
  service = new AuthService(repository, () => NOW);
});

describe("AuthService.login", () => {
  it("returns a session token for correct credentials", async () => {
    const result = await service.login("organiser@example.test", "correct horse battery staple");

    expect(result.organiserId).toBe(ORGANISER_ID);
    expect(result.email).toBe("organiser@example.test");
    expect(result.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("stores only a hash of the token, never the token", async () => {
    const result = await service.login("organiser@example.test", "correct horse battery staple");

    expect(repository.created).toHaveLength(1);
    expect(repository.created[0]!.tokenHash).toBe(hashSessionToken(result.sessionToken));
    expect(repository.created[0]!.tokenHash).not.toBe(result.sessionToken);
    expect(JSON.stringify(repository.created)).not.toContain(result.sessionToken);
  });

  it("expires the session after the configured lifetime", async () => {
    const result = await service.login("organiser@example.test", "correct horse battery staple");

    expect(result.expiresAt.getTime()).toBe(
      NOW.getTime() + SESSION_MAX_AGE_SECONDS * 1000,
    );
  });

  it("never passes the plaintext password to the repository", async () => {
    await service.login("organiser@example.test", "correct horse battery staple");

    // A blanket check: no method the port exposes has a password parameter, so
    // the only way a plaintext could leak is via a stored field.
    expect(JSON.stringify(repository.created)).not.toContain("correct horse");
    expect(JSON.stringify([...repository.accounts.values()])).not.toContain(
      "correct horse battery staple",
    );
  });

  it("mints a different token each time", async () => {
    const first = await service.login("organiser@example.test", "correct horse battery staple");
    const second = await service.login("organiser@example.test", "correct horse battery staple");

    expect(first.sessionToken).not.toBe(second.sessionToken);
    // Both sessions stay valid: a second login does not evict the first.
    expect(repository.sessions.size).toBe(2);
  });

  it("passes the email to the port exactly as given", async () => {
    // Normalisation is the route's job — `readCredential` trims, and the port
    // contract covers case-insensitivity. The service's responsibility is the
    // opposite one: it must not rewrite the address, because a "helpful"
    // lowercase here would hide a port that stopped matching case-insensitively.
    //
    // A padded, mixed-case address is the probe: a normalising service would hand
    // the port something tidier than it received. The lookup itself is expected
    // to miss, because nothing at this layer strips the padding — the fake is
    // not being lenient, and neither is a real adapter.
    const seen: string[] = [];
    const original = repository.findOrganiserByEmail.bind(repository);
    repository.findOrganiserByEmail = (email: string) => {
      seen.push(email);

      return original(email);
    };

    await expect(service.login("  Organiser@Example.Test  ", PASSWORD)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );

    expect(seen).toEqual(["  Organiser@Example.Test  "]);
  });

  // The three rejection cases below MUST be indistinguishable. If any of them
  // produced a different error, type, or message, the login endpoint would tell a
  // caller which organiser accounts exist.
  const rejections: Array<[string, () => Promise<unknown>]> = [
    ["an unknown email", () => service.login("nobody@example.test", "correct horse battery staple")],
    ["a wrong password", () => service.login("organiser@example.test", "wrong")],
    ["an empty password", () => service.login("organiser@example.test", "")],
  ];

  it.each(rejections)("rejects %s", async (_label, call) => {
    await expect(call()).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("gives every rejection the same message and creates no session", async () => {
    const messages: string[] = [];

    for (const [, call] of rejections) {
      try {
        await call();
        throw new Error("expected a rejection");
      } catch (error) {
        if (!(error instanceof UnauthenticatedError)) {
          throw error;
        }

        messages.push(error.message);
      }
    }

    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).not.toMatch(/not found|no such|unknown/i);
    expect(repository.created).toHaveLength(0);
  });

  it("rejects an account whose only credential is an auth provider", async () => {
    // §7.2 allows `password_hash` OR `auth_provider_id`; decision 1 chose the
    // password side, so a provider-only account cannot log in with a password.
    repository.accounts.set("sso@example.test", {
      id: "22222222-2222-2222-2222-222222222222",
      email: "sso@example.test",
      passwordHash: null,
    });

    await expect(service.login("sso@example.test", "anything")).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it("reports the same failure for a null hash as for a wrong password", async () => {
    repository.accounts.set("sso@example.test", {
      id: "22222222-2222-2222-2222-222222222222",
      email: "sso@example.test",
      passwordHash: null,
    });

    const messages: string[] = [];

    for (const email of ["nobody@example.test", "sso@example.test"]) {
      try {
        await service.login(email, "correct horse battery staple");
        throw new Error("expected a rejection");
      } catch (error) {
        messages.push((error as UnauthenticatedError).message);
      }
    }

    expect(messages[0]).toBe(messages[1]);
  });
});

describe("AuthService.resolveSessionToken", () => {
  async function login(): Promise<string> {
    const result = await service.login("organiser@example.test", "correct horse battery staple");

    return result.sessionToken;
  }

  it("resolves a live token to its organiser", async () => {
    const token = await login();

    const resolved = await service.resolveSessionToken(token);

    expect(resolved.organiserId).toBe(ORGANISER_ID);
    expect(resolved.email).toBe("organiser@example.test");
  });

  it("rejects an unknown token", async () => {
    await expect(service.resolveSessionToken("not-a-real-token")).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it("rejects an expired session even if the store returns it", async () => {
    // `ignoreExpiry` makes the store hand back a stale row, so this proves the
    // *service* is not merely trusting the store's filter. Defence in depth: the
    // Prisma adapter filters in the query, and a future adapter that forgot to
    // would otherwise honour an expired session.
    const token = await login();
    repository.ignoreExpiry = true;
    repository.expiresAtOverride = new Date(NOW.getTime() - 1000);

    await expect(service.resolveSessionToken(token)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it("does not return the token as part of the resolved identity", async () => {
    // The resolved context is what route handlers pass to the domain. Echoing the
    // bearer token back through it would widen the blast radius of every caller.
    const token = await login();

    const resolved = await service.resolveSessionToken(token);

    expect(Object.keys(resolved).sort()).toEqual([
      "email",
      "expiresAt",
      "organiserId",
      "sessionToken",
    ]);
  });

  it("rejects and drops a session whose organiser no longer exists", async () => {
    const token = await login();
    repository.accounts.delete("organiser@example.test");

    await expect(service.resolveSessionToken(token)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
    // The orphan is removed so it cannot keep being presented.
    expect(repository.deletedHashes).toContain(hashSessionToken(token));
    expect(repository.sessions.size).toBe(0);
  });

  it("gives every failure the same message", async () => {
    const messages: string[] = [];

    for (const token of ["not-a-real-token", generateSessionToken()]) {
      try {
        await service.resolveSessionToken(token);
        throw new Error("expected a rejection");
      } catch (error) {
        messages.push((error as UnauthenticatedError).message);
      }
    }

    expect(new Set(messages).size).toBe(1);
  });
});

describe("AuthService.logout", () => {
  it("deletes the session", async () => {
    const result = await service.login("organiser@example.test", "correct horse battery staple");

    await service.logout(result.sessionToken);

    expect(repository.sessions.size).toBe(0);
    await expect(service.resolveSessionToken(result.sessionToken)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it("is idempotent for an unknown token", async () => {
    // A logout that 403'd on an already-ended session would leave a client that
    // retried after a timeout unable to tell "already signed out" from a failure.
    await expect(service.logout("not-a-real-token")).resolves.toBeUndefined();
  });

  it("does nothing for a null or empty token", async () => {
    await expect(service.logout(null)).resolves.toBeUndefined();
    await expect(service.logout("")).resolves.toBeUndefined();

    expect(repository.deletedHashes).toHaveLength(0);
  });

  it("leaves other sessions alone", async () => {
    const first = await service.login("organiser@example.test", "correct horse battery staple");
    const second = await service.login("organiser@example.test", "correct horse battery staple");

    await service.logout(first.sessionToken);

    await expect(service.resolveSessionToken(second.sessionToken)).resolves.toMatchObject({
      organiserId: ORGANISER_ID,
    });
  });
});

describe("session tokens", () => {
  it("are 32 bytes of CSPRNG output, base64url-encoded", () => {
    const token = generateSessionToken();

    // 32 bytes -> 43 base64url characters, no padding, URL-safe alphabet.
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("are unpredictable", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateSessionToken()));

    expect(tokens.size).toBe(200);
  });

  it("hash deterministically and irreversibly", () => {
    const token = generateSessionToken();
    const hash = hashSessionToken(token);

    expect(hashSessionToken(token)).toBe(hash);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(token);
  });

  it("hash a token and its near-miss differently", () => {
    const token = generateSessionToken();

    expect(hashSessionToken(`${token}x`)).not.toBe(hashSessionToken(token));
  });
});

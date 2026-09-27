import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "@/server/auth/password";

/**
 * Password hashing (product-owner decision 1).
 *
 * These tests care about four things:
 *   - a correct password verifies;
 *   - an incorrect one does not, and neither does a near-miss;
 *   - a malformed or absent stored hash is a failed login, never a `500`;
 *   - the stored value is not the password.
 *
 * scrypt is deliberately slow, so the suite is kept small: each hash costs about
 * 50–100 ms at these parameters, and a couple of dozen of them is the right
 * trade for proving the security-critical path.
 */

const PASSWORD = "correct horse battery staple";

describe("hashPassword", () => {
  it("produces a self-describing scrypt string", async () => {
    const stored = await hashPassword(PASSWORD);

    // Format: scrypt$N$r$p$salt$key — the parameters travel with the hash so the
    // cost can be raised later without invalidating existing rows.
    const [algorithm, n, r, p, salt, key] = stored.split("$");

    expect(algorithm).toBe("scrypt");
    expect(Number(n)).toBeGreaterThanOrEqual(16_384);
    expect(Number(r)).toBeGreaterThanOrEqual(8);
    expect(Number(p)).toBeGreaterThanOrEqual(1);
    expect(Buffer.from(salt!, "base64")).toHaveLength(16);
    expect(Buffer.from(key!, "base64")).toHaveLength(64);
  });

  it("never contains the plaintext", async () => {
    const stored = await hashPassword(PASSWORD);

    expect(stored).not.toContain(PASSWORD);
  });

  it("salts, so the same password hashes differently every time", async () => {
    const [first, second] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);

    expect(first).not.toBe(second);
    // Both must still verify: a differing hash is only correct if verification
    // reads the salt out of the stored value.
    await expect(verifyPassword(PASSWORD, first)).resolves.toBe(true);
    await expect(verifyPassword(PASSWORD, second)).resolves.toBe(true);
  });
});

describe("verifyPassword", () => {
  it("accepts the password it was hashed from", async () => {
    const stored = await hashPassword(PASSWORD);

    await expect(verifyPassword(PASSWORD, stored)).resolves.toBe(true);
  });

  it("rejects a different password", async () => {
    const stored = await hashPassword(PASSWORD);

    await expect(verifyPassword("correct horse battery stapl", stored)).resolves.toBe(false);
  });

  it("rejects a case-different password", async () => {
    const stored = await hashPassword(PASSWORD);

    await expect(verifyPassword(PASSWORD.toUpperCase(), stored)).resolves.toBe(false);
  });

  it("rejects an empty password", async () => {
    const stored = await hashPassword(PASSWORD);

    await expect(verifyPassword("", stored)).resolves.toBe(false);
  });

  it("preserves significant whitespace in the password", async () => {
    // The login route deliberately does not trim, so a password with a trailing
    // space must round-trip rather than being silently normalised.
    const stored = await hashPassword("  spaced  ");

    await expect(verifyPassword("  spaced  ", stored)).resolves.toBe(true);
    await expect(verifyPassword("spaced", stored)).resolves.toBe(false);
  });

  it("round-trips a non-ASCII password", async () => {
    const stored = await hashPassword("påsswörd-日本語-🔑");

    await expect(verifyPassword("påsswörd-日本語-🔑", stored)).resolves.toBe(true);
  });

  // A missing or unparseable stored hash must be indistinguishable from a wrong
  // password, or the login endpoint becomes a fingerprinting oracle: a caller
  // could tell "this account uses a provider login" from "this account exists".
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
    ["not a hash at all", "hunter2"],
    ["wrong algorithm", "bcrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA"],
    ["too few parts", "scrypt$16384$8$1$AAAA"],
    ["too many parts", "scrypt$16384$8$1$AAAA$AAAA$AAAA"],
    ["non-numeric parameters", "scrypt$many$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA"],
    ["absurd work factor", "scrypt$1073741824$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA"],
    ["absurd block size", "scrypt$16384$999$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA"],
    ["absurd parallelism", "scrypt$16384$8$999$AAAAAAAAAAAAAAAAAAAAAA==$AAAA"],
    ["empty salt", "scrypt$16384$8$1$$AAAA"],
  ])("fails closed for a stored value that is %s", async (_label, stored) => {
    await expect(verifyPassword(PASSWORD, stored as string | null)).resolves.toBe(false);
  });

  it("never throws, whatever it is handed", async () => {
    // The type system forbids most of these, but the value comes out of a
    // database column and a CHECK-less column is exactly the kind of thing that
    // holds a surprise.
    for (const stored of [0, true, {}, [], NaN] as unknown[]) {
      await expect(
        verifyPassword(PASSWORD, stored as unknown as string),
      ).resolves.toBe(false);
    }
  });
});

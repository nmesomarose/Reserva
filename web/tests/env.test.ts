import { afterEach, describe, expect, it } from "vitest";

import {
  MissingEnvironmentError,
  getServerEnv,
  getServerEnvReport,
} from "@/server/env";

const originalDatabaseUrl = process.env.DATABASE_URL;

afterEach(() => {
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

/**
 * Proves the centralised environment layer fails clearly when scaffold-required
 * configuration is absent, and never exposes values.
 */
describe("server env", () => {
  it("throws a named error listing the missing variable", () => {
    delete process.env.DATABASE_URL;

    expect(() => getServerEnv()).toThrow(MissingEnvironmentError);

    try {
      getServerEnv();
      expect.unreachable("getServerEnv should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(MissingEnvironmentError);
      const missing = (error as MissingEnvironmentError).missing;
      expect(missing).toContain("DATABASE_URL");
      // The message names the variable but must never include a value.
      expect((error as Error).message).toContain("DATABASE_URL");
    }
  });

  it("treats an empty string as missing", () => {
    process.env.DATABASE_URL = "   ";
    expect(() => getServerEnv()).toThrow(MissingEnvironmentError);
  });

  it("reports status without throwing when configuration is absent", () => {
    delete process.env.DATABASE_URL;

    const report = getServerEnvReport();
    expect(report.ok).toBe(false);
    expect(report.missing).toContain("DATABASE_URL");
  });

  it("reports ok when the required variable is present", () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/db";

    const report = getServerEnvReport();
    expect(report.ok).toBe(true);
    expect(report.missing).toHaveLength(0);
    expect(JSON.stringify(report)).not.toContain("postgresql://");
  });
});

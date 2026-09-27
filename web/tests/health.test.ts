import { afterEach, describe, expect, it } from "vitest";

import { GET } from "@/app/api/health/route";

/**
 * Proves the scaffold boots and serves an infrastructure route.
 * It asserts nothing about product behaviour, which is not implemented.
 */

const originalDatabaseUrl = process.env.DATABASE_URL;

afterEach(() => {
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

describe("GET /api/health", () => {
  it("returns 200 with an ok status", async () => {
    const response = GET();

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("web");
  });

  it("never echoes an environment value back to the caller", async () => {
    const sentinel = "postgresql://sentinel-user:sentinel-pass@localhost:5432/sentinel-db";
    process.env.DATABASE_URL = sentinel;

    const body = await GET().json();

    expect(body.config.ok).toBe(true);

    // Reporting the NAME of a missing variable is required for a clear failure;
    // reporting its VALUE would leak a credential (AGENTS.md §14).
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain("sentinel");
    expect(serialised).not.toContain("postgresql://");
  });

  it("reports missing configuration by name, without a 5xx", async () => {
    delete process.env.DATABASE_URL;

    const response = GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.config.ok).toBe(false);
    expect(body.config.missing).toContain("DATABASE_URL");
  });
});

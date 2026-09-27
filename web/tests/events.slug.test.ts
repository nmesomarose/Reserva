import { describe, expect, it } from "vitest";

import {
  MAX_SLUG_LENGTH,
  randomSlugCandidate,
  randomSlugSuffix,
  slugCandidates,
  slugify,
} from "@/domain/events/slug";

/**
 * Pure-function tests for the slug strategy.
 *
 * Product-owner decision 3 (2026-09-26) settled the strategy: derive from the
 * name, then `slug-2`, `slug-3`, … in order, then a short random token, with a
 * 200-character maximum. These tests pin all three properties plus the one the
 * decision singles out — that no truncation can make two candidates identical,
 * which is what "without truncating into duplicate ambiguity" means in practice.
 */

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Jazz Night")).toBe("jazz-night");
  });

  it("folds diacritics to ASCII instead of dropping the vowels", () => {
    expect(slugify("Fête de la Musique")).toBe("fete-de-la-musique");
  });

  it("collapses runs of separators and trims the edges", () => {
    expect(slugify("  --Autumn   Festival!!  ")).toBe("autumn-festival");
  });

  it("keeps digits", () => {
    expect(slugify("Session 7: Late Night")).toBe("session-7-late-night");
  });

  it("returns an empty slug when there is nothing URL-safe to keep", () => {
    // The service turns this into a 400 rather than persisting an empty slug.
    expect(slugify("日本語")).toBe("");
    expect(slugify("!!!")).toBe("");
  });

  it("truncates long names without leaving a trailing hyphen", () => {
    const slug = slugify(`${"word ".repeat(80)}end`);

    expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("uses the full allowance when the first candidate needs no suffix", () => {
    // The first candidate carries no suffix, so truncating it below 200 would
    // waste characters for no reason.
    expect(slugify("a".repeat(500)).length).toBe(MAX_SLUG_LENGTH);
  });
});

describe("slugCandidates", () => {
  it("starts with the base and then numbers upwards", () => {
    expect(slugCandidates("jazz-night", 3)).toEqual([
      "jazz-night",
      "jazz-night-2",
      "jazz-night-3",
    ]);
  });

  it("always includes the base, even for a single attempt", () => {
    expect(slugCandidates("jazz", 1)).toEqual(["jazz"]);
  });

  it("keeps every candidate inside the maximum length", () => {
    // A 200-character base is the case that matters: appending "-2" naively
    // would produce 202 characters and be rejected by `events_slug_length_check`.
    const base = slugify("a".repeat(500));
    const candidates = slugCandidates(base, 50);

    for (const candidate of candidates) {
      expect(candidate.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
      expect(candidate.length).toBeGreaterThan(0);
    }
  });

  it("keeps every candidate distinct for a base at the length limit", () => {
    // The duplicate-ambiguity guarantee. Truncating the *suffix* instead of the
    // base would collapse these onto one string, and two attempts would then
    // propose the same slug.
    const candidates = slugCandidates(slugify("a".repeat(500)), 50);

    expect(new Set(candidates).size).toBe(candidates.length);
  });

  it("leaves no double hyphen where a truncated base meets its suffix", () => {
    const base = `${"a".repeat(MAX_SLUG_LENGTH - 1)}-b`;

    for (const candidate of slugCandidates(base, 3)) {
      expect(candidate).not.toContain("--");
    }
  });
});

describe("randomSlugSuffix", () => {
  it("produces a fixed-width base-36 token", () => {
    for (const random of [0, 0.5, 0.999_999_999]) {
      expect(randomSlugSuffix(() => random)).toMatch(/^[0-9a-z]{6}$/);
    }
  });

  it("is deterministic for a given random source", () => {
    expect(randomSlugSuffix(() => 0.25)).toBe(randomSlugSuffix(() => 0.25));
  });
});

describe("randomSlugCandidate", () => {
  it("appends the token to the base", () => {
    expect(randomSlugCandidate("jazz-night", "abc123")).toBe("jazz-night-abc123");
  });

  it("stays inside the maximum length for a base at the limit", () => {
    // The random fallback reserves the same headroom as the numbered ones, so
    // exhausting 50 deterministic attempts cannot produce an over-long slug.
    const candidate = randomSlugCandidate(slugify("a".repeat(500)), "abc123");

    expect(candidate.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(candidate.endsWith("-abc123")).toBe(true);
  });
});

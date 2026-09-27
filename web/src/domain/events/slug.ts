/**
 * Slug derivation for the public event URL (PRD v2 §7.2, §12).
 *
 * PRODUCT-OWNER DECISION 3 (2026-09-26) — this strategy is now settled, not a
 * placeholder:
 *
 *   1. derive a base slug from the event name;
 *   2. if it is taken, try `-2`, `-3`, `-4`, ... in order (deterministic);
 *   3. if every candidate is taken, append a short random token.
 *
 * Two consequences of the decision worth stating explicitly:
 *
 *   - A collision is NEVER reported to the client. Two events called "Jazz Night"
 *     are both creatable; the second gets `jazz-night-2`. The "reject with 409 on
 *     collision" reading would make a duplicate name impossible to create, which
 *     is not what "automatic slugs" is for. The `409` the port documents is
 *     therefore only a race backstop, not a user-facing outcome.
 *
 *   - The maximum length is 200 characters, the same figure decision 4 set for the
 *     slug validation limit and the same one `events_slug_length_check` enforces
 *     in the database. The base is therefore truncated *per candidate*, reserving
 *     room for the suffix, rather than truncated once and then blindly
 *     concatenated. Truncating once would emit `base-2` at 202 characters and be
 *     rejected by the CHECK; worse, truncating the suffix itself would map
 *     distinct attempts onto one identical candidate — the duplicate ambiguity
 *     the decision explicitly rules out. Every candidate this module emits is
 *     guaranteed to be 1..200 characters and distinct from its siblings.
 *
 * The invariant the database enforces, and the one that is not negotiable, is
 * `UNIQUE(event.slug)`.
 */

/**
 * Maximum slug length in characters.
 *
 * Mirrors `events_slug_length_check` and the decision-4 validation limit. A
 * mismatch between the three would either reject a slug this module considered
 * valid or store one the API refuses to return.
 */
export const MAX_SLUG_LENGTH = 200;

/** Upper bound on deterministic `-2`/`-3` attempts before falling back. */
const MAX_DETERMINISTIC_ATTEMPTS = 50;

/**
 * Trim `base` so that appending `suffix` still fits inside `MAX_SLUG_LENGTH`.
 *
 * The suffix is measured, not assumed: a `-2` costs two characters while the
 * random fallback costs seven, so reserving a single worst-case width would
 * needlessly shorten every deterministic candidate. Measuring each one is what
 * guarantees the random fallback cannot be the candidate that overruns the
 * limit.
 *
 * Trailing hyphens are removed first so the result never contains `--2` at the
 * seam, which would be a valid but ugly URL and would make two different inputs
 * slugify to the same string more often than necessary.
 */
function truncateForSuffix(base: string, suffix: string): string {
  const headroom = MAX_SLUG_LENGTH - suffix.length;

  if (base.length <= headroom) {
    return base;
  }

  return base.slice(0, headroom).replace(/-+$/, "");
}

/**
 * Turn arbitrary text into a URL-safe slug.
 *
 * Diacritics are folded to ASCII so "Fête de la Musique" yields
 * "fete-de-la-musique" rather than losing the vowels. Returns `""` when the
 * input carries no slug-able characters (e.g. "日本語"), which the caller must
 * treat as a validation failure rather than silently persisting an empty slug.
 *
 * Truncated to the full `MAX_SLUG_LENGTH`: the first candidate carries no suffix
 * and should use every character available. Candidates 2..n are shortened by
 * `truncateForSuffix` as needed.
 */
export function slugify(name: string): string {
  const folded = name
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

  const slug = folded
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");

  return slug;
}

/**
 * Ordered slug candidates for a base: `base`, `base-2`, `base-3`, ...
 *
 * Exposed as a pure function so the fallback ordering is testable without a
 * database. Every element is distinct: the suffix is appended *after* truncation
 * and is never itself truncated, so a 200-character base cannot collapse
 * `base-2` and `base-3` into the same string.
 */
export function slugCandidates(
  base: string,
  attempts: number = MAX_DETERMINISTIC_ATTEMPTS,
): string[] {
  const candidates: string[] = [base];

  for (let n = 2; n <= attempts; n += 1) {
    candidates.push(`${truncateForSuffix(base, `-${n}`)}-${n}`);
  }

  return candidates;
}

/**
 * Append a short random token to a base, used only once every deterministic
 * candidate is exhausted.
 */
export function randomSlugSuffix(random: () => number = Math.random): string {
  // 6 lowercase base-36 characters (~2.2e9 combinations) keeps the fallback
  // collision risk negligible without making URLs unwieldy.
  return Math.floor(random() * 36 ** 6)
    .toString(36)
    .padStart(6, "0");
}

/**
 * Final random-fallback candidate, length-bounded like every other candidate.
 *
 * Split out from the service so the "always within `MAX_SLUG_LENGTH`" guarantee
 * is a property of this module and provable by one test, instead of being
 * re-derived at each call site.
 */
export function randomSlugCandidate(base: string, suffix: string = randomSlugSuffix()): string {
  return `${truncateForSuffix(base, `-${suffix}`)}-${suffix}`;
}

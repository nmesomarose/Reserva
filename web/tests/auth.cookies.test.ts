import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ORGANISER_SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  buildSessionCookieOptions,
  readSessionCookie,
  serialiseClearedSessionCookie,
  serialiseSessionCookie,
} from "@/server/auth/session-cookie";

/**
 * Cookie attributes and parsing (product-owner decision 1).
 *
 * Each attribute is a security control, so each gets its own assertion. A test
 * that only checked "the cookie round-trips" would pass with `HttpOnly` missing,
 * which is the regression that matters most here.
 */

const TOKEN = "abc123XYZ-_token";

function cookieHeader(value: string): Request {
  return new Request("http://localhost/api/v1/events", {
    headers: { cookie: value },
  });
}

afterEach(() => {
  // Several cases below pin the `Secure` attribute by pinning the environment;
  // leaking that into the rest of the suite would quietly change what is being
  // asserted.
  vi.unstubAllEnvs();
});

describe("serialiseSessionCookie", () => {
  it("carries the token and the cookie name", () => {
    expect(serialiseSessionCookie(TOKEN)).toContain(`${ORGANISER_SESSION_COOKIE}=${TOKEN}`);
  });

  it("is HttpOnly, so page script cannot read the session", () => {
    // The single most important attribute: without it an XSS bug exfiltrates
    // every signed-in organiser's session.
    expect(serialiseSessionCookie(TOKEN)).toContain("HttpOnly");
  });

  it("is SameSite=Lax", () => {
    // "Lax" rather than "Strict": Strict also suppresses the cookie on a link
    // followed from another site, which breaks ordinary use for no gain here.
    // Lax still blocks the cross-site request that would forge a state change.
    expect(serialiseSessionCookie(TOKEN)).toContain("SameSite=Lax");
  });

  it("scopes to the whole site", () => {
    // The session covers every organiser route, not one.
    expect(serialiseSessionCookie(TOKEN)).toContain("Path=/");
  });

  it("carries a Max-Age matching the session lifetime", () => {
    expect(serialiseSessionCookie(TOKEN)).toContain(`Max-Age=${SESSION_MAX_AGE_SECONDS}`);
  });

  it("omits Secure on a local deployment so http://localhost works", () => {
    // The one place a missing `Secure` is correct. It must still be *absent* here
    // rather than present-but-ignored, or a developer's browser would silently
    // stop keeping the cookie and the failure would look like a login bug.
    vi.stubEnv("NODE_ENV", "development");

    expect(buildSessionCookieOptions().secure).toBe(false);
    expect(serialiseSessionCookie(TOKEN)).not.toContain("Secure");
  });

  it("sets Secure in production", () => {
    vi.stubEnv("NODE_ENV", "production");

    expect(buildSessionCookieOptions().secure).toBe(true);
    expect(serialiseSessionCookie(TOKEN)).toContain("Secure");
  });

  it("treats any environment it does not recognise as production", () => {
    // The failure mode of guessing wrong must be "a cookie the browser drops
    // over http", never "a session token sent in the clear". So the allowlist of
    // insecure environments is exactly the two local ones and nothing else.
    for (const environment of ["production", "staging", "ci", "preview"]) {
      vi.stubEnv("NODE_ENV", environment);

      expect(buildSessionCookieOptions().secure).toBe(true);
    }

    for (const environment of ["development", "test"]) {
      vi.stubEnv("NODE_ENV", environment);

      expect(buildSessionCookieOptions().secure).toBe(false);
    }
  });
});

describe("serialiseClearedSessionCookie", () => {
  it("expires immediately so the browser drops it", () => {
    const header = serialiseClearedSessionCookie();

    expect(header).toContain("Max-Age=0");
    expect(header).toContain("HttpOnly");
  });

  it("keeps the same name, path, and flags as a live cookie", () => {
    // A mismatch here would leave the browser holding the original cookie: a
    // logout that clears `organiser_session` under a different name clears
    // nothing.
    const live = serialiseSessionCookie(TOKEN);
    const cleared = serialiseClearedSessionCookie();

    for (const attribute of ["HttpOnly", "SameSite=Lax", "Path=/"]) {
      expect(cleared).toContain(attribute);
      expect(live).toContain(attribute);
    }

    expect(cleared.startsWith(`${ORGANISER_SESSION_COOKIE}=`)).toBe(true);
  });
});

describe("readSessionCookie", () => {
  it("finds the token among other cookies", () => {
    const request = cookieHeader(
      `theme=dark; ${ORGANISER_SESSION_COOKIE}=${TOKEN}; analytics=off`,
    );

    expect(readSessionCookie(request)).toBe(TOKEN);
  });

  it("tolerates whitespace around the pair", () => {
    expect(readSessionCookie(cookieHeader(`  ${ORGANISER_SESSION_COOKIE} = ${TOKEN} `))).toBe(
      TOKEN,
    );
  });

  it("returns null when the header is absent", () => {
    expect(readSessionCookie(new Request("http://localhost/"))).toBeNull();
  });

  it("returns null when the header is empty", () => {
    expect(readSessionCookie(cookieHeader(""))).toBeNull();
  });

  it("returns null when the cookie is present but empty", () => {
    expect(readSessionCookie(cookieHeader(`${ORGANISER_SESSION_COOKIE}=`))).toBeNull();
  });

  it("returns null when only other cookies are present", () => {
    expect(readSessionCookie(cookieHeader("theme=dark; analytics=off"))).toBeNull();
  });

  it("does not match a cookie whose name merely ends with ours", () => {
    // A substring match would let a client set `x_organiser_session` and be
    // authenticated by it.
    expect(readSessionCookie(cookieHeader(`x_${ORGANISER_SESSION_COOKIE}=${TOKEN}`))).toBeNull();
  });

  it("ignores a pair with no '=' at all", () => {
    expect(readSessionCookie(cookieHeader(`broken; ${ORGANISER_SESSION_COOKIE}=${TOKEN}`))).toBe(
      TOKEN,
    );
  });

  it("strips surrounding double quotes", () => {
    expect(readSessionCookie(cookieHeader(`${ORGANISER_SESSION_COOKIE}="${TOKEN}"`))).toBe(TOKEN);
  });

  it("percent-decodes the value", () => {
    // base64url needs no escaping, but a proxy that rewrites a cookie can leave a
    // stray '%', and comparing that verbatim against the stored hash would just
    // fail a legitimate session.
    expect(readSessionCookie(cookieHeader(`${ORGANISER_SESSION_COOKIE}=a%2Db`))).toBe("a-b");
  });

  it("returns the raw value when it is not valid percent-encoding", () => {
    expect(readSessionCookie(cookieHeader(`${ORGANISER_SESSION_COOKIE}=100%`))).toBe("100%");
  });

  it("stops at the first '=' so a token containing '=' survives", () => {
    expect(readSessionCookie(cookieHeader(`${ORGANISER_SESSION_COOKIE}=ab=cd`))).toBe("ab=cd");
  });

  it("round-trips a token produced by serialiseSessionCookie", () => {
    const header = serialiseSessionCookie(TOKEN);
    const value = header.split(";")[0]!;

    expect(readSessionCookie(cookieHeader(value))).toBe(TOKEN);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `POST /api/v1/auth/login` and `POST /api/v1/auth/logout`.
 *
 * These are contract additions rather than PRD §12 endpoints (see the routes'
 * own doc comments), so the tests take the wire format as given: `200` with the
 * organiser's own `id` and `email`, `204` from logout, and the token in the
 * `Set-Cookie` header only.
 *
 * The three things proven here are the ones a controller-free handler can get
 * wrong: that the token never appears in a response body, that the cookie keeps
 * its security attributes, and that a rejected login is indistinguishable from
 * any other rejected login.
 */

const ORGANISER_ID = "11111111-1111-1111-1111-111111111111";
const SESSION_TOKEN = "kR8vQm2ZxJ5tP1nW7yH3sLbA6cD9fE0gU4iO2pQ8rS1uV3wX6yZ7aB5cD0eF1gH";
const PASSWORD = "correct horse battery staple";

const { getAuthService, login, logout } = vi.hoisted(() => ({
  getAuthService: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
}));

vi.mock("@/server/db/container", () => ({ getAuthService }));

import { POST as loginPost } from "@/app/api/v1/auth/login/route";
import { POST as logoutPost } from "@/app/api/v1/auth/logout/route";
import { UnauthenticatedError } from "@/domain/errors";
import { ORGANISER_SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from "@/server/auth/session-cookie";

function postJson(url: string, body: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function postWithCookie(token: string | null): Request {
  return new Request("http://localhost/api/v1/auth/logout", {
    method: "POST",
    ...(token === null ? {} : { headers: { cookie: `${ORGANISER_SESSION_COOKIE}=${token}` } }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthService.mockReturnValue({ login, logout });
  login.mockResolvedValue({
    organiserId: ORGANISER_ID,
    email: "organiser@example.test",
    sessionToken: SESSION_TOKEN,
    expiresAt: new Date("2026-10-03T12:00:00Z"),
  });
  logout.mockResolvedValue(undefined);
});

describe("POST /api/v1/auth/login on success", () => {
  it("answers 200 with the organiser's own id and email", async () => {
    const response = await loginPost(
      postJson("/api/v1/auth/login", { email: "organiser@example.test", password: PASSWORD }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: ORGANISER_ID,
      email: "organiser@example.test",
    });
  });

  it("sets the session cookie", async () => {
    const response = await loginPost(
      postJson("/api/v1/auth/login", { email: "organiser@example.test", password: PASSWORD }),
    );

    expect(response.headers.get("set-cookie")).toContain(
      `${ORGANISER_SESSION_COOKIE}=${SESSION_TOKEN}`,
    );
  });

  it("never puts the token in the response body", async () => {
    // The cookie is the only channel. A token echoed in JSON ends up in client
    // logs, error reporters, and `JSON.stringify` of a cached response.
    const response = await loginPost(
      postJson("/api/v1/auth/login", { email: "organiser@example.test", password: PASSWORD }),
    );
    const text = await response.text();

    expect(text).not.toContain(SESSION_TOKEN);
  });

  it("sends a cookie that cannot be read by page script", async () => {
    const response = await loginPost(
      postJson("/api/v1/auth/login", { email: "organiser@example.test", password: PASSWORD }),
    );
    const cookie = response.headers.get("set-cookie") ?? "";

    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${SESSION_MAX_AGE_SECONDS}`);
  });

  it("does not cache the response", async () => {
    // A shared cache replaying a Set-Cookie to a second person is a session leak.
    const response = await loginPost(
      postJson("/api/v1/auth/login", { email: "organiser@example.test", password: PASSWORD }),
    );

    expect(response.headers.get("cache-control")).toMatch(/no-store/);
  });

  it("trims the email but preserves the password exactly", async () => {
    await loginPost(
      postJson("/api/v1/auth/login", {
        email: "  organiser@example.test  ",
        password: "  spaced  ",
      }),
    );

    // The asymmetry is deliberate: whitespace around a typed address is always
    // accidental, while spaces inside a password are legitimate characters.
    expect(login).toHaveBeenCalledWith("organiser@example.test", "  spaced  ");
  });
});

describe("POST /api/v1/auth/login on rejection", () => {
  const INVALID = "Email or password is incorrect.";

  it("answers 403 with code unauthenticated for bad credentials", async () => {
    login.mockRejectedValue(new UnauthenticatedError(INVALID));

    const response = await loginPost(
      postJson("/api/v1/auth/login", { email: "organiser@example.test", password: "wrong" }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "unauthenticated", message: INVALID },
    });
  });

  it("sets no cookie on a rejected login", async () => {
    // Otherwise a failed attempt would install a session cookie worth clearing.
    login.mockRejectedValue(new UnauthenticatedError(INVALID));

    const response = await loginPost(
      postJson("/api/v1/auth/login", { email: "organiser@example.test", password: "wrong" }),
    );

    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("returns the same status and message whatever the reason", async () => {
    // The service already collapses unknown-email, wrong-password, and
    // provider-only-account into one error; this pins the wire format on top of
    // that, so a change at either layer cannot leak through the other.
    const responses: string[] = [];

    for (const credentials of [
      { email: "organiser@example.test", password: "wrong" },
      { email: "nobody@example.test", password: PASSWORD },
      { email: "other@example.test", password: "also-wrong" },
    ]) {
      login.mockRejectedValue(new UnauthenticatedError(INVALID));
      const response = await loginPost(postJson("/api/v1/auth/login", credentials));

      expect(response.status).toBe(403);
      responses.push(await response.text());
    }

    expect(new Set(responses).size).toBe(1);
  });

  it("turns an unexpected failure into a generic 500", async () => {
    // A database or driver error must not reach the client: it would disclose
    // schema and infrastructure.
    login.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.4:5432"));

    const response = await loginPost(
      postJson("/api/v1/auth/login", { email: "organiser@example.test", password: PASSWORD }),
    );

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("ECONNREFUSED");
    expect(text).not.toContain("5432");
  });
});

describe("POST /api/v1/auth/login validation", () => {
  it("answers 400 for a malformed JSON body", async () => {
    const response = await loginPost(postJson("/api/v1/auth/login", "{not json"));

    expect(response.status).toBe(400);
    expect(login).not.toHaveBeenCalled();
  });

  it.each([
    ["a body that is not an object", "nope"],
    ["a null body", null],
    ["an array body", []],
  ])("answers 400 for %s", async (_label, body) => {
    const response = await loginPost(postJson("/api/v1/auth/login", body));

    expect(response.status).toBe(400);
    expect(login).not.toHaveBeenCalled();
  });

  it("reports every missing credential at once", async () => {
    const response = await loginPost(postJson("/api/v1/auth/login", {}));

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; fields: Record<string, string[]> };
    };

    expect(body.error.code).toBe("validation_failed");
    expect(Object.keys(body.error.fields).sort()).toEqual(["email", "password"]);
  });

  it.each([
    ["email", { password: PASSWORD }],
    ["password", { email: "organiser@example.test" }],
  ])("answers 400 when only %s is missing", async (field, body) => {
    const response = await loginPost(postJson("/api/v1/auth/login", body));

    expect(response.status).toBe(400);
    expect((await response.json()) as { error: { fields: Record<string, string[]> } }).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ fields: expect.objectContaining({ [field]: expect.any(Array) }) }),
      }),
    );
    expect(login).not.toHaveBeenCalled();
  });

  it.each([
    ["blank", "   "],
    ["empty", ""],
  ])("answers 400 for a %s password rather than hashing it", async (_label, password) => {
    // An empty password is a client bug, and sending it to scrypt would be work
    // spent to reach the same 403.
    const response = await loginPost(
      postJson("/api/v1/auth/login", { email: "organiser@example.test", password }),
    );

    expect(response.status).toBe(400);
    expect(login).not.toHaveBeenCalled();
  });

  it.each([
    ["a number", 42],
    ["null", null],
    ["an object", {}],
  ])("answers 400 when the email is %s", async (_label, email) => {
    const response = await loginPost(
      postJson("/api/v1/auth/login", { email, password: PASSWORD }),
    );

    expect(response.status).toBe(400);
    expect(login).not.toHaveBeenCalled();
  });

  it("answers 400 for an over-long email", async () => {
    // RFC 5321 caps a forward-path address at 320 characters, so anything longer
    // is not an address.
    const response = await loginPost(
      postJson("/api/v1/auth/login", { email: `${"e".repeat(321)}@example.test`, password: PASSWORD }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()) as { error: { fields: Record<string, string[]> } }).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          fields: expect.objectContaining({
            email: [expect.stringContaining("320")],
          }),
        }),
      }),
    );
    expect(login).not.toHaveBeenCalled();
  });

  it("answers 400 for an over-long password", async () => {
    // The bound is on the request, not on what a password may be: scrypt's cost
    // scales with input length, so an unbounded field is a cheap way to make the
    // server do memory-hard work.
    const response = await loginPost(
      postJson("/api/v1/auth/login", {
        email: "organiser@example.test",
        password: "p".repeat(1_025),
      }),
    );

    expect(response.status).toBe(400);
    expect(login).not.toHaveBeenCalled();
  });

  it("rejects fields the endpoint does not define", async () => {
    // An unexpected field is a client bug worth reporting; silently ignoring it
    // hides a typo'd `username` from someone who believes they logged in.
    const response = await loginPost(
      postJson("/api/v1/auth/login", {
        email: "organiser@example.test",
        password: PASSWORD,
        role: "admin",
      }),
    );

    expect(response.status).toBe(400);
    expect(login).not.toHaveBeenCalled();
  });

  it("accepts a 320-character email and a 1024-character password", async () => {
    // Both bounds are inclusive, so the maximum is a valid submission rather
    // than the first rejected one. A CHECK or a `>` where `>=` belongs would pass
    // every rejection case above and still break a real organiser.
    const response = await loginPost(
      postJson("/api/v1/auth/login", {
        email: `${"e".repeat(320 - "@example.test".length)}@example.test`,
        password: "p".repeat(1_024),
      }),
    );

    expect(response.status).toBe(200);
  });
});

describe("POST /api/v1/auth/logout", () => {
  it("answers 204 with no body", async () => {
    const response = await logoutPost(postWithCookie(SESSION_TOKEN));

    expect(response.status).toBe(204);
    expect(logout).toHaveBeenCalledWith(SESSION_TOKEN);
  });

  it("clears the cookie", async () => {
    // The row deletion alone would leave the browser re-sending a token that no
    // longer resolves, so the cookie is overwritten either way.
    const response = await logoutPost(postWithCookie(SESSION_TOKEN));
    const cookie = response.headers.get("set-cookie") ?? "";

    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("HttpOnly");
    expect(cookie.startsWith(`${ORGANISER_SESSION_COOKIE}=`)).toBe(true);
  });

  it.each([
    ["no cookie", null],
    ["an unknown cookie", "not-a-real-token"],
  ])("answers 204 for %s", async (_label, token) => {
    // Idempotent: a client retrying after a timeout must not be told this failed.
    const response = await logoutPost(postWithCookie(token));

    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("passes null through when there is no cookie", async () => {
    await logoutPost(postWithCookie(null));

    expect(logout).toHaveBeenCalledWith(null);
  });

  it("does not clear the cookie when the session could not be deleted", async () => {
    // The inverse of the rule above, and a deliberate choice. If the delete
    // failed, the row is still there and the token is still valid server-side;
    // dropping the cookie would tell the user they are signed out while a copied
    // token keeps working. Reporting the failure is the honest answer.
    logout.mockRejectedValue(new Error("database unavailable"));

    const response = await logoutPost(postWithCookie(SESSION_TOKEN));

    expect(response.status).toBe(500);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("does not disclose the failure reason", async () => {
    logout.mockRejectedValue(new Error("password_hash for organiser 1 could not be read"));

    const response = await logoutPost(postWithCookie(SESSION_TOKEN));
    const text = await response.text();

    expect(text).not.toContain("password_hash");
    expect(text).not.toContain("organiser 1");
  });
});

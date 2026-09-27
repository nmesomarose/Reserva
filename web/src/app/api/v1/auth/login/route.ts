import { NextResponse } from "next/server";

import { ValidationError, type FieldIssues } from "@/domain/errors";

import { serialiseSessionCookie } from "@/server/auth/session-cookie";
import { getAuthService } from "@/server/db/container";
import { toErrorResponse } from "@/server/http/error-response";
import { readJsonObject } from "@/server/validation/validation";

/**
 * `POST /api/v1/auth/login` — exchange email + password for a session cookie.
 *
 * NOT IN PRD §12's endpoint table, which annotates organiser routes "auth:
 * Organiser" without ever defining how a caller becomes one. The mechanism was
 * explicitly deferred (§3, §19) and was decided on 2026-09-26 as email + password
 * with a server-side session; a session cannot be issued without an endpoint to
 * issue it from, so this route is a necessary consequence of that decision rather
 * than an added feature. The path is the conventional one and is reported as a
 * contract addition.
 *
 * Request fields: `email`, `password`. Response `200`: the organiser's own id and
 * email — never the token. The token goes out only in the `Set-Cookie`, so a
 * client cannot read it out of the JSON body and log it alongside its response.
 *
 * Every rejection is `403` with the same message, whatever the cause (see
 * `AuthService.login`): an endpoint that distinguishes "no such organiser" from
 * "wrong password" is an account-existence oracle.
 */

/** 320 is RFC 5321's maximum total length of a forward-path address. */
const MAX_EMAIL_LENGTH = 320;

/**
 * Upper bound on a submitted password.
 *
 * Not a product limit on what a password may *be* — a bound on what a request may
 * carry. scrypt's cost scales with input length, so an unbounded body field is a
 * cheap way to make the server do memory-hard work; 1024 characters is far beyond
 * any human-chosen password.
 */
const MAX_PASSWORD_LENGTH = 1024;

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = requireLoginBody(await readJsonObject(request));

    const organiser = await getAuthService().login(body.email, body.password);

    return NextResponse.json(
      { id: organiser.organiserId, email: organiser.email },
      {
        status: 200,
        headers: {
          "set-cookie": serialiseSessionCookie(organiser.sessionToken),
          // The response body identifies the caller and the response header
          // carries a live session, so it must not be stored. `POST` is not
          // cacheable by default, but an explicit `no-store` is what stops a
          // misconfigured proxy or CDN from treating this as a reusable
          // response for the next request that happens to carry the same cookie.
          "cache-control": "no-store",
        },
      },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * Parse the two credentials, and nothing else.
 *
 * Bounded above, and reported as field issues like every other parser in the API.
 *
 * Two asymmetries on purpose:
 *
 *   - the email is trimmed, because whitespace around an address typed into a form
 *     is always accidental and would otherwise be a silent login failure;
 *   - the password is NOT trimmed, because leading and trailing spaces are legal
 *     password characters and stripping them would lock out anyone whose password
 *     genuinely has one.
 *
 * A blank string is reported as required for both: an empty password is a client
 * bug, and passing it to scrypt would be work spent to reach the same `403`.
 */
function requireLoginBody(body: unknown): { readonly email: string; readonly password: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("Request body must be a JSON object.", {
      body: ['Send a JSON object with "email" and "password".'],
    });
  }

  const object = body as Record<string, unknown>;
  const issues: Record<string, string[]> = {};

  for (const key of Object.keys(object)) {
    if (key !== "email" && key !== "password") {
      (issues[key] ??= []).push("Not a recognised field for this request.");
    }
  }

  const email = readCredential(object, "email", MAX_EMAIL_LENGTH, true, issues);
  const password = readCredential(object, "password", MAX_PASSWORD_LENGTH, false, issues);

  if (Object.keys(issues).length > 0) {
    throw new ValidationError("The request body failed validation.", issues as FieldIssues);
  }

  return { email, password };
}

function readCredential(
  body: Record<string, unknown>,
  field: "email" | "password",
  maxLength: number,
  trim: boolean,
  issues: Record<string, string[]>,
): string {
  const raw = body[field];

  if (typeof raw !== "string") {
    (issues[field] ??= []).push("Required, and must be a string.");
    return "";
  }

  const value = trim ? raw.trim() : raw;

  if (value.trim() === "") {
    (issues[field] ??= []).push("Required, and cannot be blank.");
    return "";
  }

  if (value.length > maxLength) {
    (issues[field] ??= []).push(`Must be at most ${maxLength} characters.`);
  }

  return value;
}
